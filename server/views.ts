// What each screen shows, read straight from the books.
//
// Every function here takes the company it is about and nothing else decides
// the scope: a query that forgets the company fails the guard in db.ts rather
// than quietly showing another client's numbers. Money comes back as whole
// cents in strings, dates as YYYY-MM-DD, so nothing is rounded or shifted a
// day on its way to a phone in another time zone.

import { type Client, q, one } from "../packages/core/db.ts";
import { handlerFor } from "../packages/core/connections.ts";

export type Company = {
  id: string;
  tenantId: string;
  name: string;
  legalName: string;
  tenantName: string;
  vertical: string;
  locationLabel: string;
  profitObjectLabel: string;
};

const secretEnvName = (ref: string): string =>
  "ERP_SECRET_" + ref.replace(/^secret:\/\//i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// ---------------------------------------------------------------- companies

export async function companies(c: Client) {
  return await q<{
    id: string; name: string; legal_name: string; tenant_id: string; tenant_name: string;
    vertical: string; location_label: string; profit_object_label: string;
  }>(c, `
    select e.id, e.name, e.legal_name, t.id as tenant_id, t.name as tenant_name, t.vertical,
           t.location_label, t.profit_object_label
      from entity e join tenant t on t.id = e.tenant_id
     where e.status = 'active'
     order by t.name, e.name /* unscoped: the operator's list of every company it keeps books for */`);
}

export async function loadCompany(c: Client, entityId: string): Promise<Company | null> {
  const rows = await q<{
    id: string; tenant_id: string; name: string; legal_name: string; tenant_name: string;
    vertical: string; location_label: string; profit_object_label: string;
  }>(c, `
    select e.id, e.tenant_id, e.name, e.legal_name, t.name as tenant_name, t.vertical,
           t.location_label, t.profit_object_label
      from entity e join tenant t on t.id = e.tenant_id
     where e.id = $1 and e.status = 'active' /* unscoped: looking up the company itself */`, [entityId]);
  const r = rows[0];
  return r ? {
    id: r.id, tenantId: r.tenant_id, name: r.name, legalName: r.legal_name, tenantName: r.tenant_name,
    vertical: r.vertical, locationLabel: r.location_label, profitObjectLabel: r.profit_object_label,
  } : null;
}

/** The people who can act for this company: its own, plus anyone granted it by name. */
export async function people(c: Client, co: Company) {
  return await q<{ id: string; name: string; email: string; roles: string[] }>(c, `
    select u.id, u.name, u.email,
           coalesce(array_agg(distinct g.role order by g.role) filter (where g.role is not null), '{}') as roles
      from app_user u
      left join role_grant g on g.app_user_id = u.id
                            and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2))
     where u.status = 'active'
       and (u.tenant_id = $2 or exists (select 1 from role_grant g2
                                          where g2.app_user_id = u.id and g2.entity_id = $1))
     group by u.id, u.name, u.email
     order by u.name`, [co.id, co.tenantId]);
}

export async function person(c: Client, co: Company, personId: string) {
  const all = await people(c, co);
  return all.find((p) => p.id === personId) ?? null;
}

// ------------------------------------------------------------------ helpers

const stores = (c: Client, co: Company) => q<{ id: string; code: string; name: string; kind: string }>(c, `
  select id, code, name, kind from profit_object
   where entity_id = $1 and status = 'active'
   order by case kind when 'store' then 0 else 1 end, name`, [co.id]);

export async function formOptions(c: Client, co: Company) {
  const accounts = await q<{ id: string; code: string; name: string; account_type: string }>(c, `
    select ga.id, ga.code, ga.name, ga.account_type
      from gl_account ga
     where ga.tenant_id = $1 and ga.is_postable
       and ga.account_type in ('expense', 'asset')
       and not exists (select 1 from bank_account ba where ba.gl_account_id = ga.id and ba.entity_id = $2)
     order by ga.code /* unscoped: the chart of accounts is shared across the client's companies */`,
    [co.tenantId, co.id]);
  const vendors = await q<{ id: string; name: string; terms_days: number; default_gl_account_id: string | null;
                             default_profit_object_id: string | null; status: string }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, ve.terms_days, ve.default_gl_account_id,
           ve.default_profit_object_id, ve.status
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.entity_id = $1 and ve.status = 'active'
     order by 2`, [co.id]);
  // Anything a bank line with no counterpart could be booked to: every
  // postable account except the company's own cash accounts.
  const bookable = await q<{ id: string; code: string; name: string; account_type: string }>(c, `
    select ga.id, ga.code, ga.name, ga.account_type
      from gl_account ga
     where ga.tenant_id = $1 and ga.is_postable
       and not exists (select 1 from bank_account ba where ba.gl_account_id = ga.id and ba.entity_id = $2)
     order by ga.code /* unscoped: the chart of accounts is shared across the client's companies */`,
    [co.tenantId, co.id]);
  const payGroups = await q(c, `
    select id, name, frequency from pay_group where entity_id = $1 and status = 'active' order by name`, [co.id]);
  const positions = (await q<{ position: string }>(c, `
    select distinct position from employee where entity_id = $1 and position is not null order by 1`, [co.id])).map((r) => r.position);
  const payrollBanks = await q(c, `
    select id, name, purpose, bank_name, account_last4 from bank_account
     where entity_id = $1 and status = 'active' and purpose in ('payroll', 'operating') order by purpose desc, name`, [co.id]);
  const states = (await q<{ state: string }>(c, `
    select distinct state from location where entity_id = $1 and state is not null order by 1`, [co.id])).map((r) => r.state);
  return { accounts, vendors, stores: await stores(c, co), bookable, payGroups, positions, payrollBanks, states };
}

// -------------------------------------------------------------- approvals

type OpenRequest = {
  id: string; subject_type: string; subject_id: string; amount_minor: string | null; created_at: string;
  maker_id: string; maker_name: string; step_seq: number; step_role: string; steps: number;
};

/**
 * What an approval is about. Dates stay YYYY-MM-DD and the page words them,
 * so a phone in another time zone never shows the wrong day.
 */
type Subject = { kind: string; title: string; detail: string; date: string | null; link: string | null; vendor?: string; ref?: string | null;
                 callback?: { phone: string | null; contact: string | null; phoneChangedAt: string | null } };
const usd = (m: string | bigint) => USD.format(Number(m) / 100);

/**
 * When a vendor's phone on file last changed, from any of the client's
 * companies: a vendor is shared across them, and a call-back to a number
 * changed alongside the bank details proves nothing.
 */
async function phoneChangedAt(c: Client, co: Company, vendorId: string): Promise<string | null> {
  const r = await q<{ at: string | null }>(c, `
    select max(ae.at) as at from audit_event ae
     where ae.tenant_id = $1 and ae.table_name = 'vendor' and ae.row_id = $2
       and ae.reason = 'details changed, including the phone on file'
    /* unscoped: a vendor's record is shared across the client's companies */`, [co.tenantId, vendorId]);
  return r[0]?.at ?? null;
}
async function subjectSummary(c: Client, co: Company, type: string, id: string): Promise<Subject> {
  if (type === "invoice") {
    const r = await q<{ vendor: string; reference: string | null; invoice_date: string; stores: string | null }>(c, `
      select coalesce(v.dba, v.legal_name) as vendor, i.reference, i.invoice_date::text,
             (select string_agg(distinct po.name, ', ') from invoice_line il
                join profit_object po on po.id = il.profit_object_id where il.invoice_id = i.id) as stores
        from invoice i join vendor v on v.id = i.vendor_id
       where i.id = $1 and i.entity_id = $2`, [id, co.id]);
    if (r[0]) return { kind: "bill", title: r[0].reference ? `${r[0].vendor} · ${r[0].reference}` : r[0].vendor,
                       vendor: r[0].vendor, ref: r[0].reference, detail: r[0].stores ?? "", date: r[0].invoice_date, link: `bill:${id}` };
  }
  if (type === "payroll_run") {
    const r = await q<{ pay_date: string; n: number }>(c, `
      select pp.pay_date::text, (select count(*) from payroll_line pl where pl.payroll_run_id = pr.id)::int as n
        from payroll_run pr join pay_period pp on pp.id = pr.pay_period_id
       where pr.id = $1 and pr.entity_id = $2`, [id, co.id]);
    if (r[0]) return { kind: "payroll", title: "Payroll", detail: `${r[0].n} employees`, date: r[0].pay_date, link: `payrun:${id}` };
  }
  if (type === "payment_run") {
    const r = await q<{ pay_date: string; method: string; n: number }>(c, `
      select pr.pay_date::text, pr.method, (select count(*) from payment p where p.payment_run_id = pr.id)::int as n
        from payment_run pr where pr.id = $1 and pr.entity_id = $2`, [id, co.id]);
    if (r[0]) return { kind: "payment_run", title: "Payment run", detail: `${r[0].n} bill${r[0].n === 1 ? "" : "s"} by ${r[0].method.toUpperCase()}`,
                       date: r[0].pay_date, link: `payment:${id}` };
  }
  if (type === "employee") {
    const r = await q<{ name: string; position: string | null; pay_type: string; base_rate_minor: string; pay_group: string | null; hired_on: string }>(c, `
      select e.first_name || ' ' || e.last_name as name, e.position, e.pay_type, e.base_rate_minor, pg.name as pay_group, e.hired_on::text
        from employee e left join pay_group pg on pg.id = e.pay_group_id
       where e.id = $1 and e.entity_id = $2`, [id, co.id]);
    if (r[0]) return { kind: "employee", title: `New hire · ${r[0].name}`, date: null, link: `person:${id}`,
      detail: [r[0].position, r[0].pay_group, `${usd(r[0].base_rate_minor)} ${r[0].pay_type === "salary" ? "a year" : "an hour"}`, `starts ${r[0].hired_on}`].filter(Boolean).join(" · ") };
  }
  if (type === "employee_change") {
    const r = await q<{ name: string; employee_id: string; before: Record<string, string>; after: Record<string, string>; old_group: string | null; new_group: string | null }>(c, `
      select e.first_name || ' ' || e.last_name as name, e.id as employee_id, ch.before, ch.after,
             (select pg.name from pay_group pg where pg.id = (ch.before->>'pay_group_id')::uuid) as old_group,
             (select pg.name from pay_group pg where pg.id = (ch.after->>'pay_group_id')::uuid) as new_group
        from employee_change ch join employee e on e.id = ch.employee_id
       where ch.id = $1 and ch.entity_id = $2`, [id, co.id]);
    if (r[0]) {
      const b = r[0].before, a = r[0].after;
      const per = (t: string) => (t === "salary" ? "a year" : "an hour");
      const parts = [];
      if (b.base_rate_minor !== a.base_rate_minor || b.pay_type !== a.pay_type) parts.push(`${usd(b.base_rate_minor)} ${per(b.pay_type)} to ${usd(a.base_rate_minor)} ${per(a.pay_type)}`);
      if (r[0].old_group !== r[0].new_group) parts.push(`${r[0].old_group ?? "no group"} to ${r[0].new_group ?? "no group"}`);
      return { kind: "employee_change", title: `Pay change · ${r[0].name}`, detail: parts.join(" · "), date: null, link: `person:${r[0].employee_id}` };
    }
  }
  if (type === "vendor_bank_account") {
    const r = await q<{ vendor: string; vendor_id: string; bank_name: string | null; routing_last4: string; account_last4: string; contact_phone: string | null; contact_name: string | null }>(c, `
      select coalesce(v.dba, v.legal_name) as vendor, v.id as vendor_id, b.bank_name, b.routing_last4, b.account_last4, v.contact_phone, v.contact_name
        from vendor_bank_account b join vendor v on v.id = b.vendor_id
       where b.id = $1 and b.vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [id, co.id]);
    if (r[0]) return { kind: "vendor_bank", title: `Bank details · ${r[0].vendor}`, date: null, link: `vendor:${r[0].vendor_id}`,
      detail: `${r[0].bank_name ?? "bank"} · routing ••${r[0].routing_last4} · account ••${r[0].account_last4}`,
      callback: { phone: r[0].contact_phone, contact: r[0].contact_name,
                  phoneChangedAt: await phoneChangedAt(c, co, r[0].vendor_id) } };
  }
  if (type === "vendor") {
    const r = await q<{ name: string }>(c, `
      select coalesce(v.dba, v.legal_name) as name from vendor v
        join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2
       where v.id = $1`, [id, co.id]);
    if (r[0]) return { kind: "vendor", title: `New vendor · ${r[0].name}`, detail: "Set up to receive bills", date: null, link: `vendor:${id}` };
  }
  return { kind: type, title: type.replace(/_/g, " "), detail: "", date: null, link: null };
}

export const ROLE_WORD: Record<string, string> = { owner: "owner", controller: "controller", approver: "approver", ap_clerk: "A/P clerk", viewer: "viewer" };
const roleWord = (r: string) => ROLE_WORD[r] ?? r.replace(/_/g, " ");
const either = (names: string[]) => names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

/** Everything open, split into what this person can decide and what waits on others -- and on whom. */
export async function approvals(c: Client, co: Company, personId: string | null) {
  const open = await q<OpenRequest>(c, `
    select r.id, r.subject_type, r.subject_id, r.amount_minor, r.created_at, r.maker_id,
           mu.name as maker_name, s.seq as step_seq, s.required_role as step_role,
           (select count(*) from approval_step s2 where s2.request_id = r.id)::int as steps
      from approval_request r
      join lateral (select seq, required_role from approval_step st
                     where st.request_id = r.id and st.decision is null order by seq limit 1) s on true
      join app_user mu on mu.id = r.maker_id
     where r.entity_id = $1 and r.status = 'open'
     order by r.created_at`, [co.id]);

  // Who holds which role here, and who already decided a step of each open
  // request: the engine never lets the maker or an earlier approver decide.
  const holders = await q<{ role: string; id: string; name: string }>(c, `
    select distinct g.role, u.id, u.name from role_grant g join app_user u on u.id = g.app_user_id
     where u.status = 'active' and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2))
     order by u.name`, [co.id, co.tenantId]);
  const stepActors = await q<{ request_id: string; actor_id: string }>(c, `
    select s.request_id, s.actor_id from approval_step s join approval_request r on r.id = s.request_id
     where r.entity_id = $1 and r.status = 'open' and s.actor_id is not null`, [co.id]);
  const decided = new Map<string, Set<string>>();
  for (const s of stepActors) {
    if (!decided.has(s.request_id)) decided.set(s.request_id, new Set());
    decided.get(s.request_id)!.add(s.actor_id);
  }
  const held = new Set(holders.filter((h) => h.id === personId).map((h) => h.role));

  const mine = [];
  const others = [];
  for (const r of open) {
    const subject = await subjectSummary(c, co, r.subject_type, r.subject_id);
    const already = decided.get(r.id) ?? new Set<string>();
    const who = holders.filter((h) => h.role === r.step_role && h.id !== r.maker_id && !already.has(h.id)).map((h) => h.name);
    const role = roleWord(r.step_role);
    const waiting = who.length ? `waiting on ${either(who)}, the ${role}` : `nobody here holds the ${role} role yet; the owner can grant it`;
    let why = "";
    let canDecide = false;
    if (!personId) why = `Pick who you are acting as; ${waiting}`;
    else if (r.maker_id === personId) why = `You made it, so someone else approves it: ${waiting}`;
    else if (already.has(personId)) why = `You decided an earlier step; the next is ${waiting}`;
    else if (!held.has(r.step_role)) why = cap(waiting);
    else canDecide = true;
    (canDecide ? mine : others).push({ ...r, step_role_word: role, who, subject, why });
  }

  const recent = await q(c, `
    select s.decided_at, s.decision, s.note, s.required_role, u.name as actor_name, r.subject_type, r.subject_id,
           r.amount_minor, r.status as request_status
      from approval_step s
      join approval_request r on r.id = s.request_id
      left join app_user u on u.id = s.actor_id
     where r.entity_id = $1 and s.decision is not null
     order by s.decided_at desc limit 12`, [co.id]);
  const recentWithSubject = [];
  for (const r of recent as { subject_type: string; subject_id: string; required_role: string }[]) {
    recentWithSubject.push({ ...r, required_role: roleWord(r.required_role), subject: await subjectSummary(c, co, r.subject_type, r.subject_id) });
  }
  return { mine, others, recent: recentWithSubject, roles: [...held].map(roleWord) };
}

// ------------------------------------------------------------------ reasons

const UUIDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The engine's reasons, in words a person reads. An id becomes the bill it points at. */
function plainReason(r: string, names: Map<string, string>): string {
  let m: RegExpExecArray | null;
  if ((m = /^possible duplicate of (\S+)$/i.exec(r))) return `Looks like a copy of ${names.get(m[1].toLowerCase()) ?? "a bill already on file"}`;
  if ((m = /^outside the ([\d.]+)% band$/i.exec(r))) {
    return Number(m[1]) ? `More than ${m[1]}% away from what this vendor usually bills` : "Not the fixed amount this vendor always bills";
  }
  if ((m = /^inside the ([\d.]+)% band$/i.exec(r))) {
    return Number(m[1]) ? `Within ${m[1]}% of what this vendor usually bills` : "The fixed amount this vendor always bills";
  }
  const words: Record<string, string> = {
    "below the confidence gate": "The reader was not sure enough of what it read",
    "vendor not set up": "The vendor is not set up for this company",
    "no template for this vendor yet": "Nothing on file yet for what this vendor usually bills",
    "template matched, no expected amount": "Matches this vendor's usual bill",
    "merchandise invoice with no purchase order": "Merchandise billed with no purchase order",
    "three-way match clean": "Matches the purchase order and what was received",
    "under the approval threshold": "Under the approval threshold",
    "over the approval threshold": "Over the approval threshold, so it goes for approval",
    "awaiting approval": "Waiting on approval",
    "approval complete": "Approved",
    "posted on approval": "Posted to the books",
  };
  return words[r.toLowerCase()] ?? r.replace(UUIDS, (id) => names.get(id.toLowerCase()) ?? "another record");
}
/** One reason, as a person reads it. */
export async function explainReason(c: Client, co: Company, reason: string | null | undefined): Promise<string | null> {
  if (!reason) return reason ?? null;
  return ((await plainReasons(c, co, [{ reason }]))[0].reason as string) ?? null;
}
async function plainReasons<T extends { reason?: unknown }>(c: Client, co: Company, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.flatMap((r) => (typeof r.reason === "string" ? r.reason.match(UUIDS) ?? [] : [])).map((s) => s.toLowerCase()))];
  const names = new Map<string, string>();
  if (ids.length) {
    const found = await q<{ id: string; reference: string | null; total_minor: string; invoice_date: string }>(c, `
      select i.id, i.reference, i.total_minor, i.invoice_date::text from invoice i
       where i.entity_id = $1 and i.id = any($2::uuid[])`, [co.id, ids]);
    for (const f of found) {
      names.set(f.id, `${f.reference ?? "an earlier bill"} (${USD.format(Number(f.total_minor) / 100)}, dated ${f.invoice_date})`);
    }
  }
  return rows.map((r) => (typeof r.reason === "string" && r.reason ? { ...r, reason: plainReason(r.reason, names) } : r));
}

// ----------------------------------------------------------------- payables

const BILL_TABS: Record<string, string[]> = {
  attention: ["exception", "held", "pending"],
  topay: ["approved", "scheduled"],
  paid: ["paid"],
  rejected: ["rejected"],
  all: ["captured", "extracted", "matched", "validated", "pending", "exception", "held", "approved", "scheduled", "paid", "rejected"],
};

export async function bills(c: Client, co: Company, tab: string) {
  const statuses = BILL_TABS[tab] ?? BILL_TABS.attention;
  const rows = await q(c, `
    select i.id, coalesce(v.dba, v.legal_name) as vendor, i.reference, i.kind, i.invoice_date::text, i.due_date::text,
           i.total_minor, i.status, greatest(0, current_date - i.due_date)::int as days_past_due,
           (select string_agg(distinct po.name, ', ') from invoice_line il
              join profit_object po on po.id = il.profit_object_id where il.invoice_id = i.id) as stores,
           (select ae.reason from audit_event ae
             where ae.table_name = 'invoice' and ae.row_id = i.id::text and ae.action = 'transition'
             order by ae.id desc limit 1) as reason,
           (select pr.pay_date::text from payment p join payment_run pr on pr.id = p.payment_run_id
             where p.invoice_id = i.id and pr.status <> 'cancelled' order by pr.pay_date desc limit 1) as pay_date,
           (select s.required_role from approval_request r
              join approval_step s on s.request_id = r.id and s.decision is null
             where r.subject_type = 'invoice' and r.subject_id = i.id and r.status = 'open'
             order by s.seq limit 1) as waiting_on
      from invoice i join vendor v on v.id = i.vendor_id
     where i.entity_id = $1 and i.status = any($2)
     order by case i.status when 'exception' then 0 when 'held' then 1 when 'pending' then 2 else 3 end,
              coalesce(i.due_date, i.invoice_date), i.created_at
     limit 300`, [co.id, statuses]);
  const counts = await q<{ status: string; n: number; total: string }>(c, `
    select status, count(*)::int as n, sum(total_minor) as total
      from invoice where entity_id = $1 group by status`, [co.id]);
  const tabCounts: Record<string, { n: number; total: string }> = {};
  for (const [k, list] of Object.entries(BILL_TABS)) {
    const hit = counts.filter((x) => list.includes(x.status));
    tabCounts[k] = { n: hit.reduce((s, x) => s + x.n, 0), total: hit.reduce((s, x) => s + BigInt(x.total), 0n).toString() };
  }
  return { tab: BILL_TABS[tab] ? tab : "attention", rows: await plainReasons(c, co, rows), counts: tabCounts };
}

export async function bill(c: Client, co: Company, id: string) {
  const head = await q(c, `
    select i.id, i.vendor_id, coalesce(v.dba, v.legal_name) as vendor, v.legal_name, i.reference, i.kind,
           i.invoice_date::text, i.due_date::text, i.total_minor, i.status, i.confidence_bps, i.created_at,
           i.created_by, u.name as created_by_name, i.purchase_order_id,
           (select t.expected_amount_minor from vendor_template t
              join vendor_entity ve on ve.id = t.vendor_entity_id and ve.entity_id = i.entity_id
             where ve.vendor_id = i.vendor_id and t.status = 'active' limit 1) as usual_minor
      from invoice i join vendor v on v.id = i.vendor_id left join app_user u on u.id = i.created_by
     where i.id = $1 and i.entity_id = $2`, [id, co.id]);
  if (!head.length) return null;
  const lines = await q(c, `
    select il.seq, ga.code, ga.name as account, po.name as store, il.description, il.amount_minor
      from invoice_line il
      join invoice i on i.id = il.invoice_id and i.entity_id = $2
      join gl_account ga on ga.id = il.gl_account_id
      left join profit_object po on po.id = il.profit_object_id
     where il.invoice_id = $1 order by il.seq`, [id, co.id]);
  const timeline = await q(c, `
    select ae.at, ae.actor_label, ae.actor_kind, ae.action, ae.before->>'status' as from_status,
           ae.after->>'status' as to_status, ae.reason
      from audit_event ae
     where ae.entity_id = $2 and ae.table_name = 'invoice' and ae.row_id = $1
     order by ae.id`, [id, co.id]);
  const requests = await q(c, `
    select r.id, r.status, r.created_at, r.decided_at, mu.name as maker_name,
           (select json_agg(json_build_object('seq', s.seq, 'role', s.required_role, 'decision', s.decision,
                    'actor', au.name, 'at', s.decided_at, 'note', s.note) order by s.seq)
              from approval_step s left join app_user au on au.id = s.actor_id where s.request_id = r.id) as steps
      from approval_request r join app_user mu on mu.id = r.maker_id
     where r.entity_id = $2 and r.subject_type = 'invoice' and r.subject_id = $1
     order by r.created_at`, [id, co.id]);
  const payments = await q(c, `
    select pr.id as run_id, pr.pay_date::text, pr.method, pr.status as run_status, p.amount_minor, p.status
      from payment p join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $2
     where p.invoice_id = $1 order by pr.pay_date`, [id, co.id]);
  const entries = await q(c, `
    select je.id, je.posting_date::text, je.description, je.source_type
      from journal_entry je
     where je.entity_id = $2 and ((je.source_type = 'invoice' and je.source_id = $1)
        or (je.source_type = 'payment' and je.source_id in (select p.payment_run_id from payment p where p.invoice_id = $1)))
     order by je.posting_date, je.posted_at`, [id, co.id]);
  const steps = (requests as { steps: { role: string }[] | null }[]).map((r) => ({
    ...r, steps: (r.steps ?? []).map((s) => ({ ...s, role: roleWord(s.role) })) }));
  return { ...head[0], lines, timeline: await plainReasons(c, co, timeline), requests: steps, payments, entries };
}

export async function vendors(c: Client, co: Company) {
  return await q(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, v.legal_name, v.is_1099, v.w9_on_file, v.status as vendor_status,
           v.city, v.state, v.contact_name, v.contact_phone,
           ve.status, ve.terms_days, ga.code as gl_code, ga.name as gl_name, po.name as store,
           (select count(*) from invoice i where i.vendor_id = v.id and i.entity_id = $1)::int as bills,
           (select coalesce(sum(i.total_minor), 0) from invoice i
             where i.vendor_id = v.id and i.entity_id = $1 and i.status in ('approved','scheduled','pending','validated','held','exception')) as open_minor,
           (select max(i.invoice_date)::text from invoice i where i.vendor_id = v.id and i.entity_id = $1) as last_bill,
           (select vba.account_last4 from vendor_bank_account vba
             where vba.vendor_id = v.id and vba.status = 'current' order by vba.version desc limit 1) as bank_last4,
           exists (select 1 from vendor_bank_account vba where vba.vendor_id = v.id and vba.status = 'pending') as bank_change_pending
      from vendor_entity ve
      join vendor v on v.id = ve.vendor_id
      left join gl_account ga on ga.id = ve.default_gl_account_id
      left join profit_object po on po.id = ve.default_profit_object_id
     where ve.entity_id = $1
     order by 2`, [co.id]);
}

/** One vendor: the whole record, its bank details and their history, and its recent bills. */
export async function vendor(c: Client, co: Company, id: string) {
  const rows = await q(c, `
    select v.id, v.legal_name, v.dba, coalesce(v.dba, v.legal_name) as name, v.status as vendor_status, v.tax_classification,
           v.is_1099, v.tin_last4, v.w9_on_file, v.address_line1, v.address_line2, v.city, v.state, v.postal_code, v.remit_to,
           v.contact_name, v.contact_phone, v.contact_email, v.created_at, cu.name as created_by_name,
           ve.status, ve.terms_days, ve.default_gl_account_id, ve.default_profit_object_id,
           ga.code as gl_code, ga.name as gl_name, po.name as store
      from vendor_entity ve
      join vendor v on v.id = ve.vendor_id
      left join app_user cu on cu.id = v.created_by
      left join gl_account ga on ga.id = ve.default_gl_account_id
      left join profit_object po on po.id = ve.default_profit_object_id
     where ve.entity_id = $2 and v.id = $1`, [id, co.id]);
  if (!rows.length) return null;
  const banks = await q(c, `
    select b.id, b.version, b.bank_name, b.routing_last4, b.account_last4, b.status, b.effective_from, b.hold_until,
           b.callback_note, b.account_ref, b.created_at, u.name as created_by_name,
           (b.hold_until is not null and b.hold_until > now()) as cooling_off
      from vendor_bank_account b left join app_user u on u.id = b.created_by
     where b.vendor_id = $1 and b.vendor_id in (select vendor_id from vendor_entity where entity_id = $2)
     order by b.version desc`, [id, co.id]);
  const bills = await q(c, `
    select i.id, i.reference, i.invoice_date::text, i.total_minor, i.status
      from invoice i where i.vendor_id = $1 and i.entity_id = $2 order by i.invoice_date desc limit 8`, [id, co.id]);
  return { ...rows[0], banks, bills, phone_changed_at: await phoneChangedAt(c, co, id) };
}

export async function paymentRuns(c: Client, co: Company) {
  const runs = await q(c, `
    select pr.id, pr.pay_date::text, pr.method, pr.status, pr.created_at, pr.released_at,
           bu.name as built_by_name, ru.name as released_by_name, pr.built_by,
           ba.name as bank_account, ba.account_last4,
           (select count(*) from payment p where p.payment_run_id = pr.id)::int as payments,
           (select coalesce(sum(p.amount_minor), 0) from payment p where p.payment_run_id = pr.id) as total_minor,
           (select r.status from approval_request r where r.subject_type = 'payment_run' and r.subject_id = pr.id
             order by r.created_at desc limit 1) as approval_status,
           (select s.required_role from approval_request r
              join approval_step s on s.request_id = r.id and s.decision is null
             where r.subject_type = 'payment_run' and r.subject_id = pr.id and r.status = 'open'
             order by s.seq limit 1) as waiting_on
      from payment_run pr
      join app_user bu on bu.id = pr.built_by
      left join app_user ru on ru.id = pr.released_by
      left join bank_account ba on ba.id = pr.bank_account_id
     where pr.entity_id = $1
     order by pr.pay_date desc, pr.created_at desc limit 20`, [co.id]);
  const eligible = await q(c, `
    select i.id, coalesce(v.dba, v.legal_name) as vendor, i.reference, i.invoice_date::text, i.due_date::text,
           i.total_minor, greatest(0, current_date - i.due_date)::int as days_past_due
      from invoice i join vendor v on v.id = i.vendor_id
     where i.entity_id = $1 and i.status = 'approved'
       and not exists (select 1 from payment p join payment_run pr on pr.id = p.payment_run_id
                        where p.invoice_id = i.id and pr.status in ('building','pending_release','released','settled'))
     order by i.due_date nulls last, i.invoice_date`, [co.id]);
  const bank = await q(c, `
    select id, name, bank_name, account_last4, ach_origination_enabled
      from bank_account where entity_id = $1 and purpose = 'operating' and status = 'active'`, [co.id]);
  return { runs, eligible, operating: bank[0] ?? null };
}

export async function paymentRun(c: Client, co: Company, id: string) {
  const runs = (await paymentRuns(c, co)).runs as { id: string }[];
  const run = runs.find((r) => r.id === id) ?? (await q(c, `
    select pr.id, pr.pay_date::text, pr.method, pr.status from payment_run pr where pr.id = $1 and pr.entity_id = $2`,
    [id, co.id]))[0];
  if (!run) return null;
  const payments = await q(c, `
    select p.id, p.amount_minor, p.status, i.id as invoice_id, i.reference, coalesce(v.dba, v.legal_name) as vendor,
           i.due_date::text
      from payment p
      join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $2
      join invoice i on i.id = p.invoice_id
      join vendor v on v.id = i.vendor_id
     where p.payment_run_id = $1 order by vendor`, [id, co.id]);
  return { ...run, payment_list: payments };
}

// ------------------------------------------------------------------ payroll

/**
 * Payroll, one pay group at a time: each group runs on its own schedule, with
 * its own period open and its own people.
 */
export async function payroll(c: Client, co: Company) {
  const groups = await q<{ id: string }>(c, `
    select pg.id, pg.name, pg.frequency, pg.pay_lag_days, pg.workweek_start_dow, pg.overtime_after_hours,
           ba.name as bank_account, ba.account_last4,
           (select count(*) from employee e where e.pay_group_id = pg.id and e.status in ('active','leave'))::int as people,
           (select count(*) from employee e where e.pay_group_id = pg.id and e.status = 'active' and e.pay_type = 'salary')::int as salaried
      from pay_group pg join bank_account ba on ba.id = pg.bank_account_id
     where pg.entity_id = $1 and pg.status = 'active'
     order by case pg.frequency when 'weekly' then 0 when 'biweekly' then 1 when 'semimonthly' then 2 else 3 end, pg.name`, [co.id]);
  const periods = await q<{ pay_group_id: string }>(c, `
    select pp.id, pp.pay_group_id, pg.name as pay_group, pg.frequency, pp.starts_on::text, pp.ends_on::text, pp.pay_date::text, pp.status,
           (pp.ends_on <= current_date) as period_over,
           (select count(*) from timecard t where t.pay_period_id = pp.id)::int as timecards,
           (select coalesce(sum(t.hours), 0) from timecard t where t.pay_period_id = pp.id) as hours,
           (select count(*) from timecard t where t.pay_period_id = pp.id and t.status = 'recorded')::int as to_approve,
           (select count(*) from timecard t where t.pay_period_id = pp.id and t.status = 'exception')::int as exceptions,
           (select count(distinct t.employee_id) from timecard t where t.pay_period_id = pp.id)::int as employees,
           (select pr.id from payroll_run pr where pr.pay_period_id = pp.id and pr.status <> 'cancelled'
             order by pr.created_at desc limit 1) as run_id
      from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pg.entity_id = $1 and pp.status not in ('posted','cancelled')
     order by pp.pay_date`, [co.id]);
  const runs = await q(c, `
    select pr.id, pg.name as pay_group, pp.pay_date::text, pp.starts_on::text, pp.ends_on::text, pr.status, pr.gross_minor, pr.net_minor,
           pr.employee_tax_minor, pr.employer_tax_minor, pr.deductions_minor, pr.tax_provider,
           pr.built_by, bu.name as built_by_name, ru.name as released_by_name, pr.released_at,
           (select count(*) from payroll_line pl where pl.payroll_run_id = pr.id)::int as employees,
           (select r.status from approval_request r where r.subject_type = 'payroll_run' and r.subject_id = pr.id
             order by r.created_at desc limit 1) as approval_status,
           (select s.required_role from approval_request r
              join approval_step s on s.request_id = r.id and s.decision is null
             where r.subject_type = 'payroll_run' and r.subject_id = pr.id and r.status = 'open'
             order by s.seq limit 1) as waiting_on
      from payroll_run pr
      join pay_period pp on pp.id = pr.pay_period_id
      join pay_group pg on pg.id = pp.pay_group_id
      join app_user bu on bu.id = pr.built_by
      left join app_user ru on ru.id = pr.released_by
     where pr.entity_id = $1
     order by pp.pay_date desc, pr.created_at desc limit 12`, [co.id]);
  const employees = await q(c, `
    select e.id, e.employee_no, e.first_name || ' ' || e.last_name as name, e.position, e.pay_type, e.base_rate_minor, e.status,
           e.hired_on::text, e.terminated_on::text, po.name as store, e.comp_class_code, e.work_state,
           pg.name as pay_group, pg.frequency,
           (select ch.after from employee_change ch where ch.employee_id = e.id and ch.status = 'pending' limit 1) as pending_change
      from employee e
      left join profit_object po on po.id = e.profit_object_id
      left join pay_group pg on pg.id = e.pay_group_id
     where e.entity_id = $1
       and (e.status <> 'terminated' or e.terminated_on >= current_date - 90)
     order by case e.status when 'applicant' then 0 when 'active' then 1 when 'leave' then 2 else 3 end, e.last_name`, [co.id]);
  const remittances = await q(c, `
    select dt.name, dr.due_on::text, dr.deducted_minor, dr.employer_match_minor, dr.remitted_minor, dr.status,
           greatest(0, current_date - dr.due_on)::int as days_late
      from deduction_remittance dr join deduction_type dt on dt.id = dr.deduction_type_id
     where dr.entity_id = $1 and dr.status <> 'remitted'
     order by dr.due_on limit 20`, [co.id]);
  const out = groups.map((g) => ({ ...g, current: periods.find((p) => p.pay_group_id === g.id) ?? null }));
  return { groups: out, periods, runs, employees, remittances };
}

/** One person: their record, a pay change waiting on approval, and what has happened to them. */
export async function employee(c: Client, co: Company, id: string) {
  const rows = await q(c, `
    select e.id, e.employee_no, e.first_name, e.last_name, e.position, e.pay_type, e.base_rate_minor, e.status,
           e.hired_on::text, e.terminated_on::text, e.work_state, e.comp_class_code, e.profit_object_id, po.name as store,
           e.pay_group_id, pg.name as pay_group, pg.frequency
      from employee e
      left join profit_object po on po.id = e.profit_object_id
      left join pay_group pg on pg.id = e.pay_group_id
     where e.id = $1 and e.entity_id = $2`, [id, co.id]);
  if (!rows.length) return null;
  const pending = await q(c, `
    select ch.id, ch.before, ch.after, ch.reason, ch.requested_at, u.name as requested_by,
           (select pg.name from pay_group pg where pg.id = (ch.after->>'pay_group_id')::uuid) as new_group
      from employee_change ch join app_user u on u.id = ch.requested_by
     where ch.employee_id = $1 and ch.entity_id = $2 and ch.status = 'pending'`, [id, co.id]);
  const history = await q(c, `
    select ae.at, ae.actor_label, ae.table_name, ae.action, ae.reason
      from audit_event ae
     where ae.entity_id = $2
       and ((ae.table_name = 'employee' and ae.row_id = $3)
         or (ae.table_name = 'employee_change' and ae.row_id in (select ch.id::text from employee_change ch where ch.employee_id = $1 and ch.entity_id = $2)))
     order by ae.id desc limit 30`, [id, co.id, id]);
  const pay = await q(c, `
    select pp.pay_date::text, pl.regular_hours, pl.overtime_hours, pl.gross_minor, pl.net_minor, pr.status
      from payroll_line pl
      join payroll_run pr on pr.id = pl.payroll_run_id and pr.entity_id = $2
      join pay_period pp on pp.id = pr.pay_period_id
     where pl.employee_id = $1 and pr.status <> 'cancelled'
     order by pp.pay_date desc limit 6`, [id, co.id]);
  return { ...rows[0], pending: pending[0] ?? null, history, pay };
}

export async function payrollRun(c: Client, co: Company, id: string) {
  const runs = (await payroll(c, co)).runs as { id: string }[];
  const run = runs.find((r) => r.id === id);
  if (!run) return null;
  const lines = await q(c, `
    select e.first_name || ' ' || e.last_name as name, po.name as store, pl.regular_hours, pl.overtime_hours,
           pl.gross_minor, pl.employee_tax_minor, pl.deductions_minor, pl.net_minor
      from payroll_line pl
      join payroll_run pr on pr.id = pl.payroll_run_id and pr.entity_id = $2
      join employee e on e.id = pl.employee_id
      left join profit_object po on po.id = pl.profit_object_id
     where pl.payroll_run_id = $1 order by e.last_name`, [id, co.id]);
  return { ...run, lines };
}

export async function timecards(c: Client, co: Company, periodId: string) {
  return await q(c, `
    select e.first_name || ' ' || e.last_name as name, po.name as store,
           count(t.id)::int as days, coalesce(sum(t.hours), 0) as hours,
           count(*) filter (where t.status = 'recorded')::int as to_approve,
           count(*) filter (where t.status = 'exception')::int as exceptions,
           count(*) filter (where t.status = 'approved')::int as approved
      from timecard t
      join employee e on e.id = t.employee_id and e.entity_id = $2
      left join profit_object po on po.id = e.profit_object_id
     where t.pay_period_id = $1
     group by e.id, e.first_name, e.last_name, po.name
     order by e.last_name`, [periodId, co.id]);
}

// -------------------------------------------------------------------- books

type Stored = { id: string; code: string; name: string };

/** Revenue and expense by account, by store, for a date range. */
export async function pnl(c: Client, co: Company, from: string, to: string) {
  const cols = (await stores(c, co)) as Stored[];
  const rows = await q<{ code: string; name: string; account_type: string; profit_object_id: string | null; amount: string }>(c, `
    select ga.code, ga.name, ga.account_type, jl.profit_object_id,
           sum(case when ga.account_type = 'revenue' then jl.credit_minor - jl.debit_minor
                    else jl.debit_minor - jl.credit_minor end) as amount
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join gl_account ga on ga.id = jl.gl_account_id
     where je.entity_id = $1 and je.posting_date between $2::date and $3::date
       and ga.account_type in ('revenue', 'expense')
     group by ga.code, ga.name, ga.account_type, jl.profit_object_id
     order by ga.code`, [co.id, from, to]);
  const accounts = new Map<string, { code: string; name: string; type: string; byStore: Record<string, string>; total: bigint }>();
  let unassigned = false;
  for (const r of rows) {
    const key = r.code;
    if (!accounts.has(key)) accounts.set(key, { code: r.code, name: r.name, type: r.account_type, byStore: {}, total: 0n });
    const a = accounts.get(key)!;
    const col = r.profit_object_id ?? "none";
    if (!r.profit_object_id) unassigned = true;
    a.byStore[col] = (BigInt(a.byStore[col] ?? "0") + BigInt(r.amount)).toString();
    a.total += BigInt(r.amount);
  }
  const list = [...accounts.values()].map((a) => ({ ...a, total: a.total.toString() }));
  return {
    from, to,
    stores: [...cols.map((s) => ({ id: s.id, name: s.name })), ...(unassigned ? [{ id: "none", name: "Company" }] : [])],
    accounts: list,
  };
}

export async function accountLines(c: Client, co: Company, code: string, from: string, to: string, store: string | null) {
  const acct = await q<{ id: string; code: string; name: string; account_type: string }>(c, `
    select id, code, name, account_type from gl_account
     where tenant_id = $1 and code = $2 /* unscoped: the chart is shared across the client's companies */`,
    [co.tenantId, code]);
  if (!acct.length) return null;
  const lines = await q(c, `
    select jl.id, je.id as entry_id, je.posting_date::text, je.description, je.source_type, je.source_id,
           jl.debit_minor, jl.credit_minor, jl.memo, po.name as store, ba.name as bank_account
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      left join profit_object po on po.id = jl.profit_object_id
      left join bank_account ba on ba.id = jl.bank_account_id
     where je.entity_id = $1 and jl.gl_account_id = $2
       and je.posting_date between $3::date and $4::date
       and ($5::text is null or ($5 = 'none' and jl.profit_object_id is null) or jl.profit_object_id::text = $5)
     order by je.posting_date desc, je.posted_at desc limit 400`, [co.id, acct[0].id, from, to, store]);
  return { account: acct[0], from, to, store, lines };
}

export async function entry(c: Client, co: Company, id: string) {
  const head = await q(c, `
    select je.id, je.posting_date::text, je.description, je.source_type, je.source_id, je.posted_at, je.actor_kind,
           u.name as posted_by_name, je.reversal_of_id, fp.status as period_status
      from journal_entry je
      left join app_user u on u.id = je.posted_by
      join fiscal_period fp on fp.id = je.period_id
     where je.id = $1 and je.entity_id = $2`, [id, co.id]);
  if (!head.length) return null;
  const lines = await q(c, `
    select jl.seq, ga.code, ga.name as account, po.name as store, ba.name as bank_account,
           jl.debit_minor, jl.credit_minor, jl.memo
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $2
      join gl_account ga on ga.id = jl.gl_account_id
      left join profit_object po on po.id = jl.profit_object_id
      left join bank_account ba on ba.id = jl.bank_account_id
     where jl.journal_entry_id = $1 order by jl.seq`, [id, co.id]);
  // What the entry came from, so the drill can keep going to the document.
  const h = head[0] as { source_type: string; source_id: string | null };
  let source: { kind: string; id: string; label: string } | null = null;
  if (h.source_type === "invoice" && h.source_id) source = { kind: "bill", id: h.source_id, label: "Open the bill" };
  if (h.source_type === "payment" && h.source_id) source = { kind: "payment", id: h.source_id, label: "Open the payment run" };
  if (h.source_type === "payroll" && h.source_id) source = { kind: "payrun", id: h.source_id, label: "Open the payroll run" };
  return { ...head[0], lines, source };
}

export async function trialBalance(c: Client, co: Company, asOf: string) {
  const rows = await q(c, `
    select ga.code, ga.name, ga.account_type,
           sum(jl.debit_minor) as debit_minor, sum(jl.credit_minor) as credit_minor,
           sum(jl.debit_minor - jl.credit_minor) as balance_minor
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join gl_account ga on ga.id = jl.gl_account_id
     where je.entity_id = $1 and je.posting_date <= $2::date
     group by ga.code, ga.name, ga.account_type
     order by ga.code`, [co.id, asOf]);
  const periods = await q(c, `
    select starts_on::text, ends_on::text, status from fiscal_period
     where entity_id = $1 and starts_on <= current_date + 31
     order by starts_on desc limit 4`, [co.id]);
  return { asOf, rows, periods };
}

// --------------------------------------------------------------------- cash

export async function cash(c: Client, co: Company) {
  const positions = await q(c, `
    select bp.bank_account_id, bp.name, bp.purpose, bp.bank_name, bp.account_last4, bp.location_name,
           bp.ledger_balance_minor, bp.last_statement_minor,
           (select max(bs.statement_date)::text from bank_statement bs where bs.bank_account_id = bp.bank_account_id) as last_statement_on
      from bank_position bp
     where bp.entity_id = $1
     order by case bp.purpose when 'operating' then 0 when 'payroll' then 1 when 'tax' then 2 else 3 end,
              bp.location_name nulls first, bp.name`, [co.id]);
  const coverage = await q(c, `
    select branches::int, by_the_bank::int, by_us::int, by_hand::int from sweep_automation where entity_id = $1`, [co.id]);
  const sweeps = await q(c, `
    select ss.from_account, ss.bank_name, ss.location_name, ss.method, ss.automated, ss.awaiting_minor,
           ss.overdue::int, ss.last_swept_on::text, u.name as owner
      from sweep_status ss left join app_user u on u.id = ss.assigned_to
     where ss.entity_id = $1 order by ss.automated desc, ss.from_account`, [co.id]);
  const transfers = await q(c, `
    select bt.id, f.name as from_account, t.name as to_account, bt.amount_minor, bt.transfer_date::text, bt.method,
           bt.status, bt.due_on::text, au.name as assigned_to, cu.name as confirmed_by, bt.confirmed_at,
           (bt.status in ('expected','planned') and bt.due_on < current_date) as overdue
      from bank_transfer bt
      join bank_account f on f.id = bt.from_bank_account_id
      join bank_account t on t.id = bt.to_bank_account_id
      left join app_user au on au.id = bt.assigned_to
      left join app_user cu on cu.id = bt.confirmed_by
     where bt.entity_id = $1
     order by case when bt.status in ('expected','planned') then 0 else 1 end, bt.transfer_date desc, bt.created_at desc
     limit 40`, [co.id]);
  const waiting = await q(c, `
    select ud.name, ud.bank_name, ud.location_name, ud.balance_minor
      from uncollected_deposits ud where ud.entity_id = $1 and ud.balance_minor <> 0 order by ud.name`, [co.id]);
  return { positions, coverage: coverage[0] ?? null, sweeps, transfers, waiting };
}

// ---------------------------------------------------------- reconciliation

export async function recon(c: Client, co: Company) {
  const accounts = await q(c, `
    select ba.id, ba.name, ba.bank_name, ba.account_last4, ba.purpose,
           (select count(*) from bank_statement_line l join bank_statement s on s.id = l.bank_statement_id
             where s.bank_account_id = ba.id)::int as lines_total,
           (select count(*) from bank_statement_line l join bank_statement s on s.id = l.bank_statement_id
             where s.bank_account_id = ba.id and l.match_status = 'unmatched')::int as lines_open,
           (select count(*) from pos_deposit pd where pd.bank_account_id = ba.id and pd.status = 'open')::int as deposits_open,
           (select max(rr.ran_at) from reconciliation_run rr where rr.bank_account_id = ba.id) as last_run,
           (select coalesce(sum(rr.variance_minor), 0) from reconciliation_run rr where rr.bank_account_id = ba.id) as fees_minor
      from bank_account ba
     where ba.entity_id = $1 and ba.status = 'active'
     order by case ba.purpose when 'operating' then 0 when 'deposit' then 1 else 2 end, ba.name`, [co.id]);
  const lines = await q(c, `
    select ubl.statement_line_id, ubl.bank_account_id, ubl.account_name, ubl.posted_on::text, ubl.description,
           ubl.amount_minor, ubl.days_open::int
      from unmatched_bank_lines ubl where ubl.entity_id = $1
     order by ubl.posted_on desc limit 200`, [co.id]);
  const deposits = await q(c, `
    select pd.id, pd.bank_account_id, ba.name as account_name, l.name as location_name, pd.business_date::text,
           pd.method, pd.amount_minor, pd.expected_on::text, greatest(0, current_date - pd.expected_on)::int as days_late
      from pos_deposit pd
      join location l on l.id = pd.location_id
      left join bank_account ba on ba.id = pd.bank_account_id
     where pd.entity_id = $1 and pd.status = 'open'
     order by pd.expected_on limit 200`, [co.id]);
  const matches = await q(c, `
    select m.id, m.method, m.matched_kind, m.amount_minor, m.variance_minor, m.created_at, l.posted_on::text,
           l.description, ba.name as account_name, u.name as matched_by
      from reconciliation_match m
      join bank_statement_line l on l.id = m.bank_statement_line_id
      join bank_statement s on s.id = l.bank_statement_id
      join bank_account ba on ba.id = s.bank_account_id
      left join app_user u on u.id = m.matched_by
     where ba.entity_id = $1
     order by m.created_at desc, l.posted_on desc limit 30`, [co.id]);
  const byMethod = await q<{ method: string; n: number }>(c, `
    select m.method, count(*)::int as n
      from reconciliation_match m
      join bank_statement_line l on l.id = m.bank_statement_line_id
      join bank_statement s on s.id = l.bank_statement_id
      join bank_account ba on ba.id = s.bank_account_id
     where ba.entity_id = $1 group by m.method`, [co.id]);
  return { accounts, lines, deposits, matches, byMethod };
}

/** What a person could match this line to. */
export async function matchCandidates(c: Client, co: Company, lineId: string) {
  const line = await q<{ id: string; bank_account_id: string; posted_on: string; amount_minor: string; description: string }>(c, `
    select l.id, s.bank_account_id, l.posted_on::text, l.amount_minor, l.description
      from bank_statement_line l
      join bank_statement s on s.id = l.bank_statement_id
      join bank_account ba on ba.id = s.bank_account_id
     where l.id = $1 and ba.entity_id = $2`, [lineId, co.id]);
  if (!line.length) return null;
  const L = line[0];
  const deposits = await q(c, `
    select pd.id, 'pos_deposit' as kind, l.name || ' takings, ' || pd.business_date::text || ' (' || pd.method || ')' as label,
           pd.amount_minor, pd.expected_on::text as on_date, abs(pd.amount_minor - $3::bigint) as gap
      from pos_deposit pd join location l on l.id = pd.location_id
     where pd.entity_id = $1 and pd.bank_account_id = $2 and pd.status = 'open'
       and abs(pd.expected_on - $4::date) <= 10
       and abs(pd.amount_minor - $3::bigint) <= greatest(5000, abs($3::bigint) / 10)
     order by gap, pd.expected_on limit 8`, [co.id, L.bank_account_id, L.amount_minor, L.posted_on]);
  const transfers = await q(c, `
    select bt.id, 'bank_transfer' as kind, 'Sweep ' || f.name || ' → ' || t.name || ', ' || bt.transfer_date::text as label,
           bt.amount_minor, bt.transfer_date::text as on_date, abs(bt.amount_minor - abs($3::bigint)) as gap
      from bank_transfer bt
      join bank_account f on f.id = bt.from_bank_account_id
      join bank_account t on t.id = bt.to_bank_account_id
     where bt.entity_id = $1 and (bt.from_bank_account_id = $2 or bt.to_bank_account_id = $2)
       and abs(bt.transfer_date - $4::date) <= 10
       and abs(bt.amount_minor - abs($3::bigint)) <= greatest(5000, abs($3::bigint) / 10)
       and not exists (select 1 from reconciliation_match m where m.matched_kind = 'bank_transfer' and m.matched_id = bt.id)
     order by gap limit 5`, [co.id, L.bank_account_id, L.amount_minor, L.posted_on]);
  const payments = BigInt(L.amount_minor) < 0n ? await q(c, `
    select p.id, 'payment' as kind, coalesce(v.dba, v.legal_name) || ' ' || coalesce(i.reference, '') || ', paid ' || pr.pay_date::text as label,
           p.amount_minor, pr.pay_date::text as on_date, abs(p.amount_minor + $3::bigint) as gap
      from payment p
      join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $1 and pr.bank_account_id = $2
      join invoice i on i.id = p.invoice_id join vendor v on v.id = i.vendor_id
     where abs(pr.pay_date - $4::date) <= 15
       and abs(p.amount_minor + $3::bigint) <= greatest(5000, abs($3::bigint) / 10)
       and not exists (select 1 from reconciliation_match m where m.matched_kind = 'payment' and m.matched_id = p.id)
     order by gap limit 5`, [co.id, L.bank_account_id, L.amount_minor, L.posted_on]) : [];
  return { line: L, candidates: [...deposits, ...transfers, ...payments] };
}

// -------------------------------------------------------------------- feeds

type ConnRow = {
  id: string; name: string; source_code: string; source_name: string; direction: string;
  channel: string; mode: string; status: string; verdict: string; days_since_success: number | null;
  consecutive_failures: number; last_error: string | null; last_success_at: string | null;
  last_attempt_at: string | null; credential_ref: string | null; format: string | null;
  mailbox: string | null; host: string | null; account_name: string | null; bank_name: string | null;
  account_last4: string | null; files: number; last_file_at: string | null;
};

// Which network clients this build actually has. The pipeline is wired for
// both; the clients themselves are the next thing to write.
export const TRANSPORTS = { sftp: false, http: false };

/** What stands between a connection and its first file: setup (arrange it) or build (code still to write). */
function stepsFor(r: ConnRow): { kind: "setup" | "build"; text: string }[] {
  const steps: { kind: "setup" | "build"; text: string }[] = [];
  const noun = r.source_name.split(" ").map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");
  const a = /^[aeiou]/i.test(noun) ? "An" : "A";
  if (!handlerFor(r.source_code)) {
    steps.push({ kind: "build", text: `${a} ${noun} ${r.direction === "outbound" ? "writer" : "reader"}` });
  }
  const from = r.bank_name ? ` from ${r.bank_name}` : r.host ? ` for ${r.host}` : "";
  const credentialSet = !!(r.credential_ref && process.env[secretEnvName(r.credential_ref)]);
  switch (r.channel) {
    case "sftp":
      if (!credentialSet) steps.push({ kind: "setup", text: `SFTP login${from}` });
      if (!TRANSPORTS.sftp) steps.push({ kind: "build", text: "The SFTP connector" });
      break;
    case "api":
      if (!credentialSet) steps.push({ kind: "setup", text: `API key${from}` });
      if (!TRANSPORTS.http) steps.push({ kind: "build", text: "The bank API connector" });
      break;
    case "email":
      if (!process.env.ERP_EMAIL_INBOUND_TOKEN) steps.push({ kind: "setup", text: "The inbound-email token" });
      if (!r.files) steps.push({ kind: "setup", text: `Mail to ${r.mailbox ?? "its mailbox"} forwarded here` });
      break;
    case "webhook":
      if (!credentialSet) steps.push({ kind: "setup", text: "Its signing secret" });
      break;
  }
  return steps;
}

export async function connections(c: Client, co: Company) {
  const rows = await q<ConnRow>(c, `
    select c.id, c.name, c.source_code, s.name as source_name, s.direction,
           c.channel, sc.mode, c.status, h.verdict, h.days_since_success,
           c.consecutive_failures, c.last_error, c.last_success_at, c.last_attempt_at,
           c.credential_ref, c.config->>'format' as format, c.config->>'mailbox' as mailbox, c.config->>'host' as host,
           b.name as account_name, b.bank_name, b.account_last4,
           (select count(*) from inbound_file f where f.connection_id = c.id)::int as files,
           (select max(f.received_at) from inbound_file f where f.connection_id = c.id) as last_file_at
      from connection c
      join connection_health h on h.connection_id = c.id
      join ingest_source s on s.code = c.source_code
      join source_channel sc on sc.source_code = c.source_code and sc.channel = c.channel
      left join bank_account b on b.id = c.bank_account_id
     where c.entity_id = $1 or (c.entity_id is null and c.tenant_id = $2)
     order by s.direction, c.name`, [co.id, co.tenantId]);
  return rows.map(({ credential_ref, ...r }) => ({ ...r, steps: stepsFor({ ...r, credential_ref }) }));
}

/**
 * Every weekday in the last 30 days with no statement on file -- holes
 * included -- counted from the account's first statement, so an account's
 * history does not show as missing before it had any. An account with no
 * statement at all is shown as such, not as thirty missing days. The
 * statement_gaps view in 0013 only counts days after an account's latest
 * statement, so a missing Wednesday between two good days went unseen; this
 * is the rule the screens use until a migration corrects the view.
 */
export async function gaps(c: Client, co: Company) {
  return await q<{ bank_account_id: string; account_name: string; bank_name: string; missing_on: string; days_ago: number }>(c, `
    with acct as (
      select b.id, b.name, b.bank_name,
             greatest(current_date - 30, b.opened_on,
                      (select min(s.statement_date) from bank_statement s where s.bank_account_id = b.id)) as since
        from bank_account b
       where b.entity_id = $1 and b.status = 'active'
         and exists (select 1 from bank_statement s where s.bank_account_id = b.id)
    ), days as (
      select a.id, a.name, a.bank_name, d::date as d
        from acct a, generate_series(a.since::timestamp, (current_date - 1)::timestamp, interval '1 day') d
       where extract(isodow from d) between 1 and 5
    )
    select id as bank_account_id, name as account_name, bank_name,
           d::text as missing_on, (current_date - d)::int as days_ago
      from days
     where not exists (select 1 from bank_statement s where s.bank_account_id = days.id and s.statement_date = days.d)
     order by d desc, name`, [co.id]);
}

export async function feeds(c: Client, co: Company) {
  const conns = await connections(c, co);
  const accounts = await q<Record<string, unknown>>(c, `
    select i.bank_account_id, i.account_name, i.bank_name, b.account_last4, b.purpose,
           l.name as location, i.connection_id, c.name as connection_name, i.channel,
           i.connection_status, i.through::text as through, i.quarantined::int as quarantined
      from statement_intake i
      join bank_account b on b.id = i.bank_account_id
      left join location l on l.id = b.location_id
      left join connection c on c.id = i.connection_id
     where i.entity_id = $1
     order by case b.purpose when 'operating' then 0 when 'deposit' then 1
                             when 'payroll' then 2 else 3 end, i.account_name`, [co.id]);
  const missing = await gaps(c, co);
  for (const a of accounts) {
    const mine = missing.filter((g) => g.bank_account_id === a.bank_account_id).map((g) => g.missing_on);
    a.missing_days = mine.length;
    a.missing_dates = mine;
    a.never = !a.through;
  }
  const quarantine = await q(c, `
    select file_id, connection_name, source_code, channel, origin, received_at,
           quarantine_reason as reason, days_open
      from quarantined_files where entity_id = $1 order by received_at`, [co.id]);
  const runs = await q(c, `
    select r.id, c.name as connection_name, c.channel, r.trigger, r.actor_kind,
           r.started_at, r.finished_at, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error
      from ingest_run r join connection c on c.id = r.connection_id
     where c.entity_id = $1 order by r.started_at desc limit 12`, [co.id]);
  return { connections: conns, accounts, quarantine, runs };
}

// --------------------------------------------------------------------- home

export async function home(c: Client, co: Company, personId: string | null) {
  const cashRows = await q<{ purpose: string; total: string }>(c, `
    select purpose, sum(ledger_balance_minor) as total from bank_position where entity_id = $1 group by purpose`, [co.id]);
  const cashTotal = cashRows.reduce((s, r) => s + BigInt(r.total), 0n);
  const operating = cashRows.find((r) => r.purpose === "operating")?.total ?? "0";

  const billStats = await one<{ due7_n: number; due7: string; overdue_n: number; overdue: string; attention: number; pending: number }>(c, `
    select count(*) filter (where status in ('approved','scheduled') and due_date <= current_date + 7)::int as due7_n,
           coalesce(sum(total_minor) filter (where status in ('approved','scheduled') and due_date <= current_date + 7), 0) as due7,
           count(*) filter (where status in ('approved','scheduled') and due_date < current_date)::int as overdue_n,
           coalesce(sum(total_minor) filter (where status in ('approved','scheduled') and due_date < current_date), 0) as overdue,
           count(*) filter (where status in ('exception','held'))::int as attention,
           count(*) filter (where status = 'pending')::int as pending
      from invoice where entity_id = $1`, [co.id]);

  const appr = await approvals(c, co, personId);

  // One open period per pay group, soonest pay date first.
  const nextPay = await q(c, `
    select pp.id, pg.id as pay_group_id, pg.name as pay_group, pg.frequency, pp.pay_date::text, pp.status, pp.starts_on::text, pp.ends_on::text,
           run.status as run_status, run.net_minor,
           (select r.status from approval_request r where r.subject_type = 'payroll_run' and r.subject_id = run.id
             order by r.created_at desc limit 1) as approval_status,
           (select count(*) from timecard t where t.pay_period_id = pp.id)::int as timecards,
           (select count(*) from timecard t where t.pay_period_id = pp.id and t.status = 'recorded')::int as to_approve,
           (select count(*) from employee e where e.pay_group_id = pg.id and e.status = 'active' and e.pay_type = 'salary')::int as salaried,
           (pp.ends_on <= current_date) as period_over
      from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
      left join lateral (select pr.id, pr.status, pr.net_minor from payroll_run pr
                          where pr.pay_period_id = pp.id and pr.status <> 'cancelled'
                          order by pr.created_at desc limit 1) run on true
     where pg.entity_id = $1 and pg.status = 'active' and pp.status not in ('posted','cancelled')
     order by pp.pay_date limit 6`, [co.id]);
  const payGroups = await one<{ n: number }>(c, `
    select count(*)::int as n from pay_group where entity_id = $1 and status = 'active'`, [co.id]);

  const rec = await one<{ lines: number; lines_minor: string; deposits: number; deposits_minor: string; late: number }>(c, `
    select (select count(*) from unmatched_bank_lines u where u.entity_id = $1)::int as lines,
           (select coalesce(sum(u.amount_minor), 0) from unmatched_bank_lines u where u.entity_id = $1) as lines_minor,
           (select count(*) from pos_deposit pd where pd.entity_id = $1 and pd.status = 'open')::int as deposits,
           (select coalesce(sum(pd.amount_minor), 0) from pos_deposit pd where pd.entity_id = $1 and pd.status = 'open') as deposits_minor,
           (select count(*) from pos_deposit pd where pd.entity_id = $1 and pd.status = 'open' and pd.expected_on < current_date - 2)::int as late`,
    [co.id]);

  const sweepsOverdue = await q(c, `
    select bt.id, f.name as from_account, bt.amount_minor, bt.due_on::text, u.name as owner, bt.method
      from bank_transfer bt join bank_account f on f.id = bt.from_bank_account_id
      left join app_user u on u.id = bt.assigned_to
     where bt.entity_id = $1 and bt.status in ('expected','planned') and bt.due_on < current_date
     order by bt.due_on`, [co.id]);

  const conns = await connections(c, co);
  const quarantined = await q<{ n: number }>(c, `select count(*)::int as n from quarantined_files where entity_id = $1`, [co.id]);

  const monthStart = new Date();
  const from = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const to = new Date().toISOString().slice(0, 10);
  const pl = await one<{ revenue: string; expenses: string }>(c, `
    select coalesce(sum(case when ga.account_type = 'revenue' then jl.credit_minor - jl.debit_minor else 0 end), 0) as revenue,
           coalesce(sum(case when ga.account_type = 'expense' then jl.debit_minor - jl.credit_minor else 0 end), 0) as expenses
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join gl_account ga on ga.id = jl.gl_account_id
     where je.entity_id = $1 and je.posting_date between $2::date and $3::date`, [co.id, from, to]);

  const attention = await q(c, `
    select i.id, coalesce(v.dba, v.legal_name) as vendor, i.reference, i.total_minor, i.status,
           (select ae.reason from audit_event ae
             where ae.table_name = 'invoice' and ae.row_id = i.id::text and ae.action = 'transition'
             order by ae.id desc limit 1) as reason
      from invoice i join vendor v on v.id = i.vendor_id
     where i.entity_id = $1 and i.status in ('exception', 'held')
     order by i.created_at limit 10`, [co.id]);

  return {
    cash: { total: cashTotal.toString(), operating, byPurpose: cashRows },
    bills: billStats,
    approvals: { mine: appr.mine, othersCount: appr.others.length },
    payroll: nextPay,
    payGroups: payGroups.n,
    hires: (await q<{ n: number }>(c, `select count(*)::int as n from employee where entity_id = $1 and status = 'applicant'`, [co.id]))[0].n,
    payChanges: (await q<{ n: number }>(c, `select count(*)::int as n from employee_change where entity_id = $1 and status = 'pending'`, [co.id]))[0].n,
    recon: rec,
    sweepsOverdue,
    feeds: {
      total: conns.length,
      healthy: conns.filter((x) => x.status === "active" && x.verdict === "healthy").length,
      failing: conns.filter((x) => x.status === "failed" || (x.status === "active" && x.verdict === "failing")).length,
      stale: conns.filter((x) => x.status === "active" && x.verdict === "stale").length,
      quarantined: quarantined[0]?.n ?? 0,
    },
    month: { from, to, revenue: pl.revenue, expenses: pl.expenses, net: (BigInt(pl.revenue) - BigInt(pl.expenses)).toString() },
    attention: await plainReasons(c, co, attention),
  };
}

// -------------------------------------------------------------------- setup

/** A company's setup: who it is, its stores, bank accounts, people and roles, and its approval rules. */
export async function setup(c: Client, co: Company) {
  const company = await one(c, `
    select e.id, e.name, e.legal_name, e.ein_last4, e.fiscal_year_end_month, e.created_at, t.name as client, t.vertical,
           t.location_label, t.profit_object_label
      from entity e join tenant t on t.id = e.tenant_id
     where e.id = $1 /* unscoped: the company itself */`, [co.id]);
  const storesList = await q(c, `
    select po.id, po.code, po.name, po.kind, po.status, l.state,
           (select count(*) from employee e where e.profit_object_id = po.id and e.status = 'active')::int as people
      from profit_object po left join location l on l.id = po.location_id
     where po.entity_id = $1 order by case po.kind when 'store' then 0 else 1 end, po.name`, [co.id]);
  const banks = await q(c, `
    select ba.id, ba.name, ba.purpose, ba.bank_name, ba.routing_last4, ba.account_last4, ba.ach_origination_enabled,
           ba.status, l.name as location, ga.code as gl_code
      from bank_account ba left join location l on l.id = ba.location_id join gl_account ga on ga.id = ba.gl_account_id
     where ba.entity_id = $1
     order by case ba.purpose when 'operating' then 0 when 'payroll' then 1 when 'tax' then 2 else 3 end, ba.name`, [co.id]);
  // A role granted for this company can be changed here; one granted for every
  // company of the client (client_roles) is the operator's to change.
  const team = await q<{ id: string; name: string; email: string; status: string; own_roles: string[]; client_roles: string[] }>(c, `
    select u.id, u.name, u.email, u.status,
           coalesce(array_agg(distinct g.role order by g.role) filter (where g.entity_id = $1), '{}') as own_roles,
           coalesce(array_agg(distinct g.role order by g.role) filter (where g.entity_id is null and u.tenant_id = $2), '{}') as client_roles
      from app_user u
      left join role_grant g on g.app_user_id = u.id
     where u.tenant_id = $2 or exists (select 1 from role_grant g2 where g2.app_user_id = u.id and g2.entity_id = $1)
     group by u.id, u.name, u.email, u.status
     order by u.name`, [co.id, co.tenantId]);
  const policies = await q<{ subject_type: string; min_amount_minor: string; steps: { seq: number; role: string }[]; requires_callback: boolean }>(c, `
    select subject_type, min_amount_minor, steps, requires_callback from approval_policy
     where entity_id = $1 and active order by subject_type, min_amount_minor`, [co.id]);
  return {
    company, stores: storesList, banks,
    people: team.map((p) => ({ ...p, roles: [...new Set([...p.client_roles, ...p.own_roles])].map(roleWord) })),
    policies: policies.map((p) => ({ ...p, steps: p.steps.map((s) => roleWord(s.role)) })),
  };
}

/** The clients kept here, for starting a new company: its chart can be copied from any of them. */
export async function clients(c: Client) {
  return await q(c, `
    select t.id, t.name, t.vertical,
           (select count(*) from entity e where e.tenant_id = t.id)::int as companies,
           (select count(*) from gl_account g where g.tenant_id = t.id)::int as accounts
      from tenant t order by t.name /* unscoped: the operator's list of clients */`);
}
