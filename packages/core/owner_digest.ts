// The owner's daily self-approval digest.
//
// A self-approval is the one place maker-checker steps aside, so the owner is
// told about every one: once a day, each company of a customer lists the
// self-approvals of the last 24 hours, and any role taken away in the 24 hours
// before one of them (taking away the only other approver is how
// self-approval would be reached on purpose). The digest is an
// owner_notification row, shown on the owner's Home with each line openable;
// it is emailed to the owners only when the company has email connected
// (through the outbox). Demo and suspended customers are skipped, and a day's
// digest is made once. It also lists what ERP setup approved for the owner in
// support mode before go-live (flow "setup", migration 0066), marked
// "(approved during setup)" with the operator and support session.

import { type Client, type Scope, q } from "./db.ts";
import { isConnected, queueEmail } from "./messaging.ts";

export type DigestItem = {
  flow: "approval" | "count" | "writeoff" | "debit_memo" | "time_off" | "release" | "gate" | "setup";
  id: string; at: string; decision: string; by: string | null; title: string; detail: string;
  amountMinor: string | null; link: string | null; screen: string | null;
};
export type DigestRemoval = { at: string; person: string | null; role: string; kind: string; by: string | null; companyWide: boolean };

const SUBJECT_WORD: Record<string, string> = {
  invoice: "Bill", vendor: "New vendor", vendor_bank_account: "Vendor bank details", payment_run: "Payment run",
  payroll_run: "Payroll run", employee: "New hire", employee_change: "Pay change", journal_entry: "Journal entry", fiscal_period: "Accounting period",
};
const ROLE_WORD: Record<string, string> = { owner: "owner", controller: "controller", approver: "approver", ap_clerk: "A/P clerk", viewer: "viewer",
  store_manager: "store manager", hr: "HR", ar_clerk: "A/R clerk", web_admin: "web admin" };
export const roleWord = (r: string) => ROLE_WORD[r] ?? r.replace(/_/g, " ");
const usd = (minor: string | null) => {
  if (minor == null) return "";
  const n = BigInt(minor); const neg = n < 0n; const v = neg ? -n : n;
  return `${neg ? "-" : ""}$${(v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(v % 100n).toString().padStart(2, "0")}`;
};

/** Every self-approval in the company in (from, to]. One query per flow, each scoped to the company. */
export async function selfApprovals(c: Client, entityId: string, from: string, to: string): Promise<DigestItem[]> {
  const out: DigestItem[] = [];
  const eng = await q<{ id: string; at: string; decision: string; by: string | null; subject_type: string; subject_id: string; amount_minor: string | null; role: string; vendor_id: string | null }>(c, `
    select r.id, to_char(s.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, s.decision, u.name by, r.subject_type, r.subject_id, r.amount_minor::text, s.required_role role,
           case when r.subject_type = 'vendor_bank_account' then (select b.vendor_id from vendor_bank_account b where b.id = r.subject_id) end vendor_id
      from approval_step s join approval_request r on r.id = s.request_id left join app_user u on u.id = s.actor_id
     where r.entity_id = $1 and s.self_approved and s.decided_at > $2::timestamptz and s.decided_at <= $3::timestamptz
     order by s.decided_at`, [entityId, from, to]);
  for (const e of eng) {
    const link = e.subject_type === "invoice" ? `bill:${e.subject_id}` : e.subject_type === "payroll_run" ? `payrun:${e.subject_id}`
      : e.subject_type === "payment_run" ? `payment:${e.subject_id}` : e.subject_type === "employee" ? `person:${e.subject_id}`
      : e.subject_type === "vendor" ? `vendor:${e.subject_id}` : e.vendor_id ? `vendor:${e.vendor_id}` : null;
    out.push({ flow: "approval", id: e.id, at: e.at, decision: e.decision, by: e.by, title: SUBJECT_WORD[e.subject_type] ?? e.subject_type.replace(/_/g, " "),
      detail: `${e.decision} as ${roleWord(e.role)}`, amountMinor: e.amount_minor, link, screen: link ? null : "approvals" });
  }
  // 0066: what ERP setup approved for the owner in support mode before go-live (one line per request)
  const setup = await q<{ id: string; at: string; decision: string; by: string | null; subject_type: string; subject_id: string; amount_minor: string | null;
                          setup_by: string | null; setup_session: string; setup_reason: string | null }>(c, `
    select distinct on (r.id) r.id, to_char(s.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, s.decision, u.name by,
           r.subject_type, r.subject_id, r.amount_minor::text, s.setup_by, s.setup_session, s.setup_reason
      from approval_step s join approval_request r on r.id = s.request_id left join app_user u on u.id = s.actor_id
     where r.entity_id = $1 and s.setup_session is not null and s.decided_at > $2::timestamptz and s.decided_at <= $3::timestamptz
     order by r.id, s.decided_at desc`, [entityId, from, to]);
  for (const e of setup) {
    const link = e.subject_type === "employee" ? `person:${e.subject_id}` : e.subject_type === "vendor" ? `vendor:${e.subject_id}`
      : e.subject_type === "journal_entry" ? `entry:${e.subject_id}` : e.subject_type === "fiscal_period" ? `period:${e.subject_id}` : null;
    const words = setupWords(e.decision, e.setup_by, e.setup_session);
    out.push({ flow: "setup", id: e.id, at: e.at, decision: e.decision, by: e.setup_by ? `ERP setup (${e.setup_by})` : "ERP setup",
      title: SUBJECT_WORD[e.subject_type] ?? e.subject_type.replace(/_/g, " "),
      detail: `${words} (approved during setup)${e.setup_reason ? `; support reason: ${e.setup_reason}` : ""}`, amountMinor: e.amount_minor, link, screen: link ? null : "approvals" });
  }
  const counts = await q<{ id: string; at: string; status: string; by: string | null; number: string; variance_minor: string | null }>(c, `
    select ct.id, to_char(ct.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, ct.status, u.name by, ct.number, ct.variance_minor::text
      from inv_count ct left join app_user u on u.id = ct.decided_by
     where ct.entity_id = $1 and ct.self_approved and ct.decided_at > $2::timestamptz and ct.decided_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of counts) out.push({ flow: "count", id: x.id, at: x.at, decision: x.status, by: x.by, title: `Stock count ${x.number}`,
    detail: `${x.status}${x.variance_minor != null && x.status === "approved" ? `, variance ${usd(x.variance_minor)}` : ""}`, amountMinor: x.variance_minor, link: null, screen: "inventory" });
  const wos = await q<{ id: string; at: string; status: string; by: string | null; amount_minor: string; customer: string | null }>(c, `
    select w.id, to_char(w.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, w.status, u.name by, w.amount_minor::text, cu.name customer
      from ar_writeoff w left join app_user u on u.id = w.decided_by left join customer cu on cu.id = w.customer_id
     where w.entity_id = $1 and w.self_approved and w.decided_at > $2::timestamptz and w.decided_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of wos) out.push({ flow: "writeoff", id: x.id, at: x.at, decision: x.status === "posted" ? "approved" : x.status, by: x.by,
    title: `A/R write-off${x.customer ? ` · ${x.customer}` : ""}`, detail: x.status === "posted" ? "approved and posted" : x.status, amountMinor: x.amount_minor, link: null, screen: "ar" });
  const memos = await q<{ id: string; at: string; status: string; by: string | null; number: string; amount_minor: string; vendor: string | null }>(c, `
    select m.id, to_char(m.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, m.status, u.name by, m.number, m.amount_minor::text, coalesce(v.dba, v.legal_name) vendor
      from vendor_debit_memo m left join app_user u on u.id = m.decided_by left join vendor v on v.id = m.vendor_id
     where m.entity_id = $1 and m.self_approved and m.decided_at > $2::timestamptz and m.decided_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of memos) out.push({ flow: "debit_memo", id: x.id, at: x.at, decision: x.status === "rejected" ? "rejected" : "approved", by: x.by,
    title: `Debit memo ${x.number}${x.vendor ? ` · ${x.vendor}` : ""}`, detail: x.status === "rejected" ? "turned down" : "approved", amountMinor: x.amount_minor, link: null, screen: "memos" });
  const leave = await q<{ id: string; at: string; status: string; by: string | null; who: string; total_hours: string; starts_on: string; ends_on: string }>(c, `
    select r.id, to_char(r.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, r.status, u.name by, e.first_name || ' ' || e.last_name who, r.total_hours::text, r.starts_on::text, r.ends_on::text
      from leave_request r join employee e on e.id = r.employee_id left join app_user u on u.id = r.decided_by
     where r.entity_id = $1 and r.self_approved and r.decided_at > $2::timestamptz and r.decided_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of leave) out.push({ flow: "time_off", id: x.id, at: x.at, decision: x.status, by: x.by, title: `Time off · ${x.who}`,
    detail: `${x.status}, ${Number(x.total_hours)} h, ${x.starts_on === x.ends_on ? x.starts_on : `${x.starts_on} to ${x.ends_on}`}`, amountMinor: null, link: null, screen: "timeoff" });
  // 0064: a run released by its own builder, and a bill let through the gates by whoever entered it
  const pay = await q<{ id: string; at: string; by: string | null; pay_date: string; total: string }>(c, `
    select pr.id, to_char(pr.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, u.name by, pr.pay_date::text,
           (select coalesce(sum(p.amount_minor), 0) from payment p where p.payment_run_id = pr.id)::text total
      from payment_run pr left join app_user u on u.id = pr.released_by
     where pr.entity_id = $1 and pr.self_released and pr.released_at > $2::timestamptz and pr.released_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of pay) out.push({ flow: "release", id: x.id, at: x.at, decision: "released", by: x.by, title: `Payment run released · pay date ${x.pay_date}`,
    detail: "released by the person who built it", amountMinor: x.total, link: `payment:${x.id}`, screen: null });
  const prl = await q<{ id: string; at: string; by: string | null; pay_date: string; net: string }>(c, `
    select pr.id, to_char(pr.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, u.name by, pp.pay_date::text, pr.net_minor::text net
      from payroll_run pr join pay_period pp on pp.id = pr.pay_period_id left join app_user u on u.id = pr.released_by
     where pr.entity_id = $1 and pr.self_released and pr.released_at > $2::timestamptz and pr.released_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of prl) out.push({ flow: "release", id: x.id, at: x.at, decision: "released", by: x.by, title: `Payroll released · pay date ${x.pay_date}`,
    detail: "released by the person who built it", amountMinor: x.net, link: `payrun:${x.id}`, screen: null });
  const gates = await q<{ id: string; at: string; by: string | null; vendor: string; reference: string | null; total: string }>(c, `
    select i.id, to_char(i.accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, u.name by, coalesce(v.dba, v.legal_name) vendor, i.reference, i.total_minor::text total
      from invoice i join vendor v on v.id = i.vendor_id left join app_user u on u.id = i.accepted_by
     where i.entity_id = $1 and i.self_accepted and i.accepted_at > $2::timestamptz and i.accepted_at <= $3::timestamptz`, [entityId, from, to]);
  for (const x of gates) out.push({ flow: "gate", id: x.id, at: x.at, decision: "approved", by: x.by, title: `Bill let through the gates · ${x.vendor}${x.reference ? ` ${x.reference}` : ""}`,
    detail: "let through by the person who entered it", amountMinor: x.total, link: `bill:${x.id}`, screen: null });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** "approved by ERP setup (opsy), support session <id>", as the history and the digest say it. */
export function setupWords(decision: string, operator: string | null, session: string | null): string {
  const verb = decision === "rejected" ? "rejected" : "approved";
  if (session === "install-token") return `${verb} by ERP setup (install-wide API token)`;
  return `${verb} by ERP setup (${operator ?? "operator"})${session ? `, support session ${session}` : ""}`;
}

/** Roles taken away in this company (or client-wide) in the 24 hours before any of these instants. */
export async function removalsBefore(c: Client, entityId: string, instants: string[]): Promise<DigestRemoval[]> {
  if (!instants.length) return [];
  return q<DigestRemoval>(c, `
    select to_char(rr.removed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at, rr.user_name person, rr.role, rr.kind, rr.by_label by, (rr.entity_id is null) "companyWide"
      from role_removal rr join entity e on e.id = $1 and e.tenant_id = rr.tenant_id
     where (rr.entity_id = $1 or rr.entity_id is null)
       and exists (select 1 from unnest($2::timestamptz[]) s(at) where rr.removed_at between s.at - interval '24 hours' and s.at)
     order by rr.removed_at /* unscoped: the company's client's removals, this company's or client-wide */`, [entityId, instants]);
}

/** An instant as the store's clock shows it ("Nov 11, 2026, 9:04 AM EST"). */
const localAt = (iso: string, tz: string) => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)); }
  catch { return `${iso.slice(0, 16).replace("T", " ")} UTC`; }
};

export function digestText(company: string, items: DigestItem[], removals: DigestRemoval[], tz = "UTC"): { title: string; body: string } {
  const nSetup = items.filter((i) => i.flow === "setup").length, nSelf = items.length - nSetup;
  const title = [nSelf ? `${nSelf} self-approval${nSelf === 1 ? "" : "s"}` : null, nSetup ? `${nSetup} approved during setup` : null].filter(Boolean).join(" and ")
    + ` in ${company} in the last 24 hours`;
  const lines = [
    nSelf ? `${company}: what was approved by the person who asked for it, because nobody else in the company could.` : `${company}: what ERP setup approved for you before go-live.`,
    nSelf && nSetup ? "Lines marked (approved during setup) were approved by ERP setup in support mode, before go-live." : null,
    "",
    ...items.map((i) => `- ${i.title}: ${i.detail}${i.amountMinor != null && i.flow !== "count" ? `, ${usd(i.amountMinor)}` : ""}, by ${i.by ?? "someone"} at ${localAt(i.at, tz)}`),
  ].filter((x): x is string => x !== null);
  if (removals.length) {
    lines.push("", "Roles taken away in the 24 hours before a self-approval:");
    for (const r of removals) lines.push(`- ${r.person ?? "someone"} lost ${roleWord(r.role)}${r.companyWide ? " (every company)" : ""}${r.kind === "person_inactive" ? " (no longer active)" : ""} at ${localAt(r.at, tz)}${r.by ? `, by ${r.by}` : ""}`);
  }
  lines.push("", "Each one is on Home in the ERP, under Self-approvals. If any of these was not you, change your password and look at Setup, People.");
  return { title, body: lines.join("\n") };
}

/**
 * Make one company's digest for the 24 hours up to `at`. Nothing happens when
 * there was no self-approval, or today's digest is already made. Emailed to the
 * company's owners only when email is connected (queued through the outbox).
 */
export async function makeDigest(c: Client, scope: Scope, at: Date, since: Date | null = null): Promise<{ made: boolean; items: number; removals: number; emailed: boolean; note: string }> {
  const to = at.toISOString();
  // The window starts where this company's last digest ended, so nothing falls between two digests (a run
  // that comes a little later each day, a second run the same day, a server that was down); with no digest
  // yet, where the job last ran (at most 7 days back), else the last 24 hours.
  const last = (await q<{ e: string | null }>(c, `
    select to_char(max(window_end) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') e
      from owner_notification where entity_id = $1 and kind = 'self_approval_digest'`, [scope.entityId]))[0]?.e;
  const floor = at.getTime() - 7 * 24 * 3600_000;
  const from = last ?? new Date(Math.max(floor, since ? since.getTime() : at.getTime() - 24 * 3600_000)).toISOString();
  if (from >= to) return { made: false, items: 0, removals: 0, emailed: false, note: "nothing new since the last digest" };
  const items = await selfApprovals(c, scope.entityId, from, to);
  if (!items.length) return { made: false, items: 0, removals: 0, emailed: false, note: "no self-approvals" };
  // roles removed matter before a self-approval; a setup approval is ERP setup's, not reached by removing anyone
  const selfOnly = items.filter((i) => i.flow !== "setup");
  const removals = await removalsBefore(c, scope.entityId, selfOnly.map((i) => i.at));
  const co = (await q<{ name: string; tz: string }>(c, `select name, business_tz(id) tz from entity where id = $1 /* unscoped: the company itself */`, [scope.entityId]))[0];
  const { title, body } = digestText(co?.name ?? "Your company", items, removals, co?.tz ?? "UTC");
  const row = (await q<{ id: string }>(c, `
    insert into owner_notification (tenant_id, entity_id, kind, for_day, window_start, window_end, title, body, items, removals)
    values ($1, $2, 'self_approval_digest', ($4::timestamptz at time zone business_tz($2))::date, $3, $4, $5, $6, $7, $8)
    on conflict (entity_id, kind, for_day) do nothing returning id`,
    [scope.tenantId, scope.entityId, from, to, title, body, JSON.stringify(items), JSON.stringify(removals)]))[0];
  // today's is made already: these wait for tomorrow's, whose window starts where today's ended
  if (!row) return { made: false, items: items.length, removals: removals.length, emailed: false, note: "today's digest was already made; these go in the next one" };
  let emailed = false;
  if (await isConnected(c, scope.entityId, "email")) {
    const owners = await q<{ email: string }>(c, `
      select distinct u.email from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = $1
       where g.role = 'owner' and u.status = 'active' and u.email like '%@%'
         and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = e.tenant_id))`, [scope.entityId]);
    if (owners.length) {
      const m = await queueEmail(c, scope.entityId, { to: owners.map((o) => o.email), subject: title, text: body },
        { purpose: "owner_digest", sourceTable: "owner_notification", sourceId: row.id, resendable: true });
      await c.query(`update owner_notification set emailed_message_id = $3 where id = $1 and entity_id = $2`, [row.id, scope.entityId, m.id]);
      emailed = true;
    }
  }
  return { made: true, items: items.length, removals: removals.length, emailed,
    note: `${[selfOnly.length ? `${selfOnly.length} self-approval${selfOnly.length === 1 ? "" : "s"}` : null, items.length > selfOnly.length ? `${items.length - selfOnly.length} approved during setup` : null].filter(Boolean).join(", ")}${removals.length ? `, ${removals.length} role${removals.length === 1 ? "" : "s"} removed before` : ""}${emailed ? ", emailed" : ""}` };
}

/** The companies the digest job walks: customers only (never the demo), not suspended, companies active. */
export async function digestCompanies(c: Client): Promise<{ id: string; tenant_id: string }[]> {
  return q(c, `select e.id, e.tenant_id from entity e join tenant t on t.id = e.tenant_id
                where e.status = 'active' and t.status = 'active' and t.kind <> 'demo'
                order by e.tenant_id, e.name /* unscoped: the scheduler walks every customer's companies */`);
}

/** Recent digests for the owner's Home (newest first). */
export async function recentDigests(c: Client, entityId: string, limit = 10) {
  return q<{ id: string; for_day: string; title: string; body: string; items: DigestItem[]; removals: DigestRemoval[]; created_at: string; emailed: boolean }>(c, `
    select id, for_day::text, title, body, items, removals, created_at::text, (emailed_message_id is not null) emailed
      from owner_notification where entity_id = $1 and kind = 'self_approval_digest' and created_at > now() - interval '14 days'
     order by created_at desc limit $2`, [entityId, limit]);
}
