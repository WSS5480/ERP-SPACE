// Setup mode approvals (migration 0066): "for every new customer before go live".
//
//   1. An operator in support mode, before the company goes live, approves a
//      new vendor (Ashley) for a one-owner store and sets up Ashley's catalog
//      feeds, all without the owner; the same for a new hire, an opening-balance
//      entry and an accounting period. Each is marked "approved by ERP setup
//      (operator), support session <id>", has an audit row with the support
//      reason, shows "(approved during setup)" in the history, is in the
//      owner's digest and on the go-live step's review list.
//   2. Never money or bank details: a vendor bank account, a payment run,
//      payroll, a bill (and a journal entry that is not an opening balance)
//      are refused, in code and in the database (a direct SQL write too).
//   3. Go live is the owner's (never support mode), needs the review tick when
//      ERP setup approved anything, is recorded once and cannot be undone;
//      after it ERP setup is refused, and the screens say why.
//   4. The install-wide API token with x-erp-as behaves the same.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { T } from "./harness.ts";
import { tx, q, type Client, type Scope } from "../../packages/core/db.ts";
import { companyOf } from "./catalog.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SYS = { kind: "system" as const, label: "check" };

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
const rows = <R extends Record<string, any> = Record<string, unknown>>(t: T, sql: string, args: unknown[] = []) =>
  read(t, (c) => q<R>(c, sql + (/unscoped/.test(sql) ? "" : " /* unscoped: check */"), args));

type Co = { tag: string; tenantId: string; entityId: string; ownerId: string; scope: Scope; today: string };

/** A fresh customer, as the Operator console makes one: one furniture company, one store, its owner and nobody else. */
async function freshCompany(t: T, label: string): Promise<Co> {
  const { createCustomer } = await import("../../server/platform.ts");
  const tag = randomBytes(3).toString("hex");
  const made = await tx(SYS, (c) => createCustomer(c, { actor: "check", kind: "operator" },
    { tenantName: `${label} ${tag}`, legalName: `${label} LLC ${tag}`, state: "TX", pack: "furniture", ownerEmail: `owner-${tag}@example.com`, plan: "standard" }, "https://erp.example"));
  const today = (await rows<{ d: string }>(t, `select business_today($1)::text d`, [made.entityId]))[0].d;
  return { tag, tenantId: made.tenantId, entityId: made.entityId, ownerId: made.ownerId, today,
    scope: { tenantId: made.tenantId, entityId: made.entityId, actor: { kind: "user", id: made.ownerId, label: "Owner" } } };
}

export async function run(t: T) {
  const AP = await import("../../packages/core/approvals.ts");
  const OD = await import("../../packages/core/owner_digest.ts");
  const ob = await import("../../packages/core/onboarding.ts");
  const { post } = await import("../../packages/core/posting.ts");
  const { feedTemplates } = await import("../../packages/core/vendor_feeds.ts");

  const A = await freshCompany(t, "Setup Furniture");
  const B = await freshCompany(t, "Token Furniture");
  const merch = (await rows<{ code: string }>(t, `select code from vendor_category where tenant_id = $1 and active and is_merchandise limit 1`, [A.tenantId]))[0];
  const started = new Date(Date.now() - 1000).toISOString();

  const saved = { logins: process.env.ERP_LOGINS, token: process.env.ERP_API_TOKEN };
  process.env.ERP_LOGINS = "opsy:operator-pass-123";
  process.env.ERP_API_TOKEN = saved.token && saved.token.length >= 32 ? saved.token : "t".repeat(48);
  const { createServer } = await import("../../server/index.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  type Res = { status: number; data: Record<string, any>; cookie: string | null };
  const call = async (method: string, path: string, o: { body?: unknown; cookie?: string | null; as?: string; token?: boolean } = {}): Promise<Res> => {
    const headers: Record<string, string> = { "x-erp-page": "1", "x-forwarded-for": "198.51.100.91" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.cookie) headers.cookie = o.cookie;
    if (o.as) headers["x-erp-as"] = o.as;
    if (o.token) headers.authorization = `Bearer ${process.env.ERP_API_TOKEN}`;
    const r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const sc = r.headers.get("set-cookie");
    let data: Record<string, any> = {};
    try { data = await r.json() as Record<string, any>; } catch { /* empty */ }
    return { status: r.status, data, cookie: sc ? sc.split(";")[0] : null };
  };
  const reqFor = async (x: Co, type: string, subject: string) => (await rows<{ id: string }>(t,
    `select id from approval_request where entity_id = $1 and subject_type = $2 and subject_id = $3 order by created_at desc limit 1`, [x.entityId, type, subject]))[0]?.id;
  const stepOf = async (reqId: string) => (await rows<{ decision: string | null; setup_session: string | null; setup_by: string | null; setup_reason: string | null; self_approved: boolean; actor_id: string | null }>(t,
    `select decision, setup_session, setup_by, setup_reason, self_approved, actor_id from approval_step where request_id = $1 order by seq /* unscoped: by request */`, [reqId]));

  try {
    // ======================================================= support mode, before go-live
    const op = (await call("POST", "/session", { body: { name: "opsy", key: "operator-pass-123" } })).cookie;
    const REASON = "onboarding: setting up the new store's vendors and books";
    const sup = await call("POST", `/api/platform/customers/${A.tenantId}/support`, { cookie: op, body: { reason: REASON } });
    const cookie = sup.cookie ?? op;
    const session = (await rows<{ id: string }>(t, `select id from platform_support_session where tenant_id = $1 and operator = 'opsy' and ended_at is null /* unscoped: check */`, [A.tenantId]))[0]?.id;
    t.ok("setup: the operator enters the new customer in support mode", sup.status === 200 && !!session, `${sup.status}`);
    const asA = (method: string, path: string, body?: unknown) => call(method, `/api/c/${A.entityId}${path}`, { cookie, as: A.ownerId, body });

    // ---- Ashley, added and approved by ERP setup, then its catalog feeds
    const ashleyName = `Ashley Furniture ${A.tag}`;
    const added = await asA("POST", "/vendors", { name: ashleyName, category: merch.code, merchandise: true, contactPhone: "555-555-0101" });
    const ashley = String(added.data.id);
    const aReq = await reqFor(A, "vendor", ashley);
    t.ok("setup: the operator (as the one owner) adds Ashley as a vendor; it waits on approval", added.status === 200 && added.data.status === "pending" && !!aReq, JSON.stringify(added.data));
    const cardBefore = (await asA("GET", "/catalog/vendors")).data.vendors?.find((v: { id: string }) => v.id === ashley);
    t.ok("setup: Catalog → Vendors offers \"Approve (setup)\" on Ashley's pending card in support mode before go-live",
      !!cardBefore && cardBefore.pending && cardBefore.can_approve && cardBefore.setup_approve && !cardBefore.setup_note, JSON.stringify(cardBefore && { p: cardBefore.pending, c: cardBefore.can_approve, s: cardBefore.setup_approve }));
    const apBefore = (await asA("GET", "/approvals")).data;
    const aRow = apBefore.mine?.find((r: { id: string }) => r.id === aReq);
    t.ok("setup: the Approvals screen has it waiting on ERP setup (setup: true), not as a self-approval, with the setup-mode note",
      !!aRow && aRow.setup === true && aRow.self === false && apBefore.setupMode?.live === false && /before go-live/i.test(apBefore.setupMode?.note ?? ""), JSON.stringify(aRow && { setup: aRow.setup, self: aRow.self }));
    const ok = await asA("POST", `/approvals/${aReq}`, { decision: "approved" });
    const aSteps = await stepOf(aReq);
    t.ok("setup: ERP setup approves Ashley without the owner", ok.status === 200 && ok.data.status === "approved"
      && (await rows<{ status: string }>(t, `select status from vendor_entity where entity_id = $1 and vendor_id = $2`, [A.entityId, ashley]))[0]?.status === "active", JSON.stringify(ok.data));
    t.ok("setup: the step is marked with the support session, the operator and the support reason (filled by the database), not self-approved",
      aSteps.length > 0 && aSteps.every((s) => s.decision === "approved" && s.setup_session === session && s.setup_by === "opsy" && s.setup_reason === REASON && !s.self_approved), JSON.stringify(aSteps));
    const aud = await rows<{ reason: string; after: Record<string, unknown> }>(t, `select reason, after from audit_event where entity_id = $1 and table_name = 'approval_request' and row_id = $2 order by id`, [A.entityId, aReq]);
    t.ok("setup: an audit row says \"approved by ERP setup (opsy), support session <id>\" with the support reason",
      aud.some((r) => r.reason.startsWith(`approved by ERP setup (opsy), support session ${session}`) && r.reason.includes(REASON) && r.after?.setup === true && r.after?.supportReason === REASON),
      aud.map((r) => r.reason).join(" | "));
    const hist = (await asA("GET", "/approvals")).data.recent?.find((r: { subject_id: string }) => r.subject_id === ashley);
    const appJs = readFileSync(ROOT + "server/app.js", "utf8");
    t.ok("setup: the approval history carries the setup marking and shows it as \"(approved during setup)\"",
      hist?.setup_session === session && hist?.setup_by === "opsy" && /\(approved during setup\)/.test(appJs) && /r\.setup_session \? setupWords\(r\)/.test(appJs), JSON.stringify(hist && { s: hist.setup_session, b: hist.setup_by }));

    const tpl = feedTemplates("ashley", ashleyName);
    const feedsMade: Res[] = [];
    for (const f of tpl) feedsMade.push(await asA("POST", "/catalog/feeds", { feed: { ...f, vendor_id: ashley, active: false } }));
    const feedRows = await rows<{ n: string }>(t, `select count(*)::text n from vendor_feed where entity_id = $1 and vendor_id = $2`, [A.entityId, ashley]);
    t.ok("setup: then Ashley's catalog feeds (products, prices, quantities) are added in Catalog connections, still without the owner",
      tpl.length >= 3 && feedsMade.every((r) => r.status === 200 && !!r.data.id) && Number(feedRows[0].n) === tpl.length, feedsMade.map((r) => `${r.status} ${r.data.error ?? ""}`).join("; "));

    // ---- a new hire, an opening entry, a period
    const bank = (await rows<{ id: string }>(t, `select id from bank_account where entity_id = $1 order by id limit 1`, [A.entityId]))[0]?.id;
    const pg = (await rows<{ id: string }>(t, `insert into pay_group (tenant_id, entity_id, name, frequency, bank_account_id) values ($1, $2, 'Weekly', 'weekly', $3) returning id`,
      [A.tenantId, A.entityId, bank]))[0].id;
    const hire = await asA("POST", "/payroll/people", { firstName: "Dana", lastName: `Setup${A.tag}`, position: "Sales associate", payGroupId: pg, payType: "hourly", rate: "18.50", workState: "TX", hiredOn: A.today });
    const hReq = await reqFor(A, "employee", String(hire.data.id));
    const hOk = hReq ? await asA("POST", `/approvals/${hReq}`, { decision: "approved" }) : null;
    t.ok("setup: a new hire is approved by ERP setup (employee active, step marked)",
      hire.status === 200 && hOk?.status === 200 && hOk.data.status === "approved" && (await stepOf(hReq!)).every((s) => s.setup_session === session)
      && (await rows<{ status: string }>(t, `select status from employee where entity_id = $1 and id = $2`, [A.entityId, hire.data.id]))[0]?.status === "active", `${hire.status} ${hire.data.error ?? ""} ${hOk?.status} ${hOk?.data.error ?? ""}`);

    const ob1 = await asA("POST", "/onboarding/opening-bank", { bankAccountId: bank, asOf: A.today, amount: "12500.00" });
    const openJe = (await rows<{ id: string }>(t, `select journal_entry_id id from opening_bank_balance where entity_id = $1`, [A.entityId]))[0]?.id;
    const supTx = <R>(fn: (c: Client) => Promise<R>) => tx({ kind: "user", id: A.ownerId, label: "opsy (support) as Owner", support: session }, fn);
    const jReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "journal_entry", subjectId: openJe, amountMinor: 1_250_000n, makerId: A.ownerId })) as { requestId: string };
    const jOk = await asA("POST", `/approvals/${jReq.requestId}`, { decision: "approved" });
    t.ok("setup: an opening-balance entry (the bank opening balance, source 'opening') is approved by ERP setup",
      ob1.status === 200 && !!openJe && jOk.status === 200 && jOk.data.status === "approved", `${ob1.status} ${ob1.data.error ?? ""} ${jOk.status} ${jOk.data.error ?? ""}`);
    const period = (await rows<{ id: string }>(t, `select id from fiscal_period where entity_id = $1 order by starts_on limit 1`, [A.entityId]))[0]?.id;
    const pReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "fiscal_period", subjectId: period, amountMinor: null, makerId: A.ownerId })) as { requestId: string };
    const pOk = await asA("POST", `/approvals/${pReq.requestId}`, { decision: "approved" });
    t.ok("setup: an accounting period is approved by ERP setup", pOk.status === 200 && pOk.data.status === "approved", `${pOk.status} ${pOk.data.error ?? ""}`);

    // ---- never money or bank details
    const bankReq = await asA("POST", `/vendors/${ashley}/bank`, { bankName: "First Test Bank", routingLast4: "1234", accountLast4: "5678", heldAt: "the bank's payee record", reason: "letter on letterhead" });
    const bReq = await reqFor(A, "vendor_bank_account", String(bankReq.data.id));
    const bTry = await asA("POST", `/approvals/${bReq}`, { decision: "approved", note: "called them", callback: true, confirm: ashleyName });
    t.ok("refused: ERP setup cannot approve a vendor bank account (409, in a sentence)", !!bReq && bTry.status === 409 && /support mode never self-approves/.test(String(bTry.data.error)), `${bTry.status} ${bTry.data.error}`);
    const apList = (await asA("GET", "/approvals")).data;
    t.ok("refused: and the Approvals screen does not offer it in support mode", !apList.mine?.some((r: { id: string }) => r.id === bReq), JSON.stringify(apList.mine?.map((r: { subject_type: string }) => r.subject_type)));
    for (const [type, amount, word] of [["payment_run", 25_000n, "a payment run"], ["payroll_run", 123_456n, "payroll"], ["invoice", 250_000n, "a bill"]] as const) {
      const r = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: type, subjectId: randomUUID(), amountMinor: amount, makerId: A.ownerId })) as { requestId: string };
      const tried = await asA("POST", `/approvals/${r.requestId}`, { decision: "approved", confirm: "1,234.56" });
      t.ok(`refused: ERP setup cannot approve ${word} (409, in a sentence; still open)`, tried.status === 409 && /support mode never self-approves/.test(String(tried.data.error))
        && (await rows<{ status: string }>(t, `select status from approval_request where entity_id = $1 and id = $2`, [A.entityId, r.requestId]))[0]?.status === "open", `${tried.status} ${tried.data.error}`);
    }
    const manual = await tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => post(c, A.scope, { date: A.today, sourceType: "manual", sourceId: null,
      description: "Not an opening balance", lines: [{ code: "6900", debit: 1000n }, { code: "3000", credit: 1000n }] }));
    const mReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "journal_entry", subjectId: manual, amountMinor: 1_000_000n, makerId: A.ownerId })) as { requestId: string };
    const mTry = await asA("POST", `/approvals/${mReq.requestId}`, { decision: "approved" });
    t.ok("refused: a journal entry that is not an opening balance waits for the owner", mTry.status === 409 && /only opening-balance entries/.test(String(mTry.data.error)), `${mTry.status} ${mTry.data.error}`);

    // ---- the database, directly
    const payReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "payment_run", subjectId: randomUUID(), amountMinor: 100n, makerId: A.ownerId })) as { requestId: string };
    await t.throws("database: a step marked as a setup approval with no support session is refused (direct SQL)",
      () => tx({ kind: "user", id: A.ownerId, label: "sql" }, (c) => c.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now(), setup_session = $3 where request_id = $1`, [payReq.requestId, A.ownerId, session])),
      /marked with the support session making it/);
    await t.throws("database: under the support session, a payment run step marked as a setup approval is refused (direct SQL)",
      () => supTx((c) => c.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now(), setup_session = $3 where request_id = $1`, [payReq.requestId, A.ownerId, session])),
      /ERP setup approves only setup records/);
    const v3 = await asA("POST", "/vendors", { name: `Bypass Vendor ${A.tag}`, category: merch.code, merchandise: true });
    const v3Req = await reqFor(A, "vendor", String(v3.data.id));
    await t.throws("database: a support session that is not open (made up) cannot mark a setup approval (direct SQL)",
      () => { const fake = randomUUID(); return tx({ kind: "user", id: A.ownerId, label: "sql", support: fake }, (c) => c.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now(), setup_session = $3 where request_id = $1`, [v3Req, A.ownerId, fake])); },
      /support session making this approval is not open/);
    await t.throws("database: the maker deciding their own step with no marking is still refused (direct SQL)",
      () => tx({ kind: "user", id: A.ownerId, label: "sql" }, (c) => c.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now() where request_id = $1`, [v3Req, A.ownerId])),
      /maker cannot approve their own request/);
    const codeSql = await read(t, async (c) => {
      const sqlAns = (await q<{ w: string | null }>(c, `select setup_approve_refusal($1, $2, array['controller'], 'vendor', $3, $4) w /* unscoped: check */`, [A.entityId, A.ownerId, v3.data.id, session]))[0].w;
      return sqlAns;
    });
    t.ok("rule: the SQL rule lets ERP setup approve a new vendor before go-live", codeSql === null, String(codeSql));

    // ---- the owner's digest and the go-live review list
    const items = await read(t, (c) => OD.selfApprovals(c, A.entityId, started, new Date().toISOString()));
    const setupItems = items.filter((i) => i.flow === "setup");
    t.ok("digest: the owner's digest lists what ERP setup approved (vendor, hire, opening entry, period), each marked (approved during setup) and naming the operator",
      ["vendor:", "person:", "entry:", "period:"].every((k) => setupItems.some((i) => (i.link ?? "").startsWith(k))) && setupItems.every((i) => /approved during setup/.test(i.detail) && /ERP setup \(opsy\)/.test(i.by ?? "")),
      JSON.stringify(setupItems.map((i) => [i.title, i.link, i.by])));
    const dig = await tx(SYS, (c) => OD.makeDigest(c, { ...A.scope, actor: SYS }, new Date()));
    const note = (await rows<{ title: string; body: string; items: { flow: string }[] }>(t, `select title, body, items from owner_notification where entity_id = $1 order by created_at desc limit 1`, [A.entityId]))[0];
    t.ok("digest: the daily digest is made for them, its text saying \"approved during setup\" and the support session",
      dig.made && !!note && /approved during setup/.test(note.title) && note.body.includes(`support session ${session}`) && note.items.filter((i) => i.flow === "setup").length >= 4, `${dig.note} | ${note?.title}`);
    const cl = await read(t, (c) => ob.checklist(c, A.tenantId, A.entityId));
    const review = cl.setupApprovals;
    const kinds = new Set(review.map((r) => r.kind));
    t.ok("go-live review: the Go-live step lists everything approved during setup (vendors, employees, opening entries, periods), each with its record",
      ["Vendors", "Employees", "Opening entries", "Periods"].every((k) => kinds.has(k)) && review.every((r) => !!r.link && /ERP setup \(opsy\)/.test(r.detail))
      && !!cl.steps.find((s) => s.id === "golive")?.setupApprovals?.length && cl.wentLive === null, JSON.stringify(review.map((r) => [r.kind, r.title, r.link])));
    const obJs = readFileSync(ROOT + "server/ui/onboarding.js", "utf8");
    t.ok("go-live review: the step shows the list with drill-down (Back) to each record, and the review tick",
      /function goLivePanel\(d, s\)/.test(obJs) && /E\.drillItems\(title, list\.map\(setupLine\)/.test(obJs) && /E\.openSubject\(x\.link\)/.test(obJs) && /I’ve reviewed what ERP setup approved/.test(obJs)
      && /opener\('vendor'/.test(appJs) && /opener\('person'/.test(appJs) && /if \(kind === 'entry'\) openEntry\(id\)/.test(appJs));
    const catJs = readFileSync(ROOT + "server/ui/catalog.js", "utf8");
    t.ok("screens: Catalog → Vendors and Approvals label the button \"Approve (setup)\" and show the after-go-live sentence",
      /v\.setup_approve \? 'Approve \(setup\)' : 'Approve'/.test(catJs) && /why: v\.setup_note \|\| null/.test(catJs) && /a\.setup \? 'Approve \(setup\)' : 'Approve'/.test(appJs) && /d\.setupMode \?/.test(appJs));

    // ---- go live: the owner's own step
    for (const s of cl.steps.filter((x) => x.status === "todo" && x.skippable)) {
      await tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.skipStep(c, A.scope, s.id, "check: not needed to test go-live"));
    }
    const ready = await read(t, (c) => ob.checklist(c, A.tenantId, A.entityId));
    t.ok("go-live: with every other step done or skipped, the go-live check passes", ready.complete, JSON.stringify(ready.steps.filter((s) => s.status === "todo").map((s) => [s.id, s.checks.filter((x) => !x.ok)])));
    const viaSupport = await asA("POST", "/onboarding/go-live", { reviewed: true });
    t.ok("go-live: ERP setup cannot press Go live in support mode (409)", viaSupport.status === 409 && /owner's own step/.test(String(viaSupport.data.error)), `${viaSupport.status} ${viaSupport.data.error}`);
    await t.throws("go-live: the owner is asked to tick the review first when ERP setup approved anything",
      () => tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: false })), /reviewed what ERP setup approved/);
    const went = await tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: true }));
    const gl = (await rows<{ setup_items: number; reviewed_setup: boolean }>(t, `select setup_items, reviewed_setup from company_go_live where entity_id = $1`, [A.entityId]))[0];
    t.ok("go-live: the owner ticks the review and goes live; recorded with what was reviewed", went.wentLive && gl?.reviewed_setup === true && gl.setup_items === review.length, JSON.stringify(gl));
    await t.throws("go-live: it cannot be undone (no delete)", () => tx(SYS, (c) => c.query(`delete from company_go_live where entity_id = $1`, [A.entityId])), /append-only/);
    await t.throws("go-live: nor changed", () => tx(SYS, (c) => c.query(`update company_go_live set went_live_at = now() - interval '1 day' where entity_id = $1`, [A.entityId])), /append-only/);
    await t.throws("go-live: nor pressed twice", () => tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: true })), /already gone live/);

    // ---- after go-live: ERP setup is refused
    const late = await asA("POST", "/vendors", { name: `Late Vendor ${A.tag}`, category: merch.code, merchandise: true });
    const lReq = await reqFor(A, "vendor", String(late.data.id));
    const lTry = await asA("POST", `/approvals/${lReq}`, { decision: "approved" });
    t.ok("after go-live: the operator is refused on a new vendor (409, saying the company has gone live)", lTry.status === 409 && /gone live/.test(String(lTry.data.error)), `${lTry.status} ${lTry.data.error}`);
    const lateCard = (await asA("GET", "/catalog/vendors")).data.vendors?.find((v: { id: string }) => v.id === late.data.id);
    t.ok("after go-live: Catalog → Vendors offers nothing and says why in a sentence", !!lateCard && !lateCard.can_approve && !lateCard.setup_approve && /gone live/.test(lateCard.setup_note ?? ""), lateCard?.setup_note);
    const apAfter = (await asA("GET", "/approvals")).data;
    const lRow = apAfter.others?.find((r: { id: string }) => r.id === lReq);
    t.ok("after go-live: the Approvals screen offers nothing and says why", !apAfter.mine?.some((r: { id: string }) => r.id === lReq) && /gone live/.test(lRow?.why ?? "") && apAfter.setupMode?.live === true, lRow?.why);
    const sqlAfter = (await rows<{ w: string }>(t, `select setup_approve_refusal($1, $2, array['owner'], 'vendor', $3, $4) w`, [A.entityId, A.ownerId, late.data.id, session]))[0].w;
    t.ok("after go-live: the database says the same", /gone live/.test(sqlAfter), sqlAfter);
    await call("POST", "/api/platform/support/end", { cookie, body: {} });

    // ======================================================= the install-wide API token (x-erp-as) is support too
    const asB = (method: string, path: string, body?: unknown) => call(method, `/api/c/${B.entityId}${path}`, { token: true, as: B.ownerId, body });
    const bv = await asB("POST", "/vendors", { name: `Ashley Furniture ${B.tag}`, category: merch.code, merchandise: true, contactPhone: "555-555-0102" });
    const bvReq = await reqFor(B, "vendor", String(bv.data.id));
    const bvCard = (await asB("GET", "/catalog/vendors")).data.vendors?.find((v: { id: string }) => v.id === bv.data.id);
    const bvOk = await asB("POST", `/approvals/${bvReq}`, { decision: "approved" });
    const bvSteps = bvReq ? await stepOf(bvReq) : [];
    t.ok("install token: before go-live it approves a new vendor as ERP setup (marked install-token)",
      bvCard?.setup_approve === true && bvOk.status === 200 && bvOk.data.status === "approved" && bvSteps.every((s) => s.setup_session === "install-token" && s.setup_by === "install-wide API token"),
      `${bvOk.status} ${bvOk.data.error ?? ""} ${JSON.stringify(bvSteps)}`);
    const bb = await asB("POST", `/vendors/${bv.data.id}/bank`, { bankName: "First Test Bank", routingLast4: "4321", accountLast4: "8765", heldAt: "the bank's payee record", reason: "letter" });
    const bbReq = await reqFor(B, "vendor_bank_account", String(bb.data.id));
    const bbTry = await asB("POST", `/approvals/${bbReq}`, { decision: "approved", note: "called", callback: true, confirm: `Ashley Furniture ${B.tag}` });
    t.ok("install token: it is refused on a vendor bank account (setup types only)", bbTry.status === 409 && /support mode never self-approves/.test(String(bbTry.data.error)), `${bbTry.status} ${bbTry.data.error}`);
    await tx({ kind: "user", id: B.ownerId, label: "Owner" }, (c) => c.query(`insert into company_go_live (tenant_id, entity_id, by_label, by_id) values ($1, $2, 'Owner', $3)`, [B.tenantId, B.entityId, B.ownerId]));
    const bv2 = await asB("POST", "/vendors", { name: `After Live ${B.tag}`, category: merch.code, merchandise: true });
    const bv2Req = await reqFor(B, "vendor", String(bv2.data.id));
    const bv2Try = await asB("POST", `/approvals/${bv2Req}`, { decision: "approved" });
    t.ok("install token: after go-live it is refused on a vendor too", bv2Try.status === 409 && /gone live/.test(String(bv2Try.data.error)), `${bv2Try.status} ${bv2Try.data.error}`);

    // ======================================================= both recorded
    const live = await read(t, async (c) => (await q<{ a: boolean; b: boolean }>(c, `select company_went_live($1) a, company_went_live($2) b /* unscoped: check */`, [A.entityId, B.entityId]))[0]);
    t.ok("go-live: company_went_live() sees both recorded go-lives", live.a && live.b);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (saved.logins === undefined) delete process.env.ERP_LOGINS; else process.env.ERP_LOGINS = saved.logins;
    if (saved.token === undefined) delete process.env.ERP_API_TOKEN; else process.env.ERP_API_TOKEN = saved.token;
  }
}
