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
  const call = async (method: string, path: string, o: { body?: unknown; cookie?: string | null; as?: string; token?: boolean; reason?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { "x-erp-page": "1", "x-forwarded-for": "198.51.100.91" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.cookie) headers.cookie = o.cookie;
    if (o.as) headers["x-erp-as"] = o.as;
    if (o.token) headers.authorization = `Bearer ${process.env.ERP_API_TOKEN}`;
    if (o.reason) headers["x-erp-reason"] = o.reason;
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

    const supTx = <R>(fn: (c: Client) => Promise<R>) => tx({ kind: "user", id: A.ownerId, label: "opsy (support) as Owner", support: session }, fn);
    // review of 0066: journal entries and periods are not setup types (no flow opens those requests)
    const ob1 = await asA("POST", "/onboarding/opening-bank", { bankAccountId: bank, asOf: A.today, amount: "12500.00" });
    const openJe = (await rows<{ id: string }>(t, `select journal_entry_id id from opening_bank_balance where entity_id = $1`, [A.entityId]))[0]?.id;
    const jReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "journal_entry", subjectId: openJe, amountMinor: 1_250_000n, makerId: A.ownerId })) as { requestId: string };
    const jTry = await asA("POST", `/approvals/${jReq.requestId}`, { decision: "approved" });
    const period = (await rows<{ id: string }>(t, `select id from fiscal_period where entity_id = $1 order by starts_on limit 1`, [A.entityId]))[0]?.id;
    const pReq = await supTx((c) => AP.openRequest(c, A.scope, { subjectType: "fiscal_period", subjectId: period, amountMinor: null, makerId: A.ownerId })) as { requestId: string };
    const pTry = await asA("POST", `/approvals/${pReq.requestId}`, { decision: "approved" });
    t.ok("setup types: an opening-balance entry and an accounting period are not ERP setup's to approve (vendors and new hires only)",
      ob1.status === 200 && jTry.status === 409 && /only setup records \(a new vendor, a new hire\)/.test(String(jTry.data.error)) && pTry.status === 409 && /only setup records/.test(String(pTry.data.error)),
      `${ob1.status} ${jTry.status} ${jTry.data.error} | ${pTry.status}`);
    t.ok("setup types: the code says the same list", AP.SETUP_TYPES.join(",") === "vendor,employee");

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

    // ---- review of 0066: nothing from support mode mints an identity that is not support mode
    {
      const { createApiToken } = await import("../../server/platform.ts");
      const own = await tx(SYS, (c) => createApiToken(c, { actor: "owner@example.com", kind: "customer" }, A.tenantId, `Owner integration ${A.tag}`));
      const rot = await call("POST", `/api/tenant/tokens/${own.id}/rotate`, { cookie, body: {} });
      const inv = await call("POST", "/api/tenant/users", { cookie, body: { name: "Op Self", email: `op-${A.tag}@example.com`, entityId: A.entityId, roles: ["controller"] } });
      const ownerLogin = (await rows<{ id: string }>(t, `select id from platform_login where tenant_id = $1 /* unscoped: check */`, [A.tenantId]))[0].id;
      const reinv = await call("POST", `/api/tenant/users/${ownerLogin}/invite`, { cookie, body: {} });
      const viaInstall = await call("POST", "/api/tenant/tokens", { token: true, body: { name: "install probe" } });
      t.ok("tokens: in support mode rotating a token (it shows the new secret), inviting someone and sending an invite link are refused (403)",
        rot.status === 403 && !rot.data.token && inv.status === 403 && reinv.status === 403 && !reinv.data.inviteLink, `${rot.status} ${inv.status} ${reinv.status}`);
      t.ok("tokens: the install-wide token cannot make a customer API token either (403)", viaInstall.status === 403, `${viaInstall.status} ${viaInstall.data.error}`);
      const revoke = await call("POST", `/api/tenant/tokens/${own.id}/revoke`, { cookie, body: {} });
      t.ok("tokens: revoking a token is still allowed in support mode", revoke.status === 200, `${revoke.status} ${revoke.data.error}`);
      // a token made in support mode before this fix: flagged for the ERP team on the customer's detail
      const old = await tx(SYS, (c) => createApiToken(c, { actor: "opsy", kind: "operator", supportId: session }, A.tenantId, `Made in support ${A.tag}`));
      const detail = await call("GET", `/api/platform/customers/${A.tenantId}`, { cookie });
      const flag = (detail.data.tokensMadeInSupport as { id: string; active: boolean }[] | undefined)?.find((k) => k.id === old.id);
      const migSql = readFileSync(ROOT + "db/migrations/0066_setup_approvals.sql", "utf8");
      t.ok("tokens: a token made in support mode is flagged on the customer (still active, revoke it with the owner), and 0066 flags the old ones on the platform log",
        detail.status === 200 && flag?.active === true && /'token\.made_in_support'/.test(migSql), JSON.stringify(flag));
      const acct = await call("GET", "/api/tenant/tokens", { cookie });
      t.ok("tokens: the Account screen marks it as made in support mode",
        (acct.data as unknown as { id: string; made_in_support: boolean }[]).find?.((k) => k.id === old.id)?.made_in_support === true
        && /k\.made_in_support \? chip\('critical', 'warn', 'Made in support mode'\)/.test(readFileSync(ROOT + "server/ui/platform.js", "utf8")));
      // 0066 revokes them (the same function it runs at migration time): the token stops working, the flag row is kept
      const worksBefore = await fetch(`${base}/api/clients`, { headers: { authorization: `Bearer ${old.token}`, "x-forwarded-for": "198.51.100.91" } });
      const n = await tx(SYS, async (c) => (await q<{ n: number }>(c, `select revoke_support_made_tokens('check: 0066') n /* unscoped: check */`))[0].n);
      const worksAfter = await fetch(`${base}/api/clients`, { headers: { authorization: `Bearer ${old.token}`, "x-forwarded-for": "198.51.100.91" } });
      const flagRow = await rows<{ detail: { active: boolean } }>(t, `select detail from platform_audit where tenant_id = $1 and action = 'token.made_in_support' and detail->>'tokenId' = $2 /* unscoped: check */`, [A.tenantId, old.id]);
      t.ok("tokens: 0066 revokes tokens made in support mode: the token stops working (401), and the flag row says it was active",
        worksBefore.status === 200 && n >= 1 && worksAfter.status === 401 && flagRow[0]?.detail.active === true && /select revoke_support_made_tokens\('migration 0066/.test(migSql),
        `${worksBefore.status} ${n} ${worksAfter.status} ${JSON.stringify(flagRow[0])}`);
      // no new owner from support mode or the console
      const addOwner = await asA("POST", "/setup/people", { name: "Second Owner", email: `owner2-${A.tag}@example.com`, roles: ["owner"] });
      const addClerk = await asA("POST", "/setup/people", { name: "Setup Clerk", email: `clerk-${A.tag}@example.com`, roles: ["ap_clerk"] });
      const promote = await asA("POST", `/setup/people/${addClerk.data.id}/roles`, { roles: ["owner"] });
      t.ok("owners: support mode cannot add an owner or make someone an owner (409, in a sentence); other people are fine",
        addOwner.status === 409 && /never makes someone an owner/.test(String(addOwner.data.error)) && addClerk.status === 200 && promote.status === 409 && /never makes someone an owner/.test(String(promote.data.error)),
        `${addOwner.status} ${addOwner.data.error} | ${addClerk.status} | ${promote.status}`);
      const coOwner = await call("POST", "/api/companies", { cookie, body: { name: "Second Co", legalName: "Second Co LLC", state: "TX", setup: "pack:furniture",
        people: [{ name: "New Owner", email: `newowner-${A.tag}@example.com`, roles: ["owner"] }] } });
      t.ok("owners: adding a company in support mode cannot name a new owner (403)", coOwner.status === 403 && /never makes someone an owner/.test(String(coOwner.data.error)), `${coOwner.status} ${coOwner.data.error}`);
      const consoleOwner = await call("POST", `/api/platform/customers/${A.tenantId}/users`, { cookie, body: { name: "Console Owner", email: `cons-${A.tag}@example.com`, entityId: A.entityId, roles: ["owner"] } });
      t.ok("owners: the Operator console cannot invite another owner (409)", consoleOwner.status === 409 && /does not add owners/.test(String(consoleOwner.data.error)), `${consoleOwner.status} ${consoleOwner.data.error}`);
      const consoleLink = await call("POST", `/api/platform/customers/${A.tenantId}/logins/${ownerLogin}/invite`, { cookie, body: {} });
      const shown = await rows(t, `select 1 from platform_audit where tenant_id = $1 and action = 'invite.link_shown' /* unscoped: check */`, [A.tenantId]);
      t.ok("invites: the console shows an invite link only when no email is connected, and the platform log says it was shown",
        consoleLink.status === 200 && !!consoleLink.data.inviteLink && consoleLink.data.emailed === false && shown.length > 0, `${consoleLink.status} ${consoleLink.data.error ?? ""}`);
      // final review: the install-wide token never gets an invite link (the console routes refuse it; createCustomer hides it)
      const tokInvite = await call("POST", `/api/platform/customers/${A.tenantId}/users`, { token: true, body: { name: "Tok Person", email: `tok-${A.tag}@example.com`, entityId: A.entityId, roles: ["sales"] } });
      const tokReinvite = await call("POST", `/api/platform/customers/${A.tenantId}/logins/${ownerLogin}/invite`, { token: true, body: {} });
      const tokCustomer = await call("POST", "/api/platform/customers", { token: true, body: { tenantName: `Token Made ${A.tag}`, legalName: `Token Made ${A.tag} LLC`, state: "TX",
        pack: "furniture", ownerName: "Tok Owner", ownerEmail: `tokowner-${A.tag}@example.com`, plan: "standard" } });
      t.ok("install token: the console's invite routes refuse it (403, in a sentence), and a customer it makes comes back with no invite link",
        tokInvite.status === 403 && !tokInvite.data.inviteLink && /not the install-wide API token/.test(String(tokInvite.data.error)) && tokReinvite.status === 403 && !tokReinvite.data.inviteLink
        && tokCustomer.status === 200 && !tokCustomer.data.inviteLink, `${tokInvite.status} ${tokReinvite.status} ${tokCustomer.status} link=${!!tokCustomer.data.inviteLink}`);
      // final review: a password set from a link the ERP team handled is logged and told to the owner in the digest
      const tokenOf = (link: string) => link.split("#invite=")[1];
      const accepted = await call("POST", "/account/accept", { body: { token: tokenOf(String(consoleLink.data.inviteLink)), password: "setup-owner-pass-1" } });
      const handledRows = await rows(t, `select 1 from platform_audit where tenant_id = $1 and action = 'login.set_from_handled_link' /* unscoped: check */`, [A.tenantId]);
      const signin = (await read(t, (c) => OD.selfApprovals(c, A.entityId, started, new Date().toISOString()))).find((i) => i.flow === "signin");
      t.ok("handled link: setting the password from a link shown to an operator writes a platform-log row and a digest line for the owner",
        accepted.status === 200 && handledRows.length === 1 && signin?.detail === "Your sign-in was set up from a link your ERP setup team handled; if you didn't set this password, reset it.",
        `${accepted.status} ${accepted.data.error ?? ""} ${handledRows.length} ${signin?.detail}`);
      const fromEmail = await rows(t, `select 1 from platform_audit where tenant_id = $1 and action = 'login.set_from_handled_link' /* unscoped: check */`, [B.tenantId]);
      t.ok("handled link: nothing is logged for a customer whose links were never shown to an operator", fromEmail.length === 0);
    }

    // ---- review of 0066: setup mode ends 60 days after the first setup approval; the countdown on the console and the banner
    {
      const P = await import("../../server/platform.ts");
      const st = (await read(t, (c) => P.setupStatus(c, A.tenantId))).find((x) => x.entityId === A.entityId);
      const card = ((await call("GET", "/api/platform/customers", { cookie })).data as unknown as { id: string; setup: { daysLeft: number | null; live: boolean }[] }[]).find((x) => x.id === A.tenantId);
      const me = (await call("GET", "/api/me", { cookie })).data;
      const bannerSt = (me.viewer?.support?.setup as { entityId: string; daysLeft: number }[] | undefined)?.find((x) => x.entityId === A.entityId);
      t.ok("60 days: the countdown is 60 days from the first setup approval, on the Operator console card and in the support banner",
        !!st && !st.live && (st.daysLeft === 60 || st.daysLeft === 59) && card?.setup.some((x) => x.daysLeft === st.daysLeft) === true && bannerSt?.daysLeft === st.daysLeft,
        JSON.stringify({ st, banner: bannerSt }));
      // the 60 days run on the database's own clock (now()), so the check moves the first setup approval back, not the clock
      const later = await read(t, async (c) => {
        await c.query("begin");
        try {
          await c.query(`update approval_step s set decided_at = s.decided_at - interval '61 days' from approval_request r
                          where r.id = s.request_id and r.entity_id = $1 and s.setup_session is not null`, [A.entityId]);
          return (await q<{ w: string | null }>(c, `select setup_approve_refusal($1, $2, array['owner'], 'vendor', $3, $4) w /* unscoped: check */`, [A.entityId, A.ownerId, randomUUID(), session]))[0].w;
        } finally { await c.query("rollback"); }
      });
      t.ok("60 days: after 60 days ERP setup is refused, saying when its 60 days ended", /60 days for this company ended on/.test(later ?? ""), String(later));
      const pinned = await read(t, async (c) => {
        await c.query("begin");
        try {
          await c.query("select set_config('erp.now', (now() + interval '61 days')::text, true)");
          return (await q<{ w: string | null }>(c, `select setup_approve_refusal($1, $2, array['owner'], 'vendor', $3, $4) w /* unscoped: check */`, [A.entityId, A.ownerId, randomUUID(), session]))[0].w;
        } finally { await c.query("rollback"); }
      });
      t.ok("60 days: a pinned business clock (erp.now) does not move the 60 days", !/60 days/.test(pinned ?? ""), String(pinned));
      const plJs = readFileSync(ROOT + "server/ui/platform.js", "utf8");
      t.ok("60 days: the console card carries the countdown chip and the banner shows the days left",
        /badge: E\.frag\(statusChip\(t\), setupChip\(t\.setup\)\)/.test(plJs) && /Setup: \$\{plural\(st\.daysLeft, 'day'\)\} left/.test(appJs));
    }

    // ---- the owner's digest and the go-live review list
    const items = await read(t, (c) => OD.selfApprovals(c, A.entityId, started, new Date().toISOString()));
    const setupItems = items.filter((i) => i.flow === "setup");
    const hireLine = setupItems.find((i) => (i.link ?? "").startsWith("person:"));
    t.ok("digest: the owner's digest lists what ERP setup approved (the vendor and the hire, each named), marked (approved during setup) and naming the operator",
      ["vendor:", "person:"].every((k) => setupItems.some((i) => (i.link ?? "").startsWith(k))) && setupItems.every((i) => /approved during setup/.test(i.detail) && /ERP setup \(opsy\)/.test(i.by ?? ""))
      && setupItems.some((i) => i.title === `New vendor · ${ashleyName}`) && hireLine?.title === `New hire · Dana Setup${A.tag}`,
      JSON.stringify(setupItems.map((i) => [i.title, i.link, i.by])));
    t.ok("digest: the hire's line shows the pay rate ($18.50 an hour), not a yearly figure", /pay \$18\.50 an hour/.test(hireLine?.detail ?? "") && hireLine?.amountMinor === null, hireLine?.detail);
    const dig = await tx(SYS, (c) => OD.makeDigest(c, { ...A.scope, actor: SYS }, new Date()));
    const note = (await rows<{ title: string; body: string; items: { flow: string }[] }>(t, `select title, body, items from owner_notification where entity_id = $1 order by created_at desc limit 1`, [A.entityId]))[0];
    t.ok("digest: the daily digest is made for them, its text saying \"approved during setup\" and the support session",
      dig.made && !!note && /approved during setup/.test(note.title) && note.body.includes(`support session ${session}`) && note.items.filter((i) => i.flow === "setup").length >= 2, `${dig.note} | ${note?.title}`);
    t.ok("digest: for setup approvals the footer says the ERP setup team approved them, not the change-your-password line",
      /approved by your ERP setup team during onboarding; tell them if anything looks wrong/.test(note?.body ?? "") && !/change your password/.test(note?.body ?? ""), note?.body.split("\n").slice(-2).join(" / "));
    const cl = await read(t, (c) => ob.checklist(c, A.tenantId, A.entityId));
    const review = cl.setupApprovals;
    const kinds = new Set(review.map((r) => r.kind));
    t.ok("go-live review: the Go-live step lists everything approved during setup (vendors, employees), each with its record; the hire with its pay rate",
      ["Vendors", "Employees"].every((k) => kinds.has(k)) && kinds.size === 2 && review.every((r) => !!r.link && /ERP setup \(opsy\)/.test(r.detail))
      && review.some((r) => r.kind === "Employees" && r.pay === "$18.50 an hour" && /pay \$18\.50 an hour/.test(r.detail))
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
      () => tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: null })), /reviewed what ERP setup approved/);
    // review of 0066: the operator mints a tenant API token in support mode; with it, "as the owner", Go live is refused
    const refusedMint = await call("POST", "/api/tenant/tokens", { cookie, body: { name: `Probe app ${A.tag}` } });
    t.ok("tokens: an operator in support mode cannot make a customer API token (403, no secret back)", refusedMint.status === 403 && !refusedMint.data.token
      && /support mode cannot do it/.test(String(refusedMint.data.error)), `${refusedMint.status} ${refusedMint.data.error}`);
    // a token the owner made themselves, used "as the owner": still not the owner signed in
    const { createApiToken } = await import("../../server/platform.ts");
    const minted = { data: await tx(SYS, (c) => createApiToken(c, { actor: "owner@example.com", kind: "customer" }, A.tenantId, `Owner app ${A.tag}`)) };
    const viaToken = await fetch(`${base}/api/c/${A.entityId}/onboarding/go-live`, { method: "POST", headers: { "content-type": "application/json", "x-erp-page": "1",
      "x-erp-as": A.ownerId, authorization: `Bearer ${minted.data.token}`, "x-forwarded-for": "198.51.100.91" }, body: JSON.stringify({ reviewed: review.map((r) => r.requestId) }) });
    const viaTokenErr = String(((await viaToken.json()) as { error?: string }).error ?? "");
    t.ok("go-live: a tenant API token acting as the owner cannot press Go live (only the owner signed in as themselves)", !!minted.data.token && viaToken.status === 409 && /signed in as themselves/.test(viaTokenErr), `${viaToken.status} ${viaTokenErr}`);
    // review of 0066: ERP setup approves one more after the owner opened the list; the old tick no longer covers it
    const raceV = await asA("POST", "/vendors", { name: `Race Vendor ${A.tag}`, category: merch.code, merchandise: true });
    const lateReq = await reqFor(A, "vendor", String(raceV.data.id));
    const lateOk = await asA("POST", `/approvals/${lateReq}`, { decision: "approved" });
    await t.throws("go-live: something ERP setup approved after the owner opened the list sends them back to it",
      () => tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: review.map((r) => r.requestId) })), /approved 1 more since you opened this list/);
    t.ok("go-live: (that late approval was a setup approval)", lateOk.status === 200 && lateOk.data.status === "approved", `${lateOk.status} ${lateOk.data.error ?? ""}`);
    review.push(...(await read(t, (c) => ob.setupApprovals(c, A.entityId))).filter((r) => r.requestId === lateReq));
    // review of 0066: a setup approval in flight when the owner presses Go live: go-live waits for it, then lists it and refuses (no write skew)
    {
      const skewV = await asA("POST", "/vendors", { name: `Skew Vendor ${A.tag}`, category: merch.code, merchandise: true });
      const skewReq = await reqFor(A, "vendor", String(skewV.data.id));
      const c1 = await t.pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('erp.support', $1, true)", [session]);
      await c1.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now(), setup_session = $3 where request_id = $1 and decision is null /* unscoped: check */`, [skewReq, A.ownerId, session]);
      let waited = "";
      const goLiveTx = tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: review.map((r) => r.requestId) }))
        .then(() => { waited = "went live"; }, (e: Error) => { waited = e.message; });
      await new Promise((r) => setTimeout(r, 400));
      const stillWaiting = waited === "";
      await c1.query(`update approval_request set status = 'approved', decided_at = now() where id = $1 /* unscoped: check */`, [skewReq]);
      await c1.query("commit"); c1.release();
      await goLiveTx;
      t.ok("go-live: a setup approval in flight when the owner presses Go live: go-live waits, then lists it and sends the owner back", stillWaiting && /approved 1 more/.test(waited), `${stillWaiting} ${waited}`);
      review.push(...(await read(t, (c) => ob.setupApprovals(c, A.entityId))).filter((r) => r.requestId === skewReq));
    }
    const went = await tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: review.map((r) => r.requestId) }));
    const gl = (await rows<{ setup_items: number; reviewed_setup: boolean }>(t, `select setup_items, reviewed_setup from company_go_live where entity_id = $1`, [A.entityId]))[0];
    t.ok("go-live: the owner ticks the review and goes live; recorded with what was reviewed", went.wentLive && gl?.reviewed_setup === true && gl.setup_items === review.length, JSON.stringify(gl));
    await t.throws("go-live: it cannot be undone (no delete)", () => tx(SYS, (c) => c.query(`delete from company_go_live where entity_id = $1`, [A.entityId])), /append-only/);
    await t.throws("go-live: nor emptied (truncate)", () => tx(SYS, (c) => c.query(`truncate company_go_live`)), /append-only/);
    await t.throws("go-live: nor changed", () => tx(SYS, (c) => c.query(`update company_go_live set went_live_at = now() - interval '1 day' where entity_id = $1`, [A.entityId])), /append-only/);
    await t.throws("go-live: nor pressed twice", () => tx({ kind: "user", id: A.ownerId, label: "Owner" }, (c) => ob.goLive(c, A.scope, { reviewed: [] })), /already gone live/);

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
    const noReason = await asB("POST", `/approvals/${bvReq}`, { decision: "approved" });
    t.ok("install token: a setup approval without an x-erp-reason header is refused (409, in a sentence)", noReason.status === 409 && /x-erp-reason/.test(String(noReason.data.error)), `${noReason.status} ${noReason.data.error}`);
    const WHY = "onboarding import for ticket 4471";
    const bvOk = await call("POST", `/api/c/${B.entityId}/approvals/${bvReq}`, { token: true, as: B.ownerId, reason: WHY, body: { decision: "approved" } });
    const bvSteps = bvReq ? await stepOf(bvReq) : [];
    const bvAud = await rows<{ reason: string }>(t, `select reason from audit_event where entity_id = $1 and table_name = 'approval_request' and row_id = $2`, [B.entityId, bvReq]);
    t.ok("install token: with its reason, before go-live it approves a new vendor as ERP setup (marked install-token, the reason recorded on the step and the audit row)",
      bvCard?.setup_approve === true && bvOk.status === 200 && bvOk.data.status === "approved" && bvSteps.every((s) => s.setup_session === "install-token" && s.setup_by === "install-wide API token" && s.setup_reason === WHY)
      && bvAud.some((r) => r.reason.includes(WHY)), `${bvOk.status} ${bvOk.data.error ?? ""} ${JSON.stringify(bvSteps)}`);
    const bb = await asB("POST", `/vendors/${bv.data.id}/bank`, { bankName: "First Test Bank", routingLast4: "4321", accountLast4: "8765", heldAt: "the bank's payee record", reason: "letter" });
    const bbReq = await reqFor(B, "vendor_bank_account", String(bb.data.id));
    const bbTry = await asB("POST", `/approvals/${bbReq}`, { decision: "approved", note: "called", callback: true, confirm: `Ashley Furniture ${B.tag}` });
    t.ok("install token: it is refused on a vendor bank account (setup types only)", bbTry.status === 409 && /support mode never self-approves/.test(String(bbTry.data.error)), `${bbTry.status} ${bbTry.data.error}`);
    await tx({ kind: "user", id: B.ownerId, label: "Owner" }, (c) => c.query(`insert into company_go_live (tenant_id, entity_id, by_label, by_id) values ($1, $2, 'Owner', $3)`, [B.tenantId, B.entityId, B.ownerId]));
    const bv2 = await asB("POST", "/vendors", { name: `After Live ${B.tag}`, category: merch.code, merchandise: true });
    const bv2Req = await reqFor(B, "vendor", String(bv2.data.id));
    const bv2Try = await call("POST", `/api/c/${B.entityId}/approvals/${bv2Req}`, { token: true, as: B.ownerId, reason: WHY, body: { decision: "approved" } });
    t.ok("install token: after go-live it is refused on a vendor too", bv2Try.status === 409 && /gone live/.test(String(bv2Try.data.error)), `${bv2Try.status} ${bv2Try.data.error}`);

    // ======================================================= both recorded
    const live = await read(t, async (c) => (await q<{ a: boolean; b: boolean }>(c, `select company_went_live($1) a, company_went_live($2) b /* unscoped: check */`, [A.entityId, B.entityId]))[0]);
    t.ok("go-live: company_went_live() sees both recorded go-lives", live.a && live.b);
    const demoLive = await read(t, async (c) => (await q<{ l: boolean }>(c, `select company_went_live('22222222-2222-2222-2222-222222222222') l /* unscoped: check */`))[0].l);
    t.ok("demo: the demo company is live (seeded), so a demo reset keeps it live", demoLive && /insert into company_go_live/.test(readFileSync(ROOT + "db/seed/0037_demo_live.sql", "utf8")));
    // review of 0066: money taken in (a receipt, a deposit, a bill) counts as trading, not only a handed-over sale
    const C = await freshCompany(t, "Deposit Furniture");
    const before = await read(t, async (c) => (await q<{ l: boolean }>(c, `select company_went_live($1) l /* unscoped: check */`, [C.entityId]))[0].l);
    const cash = (await rows<{ code: string }>(t, `select g.code from bank_account b join gl_account g on g.id = b.gl_account_id where b.entity_id = $1 limit 1`, [C.entityId]))[0].code;
    await tx({ kind: "user", id: C.ownerId, label: "Owner" }, (c) => post(c, C.scope, { date: C.today, sourceType: "receipt", sourceId: null, description: "Deposit on a sofa",
      lines: [{ code: cash, debit: 50000n }, { code: "2300", credit: 50000n }] }));
    const after = await read(t, async (c) => (await q<{ l: boolean }>(c, `select company_went_live($1) l /* unscoped: check */`, [C.entityId]))[0].l);
    t.ok("go-live: a company that has taken a deposit (a receipt, no sale yet) counts as live", before === false && after === true, `${before} ${after}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (saved.logins === undefined) delete process.env.ERP_LOGINS; else process.env.ERP_LOGINS = saved.logins;
    if (saved.token === undefined) delete process.env.ERP_API_TOKEN; else process.env.ERP_API_TOKEN = saved.token;
  }
}
