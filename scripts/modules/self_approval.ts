// Self-approval, followed through (migration 0063).
//
//   1. support mode never self-approves for the owner (code, the read, the
//      database, and the real route); self-approving new vendor bank details,
//      a payment run or a payroll run needs the payee or the total typed; the
//      daily owner digest lists every self-approval and any role taken away in
//      the 24 hours before one, on Home and by email when email is connected,
//      never for the demo or a suspended customer.
//   2. stock counts, A/R write-offs, vendor debit memos and time off no longer
//      dead-end in a one-owner company: the owner decides their own, marked
//      self-approved with an audit row, and a company with a controller still
//      refuses (in code and in the database). Code and SQL say the same rule.
//   3. long words (emails, addresses, fingerprints) wrap on a phone.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { T } from "./harness.ts";
import { tx, q, markSupport, type Client, type Scope } from "../../packages/core/db.ts";
import { companyOf } from "./catalog.ts";
import type { Actor, Company } from "../../server/modules/kit.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SYS = { kind: "system" as const, label: "check" };

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
const rows = <R extends Record<string, any> = Record<string, unknown>>(t: T, sql: string, args: unknown[] = []) => read(t, (c) => q<R>(c, sql + (/unscoped/.test(sql) ? "" : " /* unscoped: check */"), args));

type Co = { tag: string; tenantId: string; entityId: string; ownerId: string; co: Company; a: Actor; scope: Scope;
  as: <X>(fn: (c: Client) => Promise<X>) => Promise<X>; store: string; today: string };

/** A fresh customer: one furniture company, one store, its owner and nobody else. */
async function freshCompany(t: T, label: string): Promise<Co> {
  const { createCustomer } = await import("../../server/platform.ts");
  const tag = randomBytes(3).toString("hex");
  const made = await tx(SYS, (c) => createCustomer(c, { actor: "check", kind: "operator" },
    { tenantName: `${label} ${tag}`, legalName: `${label} LLC ${tag}`, state: "TX", pack: "furniture", ownerEmail: `owner-${tag}@example.com`, plan: "standard" }, "https://erp.example"));
  const co = await companyOf(t, made.entityId);
  const a: Actor = { personId: made.ownerId, personName: "Owner", label: "Owner" };
  const scope: Scope = { tenantId: made.tenantId, entityId: made.entityId, actor: { kind: "user", id: made.ownerId, label: "Owner" } };
  const store = (await rows<{ id: string }>(t, `select id from location where entity_id = $1 order by code limit 1`, [made.entityId]))[0].id;
  const today = (await rows<{ d: string }>(t, `select business_today($1)::text d`, [made.entityId]))[0].d;
  return { tag, tenantId: made.tenantId, entityId: made.entityId, ownerId: made.ownerId, co, a, scope, store, today,
    as: (fn) => tx({ kind: "user", id: made.ownerId, label: "Owner" }, fn) };
}

/** What every flow needs, made directly (setup, not under test): a vendor, an open customer invoice, the owner as an employee, a leave type. */
async function flowSetup(t: T, x: Co) {
  return tx(SYS, async (c) => {
    const v = (await q<{ id: string }>(c, `insert into vendor (tenant_id, legal_name, status, contact_phone) values ($1, $2, 'active', '555-555-0101') returning id /* unscoped: new vendor */`, [x.tenantId, `Short Shippers ${x.tag}`]))[0].id;
    await c.query(`insert into vendor_entity (vendor_id, entity_id, status) values ($1, $2, 'active')`, [v, x.entityId]);
    const cu = (await q<{ id: string }>(c, `insert into customer (entity_id, number, name) values ($1, 'C-1', 'Gone Away') returning id`, [x.entityId]))[0].id;
    const inv = (await q<{ id: string }>(c, `insert into customer_invoice (entity_id, number, invoice_date, due_date, customer_id, kind, subtotal_minor, total_minor, charged_minor)
      values ($1, 'OB-1', $2, $2, $3, 'opening', 10000, 10000, 10000) returning id`, [x.entityId, x.today, cu]))[0].id;
    await c.query(`insert into ar_ledger (entity_id, customer_id, invoice_id, occurred_on, kind, amount_minor) values ($1, $2, $3, $4, 'opening', 10000)`, [x.entityId, cu, inv, x.today]);
    const emp = (await q<{ id: string }>(c, `insert into employee (tenant_id, entity_id, employee_no, first_name, last_name, hired_on, pay_type, base_rate_minor, work_state, app_user_id, status)
      values ($1, $2, 'E-1', 'Owner', 'Self', $3, 'salary', 6000000, 'TX', $4, 'active') returning id`, [x.tenantId, x.entityId, x.today, x.ownerId]))[0].id;
    const LV = await import("../../packages/core/leave.ts");
    const lt = await LV.saveLeaveType(c, x.scope, { code: "UNP", name: "Unpaid", kind: "unpaid", allowNegative: true }) as { id: string };
    return { vendorId: v, invoiceId: inv, employeeId: emp, leaveTypeId: lt.id };
  });
}
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export async function run(t: T) {
  const AP = await import("../../packages/core/approvals.ts");
  const act = await import("../../server/actions.ts");
  const views = await import("../../server/views.ts");
  const inv = await import("../../packages/core/inventory.ts");
  const ar = await import("../../packages/core/ar.ts");
  const DM = await import("../../packages/core/debit_memo.ts");
  const LV = await import("../../packages/core/leave.ts");
  const OD = await import("../../packages/core/owner_digest.ts");
  const { module: invModule } = await import("../../server/modules/inventory.ts");
  const { module: arModule } = await import("../../server/modules/ar.ts");

  /** A module's GET as a person (the real handler, with the person the route would pass). */
  const getAs = async <R>(mod: { register: (k: never) => void }, tail: string, entityId: string, personId: string): Promise<R> => {
    const gets = new Map<string, (...a: unknown[]) => Promise<unknown>>();
    mod.register({ coGet: (p: string, fn: never) => gets.set(p, fn), coPost: () => {}, publicRoute: () => {} } as never);
    return read(t, async (c) => (await gets.get(tail)!(c, await companyOf(t, entityId), new URL("http://x/"), ["", entityId], personId)) as R);
  };
  const audits = (x: Co, table: string, rowId: string) => rows<{ reason: string; after: Record<string, unknown> }>(t,
    `select reason, after from audit_event where entity_id = $1 and table_name = $2 and row_id = $3 order by id`, [x.entityId, table, rowId]);

  // ======================================================== company A: the owner alone
  const A = await freshCompany(t, "Solo Furniture");
  const sa = await flowSetup(t, A);
  const merch = (await rows<{ code: string }>(t, `select code from vendor_category where tenant_id = $1 and active and is_merchandise limit 1`, [A.tenantId]))[0];

  // ---- the engine: a vendor, then its new bank details (payee typed)
  const vend = await A.as((c) => act.addVendor(c, A.co, A.a, { name: `Ashton Imports ${A.tag}`, category: merch.code, merchandise: true }));
  const vReq = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_type = 'vendor' and subject_id = $2`, [A.entityId, vend.id]))[0].id;
  await A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: vReq, decision: "approved", note: "" }));
  await tx(SYS, (c) => c.query(`update vendor set contact_phone = '555-555-0199', dba = null where id = $1 /* unscoped: check setup */`, [vend.id]));
  const vName = `Ashton Imports ${A.tag}`;
  const bank = await A.as((c) => act.requestVendorBank(c, A.co, A.a, { vendorId: vend.id, bankName: "First Test Bank", routingLast4: "1234", accountLast4: "5678",
    heldAt: "the bank's payee record", reason: "letter on the vendor's letterhead" }));
  const bReq = (await rows<{ approval_request_id: string }>(t, `select approval_request_id from vendor_bank_account where id = $1 /* unscoped: by id */`, [bank.id]))[0].approval_request_id;
  const apA = await read(t, (c) => views.approvals(c, A.co, A.ownerId));
  const bRow = apA.mine.find((r: { id: string }) => r.id === bReq) as { self: boolean; confirm: { kind: string; expect: string } | null } | undefined;
  t.ok("typed confirmation: the owner's own bank change is theirs to decide, and the screen asks for the payee's name",
    !!bRow && bRow.self && bRow.confirm?.kind === "payee" && bRow.confirm.expect === vName, JSON.stringify(bRow?.confirm));
  await t.throws("typed confirmation: self-approving new bank details without typing the payee is refused",
    () => A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: bReq, decision: "approved", note: "called Dana", callback: true })), /type the payee's name/);
  await t.throws("typed confirmation: the wrong payee is refused",
    () => A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: bReq, decision: "approved", note: "called Dana", callback: true, confirm: "Ashton Exports" })), /type the payee's name/);
  const bOk = await A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: bReq, decision: "approved", note: "called Dana", callback: true, confirm: `  ${vName.toUpperCase()}  ` }));
  const bAud = await audits(A, "approval_request", bReq);
  t.ok("typed confirmation: the payee typed (any case, spaces trimmed) approves it, self-approved, the audit row saying it was typed",
    bOk.status === "approved" && bAud.some((r) => r.reason === "self-approved: no other approver" && r.after?.typedConfirmation === "payee"), JSON.stringify(bAud.map((r) => r.after)));

  // ---- a payment run (the total typed)
  const gl = (await rows<{ id: string }>(t, `select id from gl_account where tenant_id = $1 and is_postable and account_type = 'expense' order by code limit 1`, [A.tenantId]))[0].id;
  // setup: the bill is keyed by a former clerk (no longer active, so no second approver), and the owner lets it through the
  // gate (a new vendor has no template yet); the payment run is what is under test
  const clerk = (await rows<{ id: string }>(t, `insert into app_user (tenant_id, email, name, status) values ($1, $2, 'Former Clerk', 'disabled') returning id /* unscoped: check setup */`, [A.tenantId, `clerk-${A.tag}@example.com`]))[0].id;
  const bill = await tx({ kind: "user", id: clerk, label: "Former Clerk" }, (c) => act.newBill(c, A.co, { personId: clerk, personName: "Former Clerk", label: "Former Clerk" },
    { vendorId: vend.id, glAccountId: gl, reference: `B-${A.tag}`, invoiceDate: A.today, amount: "250.00" }));
  if (bill.status === "exception" || bill.status === "held") Object.assign(bill, await A.as((c) => act.acceptBill(c, A.co, A.a, { id: bill.id, reason: "first bill from a new vendor; checked against the PO" })));
  if (bill.status === "pending") {
    const r = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_id = $2 and status = 'open'`, [A.entityId, bill.id]))[0];
    await A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: r.id, decision: "approved", note: "" }));
  }
  const run0 = await A.as((c) => act.createPaymentRun(c, A.co, A.a, { payDate: A.today, method: "check", invoiceIds: [bill.id] })) as { id: string };
  await A.as((c) => act.submitPaymentRun(c, A.co, A.a, { id: run0.id }));
  const pReq = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_type = 'payment_run' and subject_id = $2`, [A.entityId, run0.id]))[0].id;
  const pRow = (await read(t, (c) => views.approvals(c, A.co, A.ownerId))).mine.find((r: { id: string }) => r.id === pReq) as { confirm: { kind: string; expect: string } | null } | undefined;
  t.ok("typed confirmation: the owner's own payment run asks for its total", pRow?.confirm?.kind === "amount" && pRow.confirm.expect === "$250.00", JSON.stringify(pRow?.confirm));
  await t.throws("typed confirmation: self-approving a payment run without the total is refused",
    () => A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: pReq, decision: "approved", note: "" })), /type its total exactly: \$250\.00/);
  await t.throws("typed confirmation: a different total is refused",
    () => A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: pReq, decision: "approved", note: "", confirm: "$25.00" })), /type its total/);
  const pOk = await A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: pReq, decision: "approved", note: "", confirm: "250" }));
  t.ok("typed confirmation: the run's total ($250.00 typed as 250) approves it", pOk.status === "approved");

  // ---- a payroll run's approval (the engine's check; the request stands in for a built run)
  const prReq = await A.as((c) => AP.openRequest(c, A.scope, { subjectType: "payroll_run", subjectId: randomUUID(), amountMinor: 123456n, makerId: A.ownerId })) as { requestId: string };
  await t.throws("typed confirmation: self-approving payroll without its total is refused",
    () => A.as((c) => AP.decide(c, A.scope, { requestId: prReq.requestId, actorId: A.ownerId, decision: "approved" })), /type its total exactly: \$1,234\.56/);
  const prOk = await A.as((c) => AP.decide(c, A.scope, { requestId: prReq.requestId, actorId: A.ownerId, decision: "approved", confirm: "1,234.56" }));
  t.ok("typed confirmation: payroll's total typed with a comma approves it", prOk === "approved");
  t.ok("typed confirmation: amounts parse to the cent, and nothing else passes",
    AP.typedMinor("$1,234.5") === 123450n && AP.typedMinor("1234") === 123400n && AP.typedMinor("12.345") === null && AP.typedMinor("ten") === null && AP.typedMinor("") === null);
  const rejOwn = await A.as((c) => AP.openRequest(c, A.scope, { subjectType: "payroll_run", subjectId: randomUUID(), amountMinor: 500n, makerId: A.ownerId })) as { requestId: string };
  t.ok("typed confirmation: turning your own run down needs nothing typed",
    (await A.as((c) => AP.decide(c, A.scope, { requestId: rejOwn.requestId, actorId: A.ownerId, decision: "rejected", note: "wrong period" }))) === "rejected");
  const appJs = readFileSync(ROOT + "server/app.js", "utf8");
  t.ok("typed confirmation: the screen asks for it before posting, and sends what was typed",
    /function askTypedConfirm\(a\)/.test(appJs) && /a\.self && a\.confirm\) \{\s*confirm = await askTypedConfirm\(a\)/.test(appJs) && /post\(`\/approvals\/\$\{a\.id\}`, \{ decision, note, callback, confirm \}\)/.test(appJs));

  // ---- support mode: never self-approves for the owner
  const vend2 = await A.as((c) => act.addVendor(c, A.co, A.a, { name: `Support Test Vendor ${A.tag}`, category: merch.code, merchandise: true }));
  const sReq = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_type = 'vendor' and subject_id = $2`, [A.entityId, vend2.id]))[0].id;
  const supActor = { kind: "user" as const, id: A.ownerId, label: "opsy (support) as Owner", support: randomUUID() };
  await t.throws("support mode: an operator acting as the owner cannot self-approve the owner's request (in code)",
    () => tx(supActor, (c) => act.decideRequest(c, A.co, { ...A.a, label: supActor.label }, { requestId: sReq, decision: "approved", note: "" })), /support mode never self-approves/);
  await t.throws("support mode: nor in any flow outside the engine (a count)", async () => {
    const ct = await A.as((c) => inv.createCount(c, A.scope, { locationId: A.store })) as { id: string };
    await A.as((c) => inv.submitCount(c, A.scope, ct.id, []));
    await tx(supActor, (c) => inv.decideCount(c, { ...A.scope, actor: supActor }, ct.id, { approve: true }));
  }, /support mode never self-approves/);
  await t.throws("support mode: the database refuses a self-approved step written under a support session too",
    () => tx(supActor, (c) => c.query(`update approval_step set decision = 'approved', actor_id = $2, decided_at = now(), self_approved = true where request_id = $1`, [sReq, A.ownerId])),
    /support mode never self-approves/);
  const supView = await read(t, async (c) => { markSupport(c, true); try { return await views.approvals(c, A.co, A.ownerId); } finally { markSupport(c, false); } });
  const sRow = supView.others.find((r: { id: string }) => r.id === sReq) as { why: string } | undefined;
  t.ok("support mode: the Approvals screen does not offer it, and says why", !supView.mine.some((r: { id: string }) => r.id === sReq) && /support mode/i.test(sRow?.why ?? ""), sRow?.why);
  t.ok("support mode: the same request is still the owner's own to decide when they sign in themselves",
    (await read(t, (c) => views.approvals(c, A.co, A.ownerId))).mine.some((r: { id: string }) => r.id === sReq));
  {
    // the real door: an operator signed in, in support mode, acting as the owner
    const saved = { logins: process.env.ERP_LOGINS, token: process.env.ERP_API_TOKEN };
    process.env.ERP_LOGINS = "opsy:operator-pass-123";
    process.env.ERP_API_TOKEN = saved.token && saved.token.length >= 32 ? saved.token : "t".repeat(48);
    const { createServer } = await import("../../server/index.ts");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, o: { body?: unknown; cookie?: string | null; as?: string } = {}) => {
      const headers: Record<string, string> = { "x-erp-page": "1", "x-forwarded-for": "198.51.100.77" };
      if (o.body !== undefined) headers["content-type"] = "application/json";
      if (o.cookie) headers.cookie = o.cookie;
      if (o.as) headers["x-erp-as"] = o.as;
      const r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const sc = r.headers.get("set-cookie");
      let data: Record<string, unknown> = {};
      try { data = await r.json() as Record<string, unknown>; } catch { /* empty */ }
      return { status: r.status, data, cookie: sc ? sc.split(";")[0] : null };
    };
    try {
      const op = (await call("POST", "/session", { body: { name: "opsy", key: "operator-pass-123" } })).cookie;
      const sup = await call("POST", `/api/platform/customers/${A.tenantId}/support`, { cookie: op, body: { reason: "check: self-approval in support mode" } });
      const cookie = sup.cookie ?? op;
      const tried = await call("POST", `/api/c/${A.entityId}/approvals/${sReq}`, { cookie, as: A.ownerId, body: { decision: "approved" } });
      t.ok("support mode: through the real route, the operator acting as the owner is refused in a sentence (409)",
        sup.status === 200 && tried.status === 409 && /support mode never self-approves/.test(String(tried.data.error)), `${sup.status} ${tried.status} ${tried.data.error}`);
      const list = await call("GET", `/api/c/${A.entityId}/approvals`, { cookie, as: A.ownerId });
      const lr = (list.data.others as { id: string; why: string }[] | undefined)?.find((r) => r.id === sReq);
      t.ok("support mode: and the route's Approvals list shows it as not theirs, saying why", list.status === 200 && /support mode/i.test(lr?.why ?? ""), lr?.why);
      const still = await rows<{ status: string }>(t, `select status from approval_request where entity_id = $1 and id = $2`, [A.entityId, sReq]);
      t.ok("support mode: nothing was decided", still[0]?.status === "open");
      await call("POST", "/api/platform/support/end", { cookie, body: {} });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (saved.logins === undefined) delete process.env.ERP_LOGINS; else process.env.ERP_LOGINS = saved.logins;
      if (saved.token === undefined) delete process.env.ERP_API_TOKEN; else process.env.ERP_API_TOKEN = saved.token;
    }
  }
  await A.as((c) => act.decideRequest(c, A.co, A.a, { requestId: sReq, decision: "approved", note: "" }));

  // ======================================================== the four flows, owner alone
  // stock count
  const ctA = await A.as((c) => inv.createCount(c, A.scope, { locationId: A.store })) as { id: string };
  await A.as((c) => inv.submitCount(c, A.scope, ctA.id, []));
  const cList = await getAs<{ id: string; self_ok: boolean }[]>(invModule, "/inventory/counts", A.entityId, A.ownerId);
  t.ok("count: the owner who counted sees it is theirs to approve (nobody else could)", !!cList.find((r) => r.id === ctA.id)?.self_ok);
  const ctOk = await A.as((c) => inv.decideCount(c, A.scope, ctA.id, { approve: true })) as { status: string; selfApproved: boolean };
  const ctRow = (await rows<{ self_approved: boolean; decided_by: string }>(t, `select self_approved, decided_by from inv_count where entity_id = $1 and id = $2`, [A.entityId, ctA.id]))[0];
  t.ok("count: a one-owner company approves its own count, marked self-approved with an audit row",
    ctOk.status === "approved" && ctOk.selfApproved && ctRow.self_approved && ctRow.decided_by === A.ownerId
    && (await audits(A, "inv_count", ctA.id)).some((r) => r.reason === "self-approved: no other approver"));
  t.ok("count: its history says (self-approved)", /\$\{c\.self_approved \? ' \(self-approved\)' : ''\}/.test(readFileSync(ROOT + "server/ui/inventory.js", "utf8"))
    && !!(await getAs<{ id: string; self_approved: boolean }[]>(invModule, "/inventory/counts", A.entityId, A.ownerId)).find((r) => r.id === ctA.id)?.self_approved);

  // A/R write-off
  const woA = await A.as((c) => ar.requestWriteoff(c, A.scope, { invoiceId: sa.invoiceId, amountMinor: 4000n, reason: "Moved away, no forwarding address", requestedBy: A.ownerId }));
  const wList = await getAs<{ id: string; self_ok: boolean }[]>(arModule, "/ar/writeoffs", A.entityId, A.ownerId);
  t.ok("write-off: the owner who asked sees it is theirs to approve", !!wList.find((r) => r.id === woA)?.self_ok);
  const woOk = await A.as((c) => ar.decideWriteoff(c, A.scope, woA, { decision: "approved", by: A.ownerId }));
  const woRow = (await rows<{ self_approved: boolean; status: string }>(t, `select self_approved, status from ar_writeoff where entity_id = $1 and id = $2`, [A.entityId, woA]))[0];
  t.ok("write-off: a one-owner company approves (and posts) its own write-off, marked self-approved with an audit row",
    woOk.status === "posted" && !!woOk.journalEntryId && woRow.self_approved && (await audits(A, "ar_writeoff", woA)).some((r) => r.reason === "self-approved: no other approver"));
  t.ok("write-off: its history says (self-approved)", /w\.self_approved \? ' \(self-approved\)' : ''/.test(readFileSync(ROOT + "server/ui/ar.js", "utf8"))
    && !!(await getAs<{ id: string; self_approved: boolean }[]>(arModule, "/ar/writeoffs", A.entityId, A.ownerId)).find((r) => r.id === woA)?.self_approved);

  // vendor debit memo
  const mA = await A.as((c) => DM.createMemo(c, A.scope, { vendorId: sa.vendorId, source: "short_shipped", reason: "Two chairs short on PO 12", amountMinor: 3000n }));
  const mOk = await A.as((c) => DM.approveMemo(c, A.scope, mA.id, ""));
  const mRow = (await read(t, (c) => DM.memo(c, A.entityId, mA.id))) as unknown as { self_approved: boolean; status: string };
  t.ok("debit memo: a one-owner company approves its own memo (it posts), marked self-approved with an audit row",
    mOk.status === "open" && !!mOk.journalEntryId && mRow.self_approved && (await audits(A, "vendor_debit_memo", mA.id)).some((r) => r.reason === "self-approved: no other approver"));
  t.ok("debit memo: its history says (self-approved)", (readFileSync(ROOT + "server/ui/ops.js", "utf8").match(/m\.self_approved \? ' \(self-approved\)' : ''/g) ?? []).length >= 2);

  // time off (the owner's own)
  const lA = await A.as((c) => LV.request(c, A.scope, { employeeId: sa.employeeId, leaveTypeId: sa.leaveTypeId, startsOn: addDays(A.today, 20) }));
  const lOk = await A.as((c) => LV.decide(c, A.scope, lA.id, { approve: true }));
  const lRow = (await read(t, (c) => LV.requests(c, A.entityId, { status: "approved" })) as { id: string }[]).find((r) => r.id === lA.id) as unknown as { self_approved: boolean; decided_by: string } | undefined;
  t.ok("time off: the owner of a one-owner company approves their own time off, marked self-approved with an audit row",
    lOk.status === "approved" && !!lRow?.self_approved && (await audits(A, "leave_request", lA.id)).some((r) => r.reason === "self-approved: no other approver"), JSON.stringify(lRow));
  t.ok("time off: its history says (self-approved)", /r\.self_approved \? ' \(self-approved\)' : ''/.test(readFileSync(ROOT + "server/ui/ops.js", "utf8")));

  // the database: only the maker's own decision is self-approved
  await t.throws("database: self_approved on someone else's decision is refused (a count)", () => tx(SYS, async (c) => {
    const other = (await q<{ id: string }>(c, `insert into app_user (tenant_id, email, name, status) values ($1, $2, 'Stranger', 'disabled') returning id /* unscoped: check */`, [A.tenantId, `x-${A.tag}@example.com`]))[0].id;
    const ct = (await q<{ id: string }>(c, `insert into inv_count (entity_id, number, location_id, status, created_by, submitted_by, submitted_at) values ($1, 'CHK-1', $2, 'submitted', $3, $3, now()) returning id`, [A.entityId, A.store, A.ownerId]))[0].id;
    await c.query(`update inv_count set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'x', self_approved = true where id = $1 and entity_id = $2`, [ct, A.entityId, other]);
  }), /only the maker's own decision is marked self-approved/);
  await t.throws("database: the maker deciding without self_approved still breaks the check", () => tx(SYS, async (c) => {
    const ct = (await q<{ id: string }>(c, `insert into inv_count (entity_id, number, location_id, status, created_by, submitted_by, submitted_at) values ($1, 'CHK-2', $2, 'submitted', $3, $3, now()) returning id`, [A.entityId, A.store, A.ownerId]))[0].id;
    await c.query(`update inv_count set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'x' where id = $1 and entity_id = $2`, [ct, A.entityId, A.ownerId]);
  }), /inv_count_maker_checker/);

  // ======================================================== company B: a controller is a second pair of eyes
  const B = await freshCompany(t, "Two Desk Furniture");
  const sb = await flowSetup(t, B);
  const ctl = await tx(SYS, async (c) => {
    const u = (await q<{ id: string }>(c, `insert into app_user (tenant_id, email, name) values ($1, $2, 'Casey Controller') returning id /* unscoped: check */`, [B.tenantId, `ctl-${B.tag}@example.com`]))[0].id;
    await c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, $2, 'controller')`, [u, B.entityId]);
    return u;
  });
  const ctB = await B.as((c) => inv.createCount(c, B.scope, { locationId: B.store })) as { id: string };
  await B.as((c) => inv.submitCount(c, B.scope, ctB.id, []));
  t.ok("controller here: the counting owner is not offered their own count", !(await getAs<{ id: string; self_ok: boolean }[]>(invModule, "/inventory/counts", B.entityId, B.ownerId)).find((r) => r.id === ctB.id)?.self_ok);
  await t.throws("controller here: the owner's own count is refused", () => B.as((c) => inv.decideCount(c, B.scope, ctB.id, { approve: true })), /cannot also approve it/);
  const woB = await B.as((c) => ar.requestWriteoff(c, B.scope, { invoiceId: sb.invoiceId, amountMinor: 4000n, reason: "Moved away, no forwarding address", requestedBy: B.ownerId }));
  await t.throws("controller here: the owner's own write-off is refused", () => B.as((c) => ar.decideWriteoff(c, B.scope, woB, { decision: "approved", by: B.ownerId })), /a second person has to/);
  const mB = await B.as((c) => DM.createMemo(c, B.scope, { vendorId: sb.vendorId, source: "short_shipped", reason: "Two chairs short on PO 12", amountMinor: 3000n }));
  await t.throws("controller here: the owner's own debit memo is refused", () => B.as((c) => DM.approveMemo(c, B.scope, mB.id, "")), /cannot approve it; another person does/);
  const lB = await B.as((c) => LV.request(c, B.scope, { employeeId: sb.employeeId, leaveTypeId: sb.leaveTypeId, startsOn: addDays(B.today, 20) }));
  await t.throws("controller here: the owner's own time off is refused", () => B.as((c) => LV.decide(c, B.scope, lB.id, { approve: true })), /nobody approves or declines their own time off/);
  const vB = await B.as(async (c) => act.addVendor(c, B.co, B.a, { name: `Second Eyes Vendor ${B.tag}`, category: (await q<{ code: string }>(c, `select code from vendor_category where tenant_id = $1 and active and is_merchandise limit 1 /* unscoped: check */`, [B.tenantId]))[0].code, merchandise: true }));
  const vbReq = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_type = 'vendor' and subject_id = $2`, [B.entityId, vB.id]))[0];
  if (vbReq) await t.throws("controller here: and the engine's own request stays maker-checker", () => B.as((c) => act.decideRequest(c, B.co, B.a, { requestId: vbReq.id, decision: "approved", note: "" })), /maker cannot approve/);
  for (const [name, sql, args] of [
    ["count", `update inv_count set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'x', self_approved = true where id = $1 and entity_id = $2`, [ctB.id, B.entityId, B.ownerId]],
    ["write-off", `update ar_writeoff set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'x', self_approved = true where id = $1 and entity_id = $2`, [woB, B.entityId, B.ownerId]],
    ["debit memo", `update vendor_debit_memo set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'xyz', self_approved = true where id = $1 and entity_id = $2`, [mB.id, B.entityId, B.ownerId]],
    ["time off", `update leave_request set status = 'declined', decided_by = $3, decided_at = now(), decision_note = 'xyz', self_approved = true where id = $1 and entity_id = $2`, [lB.id, B.entityId, B.ownerId]],
  ] as [string, string, unknown[]][]) {
    await t.throws(`controller here: the database refuses a hand-written self-approved ${name}`, () => tx(SYS, (c) => c.query(sql, args)), /someone else in this company can approve it/);
  }
  const ctlOk = await tx({ kind: "user", id: ctl, label: "Casey" }, (c) => ar.decideWriteoff(c, { ...B.scope, actor: { kind: "user", id: ctl, label: "Casey" } }, woB, { decision: "approved", by: ctl }));
  t.ok("controller here: the controller decides it, not self-approved", ctlOk.status === "posted" && !ctlOk.selfApproved);

  // code and SQL say the same rule
  const cases: [Co, string, string[]][] = [];
  for (const x of [A, B]) for (const roles of [["store_manager"], ["controller"], ["controller", "approver"], ["hr", "store_manager"], ["owner"]]) cases.push([x, x.ownerId, roles]);
  cases.push([B, ctl, ["controller"]]);
  const agree = await read(t, async (c) => {
    const out: string[] = [];
    for (const [x, who, roles] of cases) {
      const code = await AP.mayDecideOwn(c, who, x.entityId, roles);
      const sql = (await c.query<{ ok: boolean }>(`select may_self_approve($1::uuid, $2::uuid, $3::text[]) ok`, [x.entityId, who, roles])).rows[0].ok;
      if (code !== sql) out.push(`${roles.join("+")}: code ${code}, sql ${sql}`);
    }
    return out;
  });
  t.ok("the rule: code (mayDecideOwn) and SQL (may_self_approve) agree in a one-owner company and in one with a controller", !agree.length, agree.join("; "));
  t.ok("the rule: 0061's approval-step guard now uses the same function",
    /self_approve_refusal\(v_entity, new\.actor_id, array\[new\.required_role\]\)/.test(readFileSync(ROOT + "db/migrations/0063_self_approval_follow.sql", "utf8")));

  // ======================================================== roles taken away, and the owner's digest
  const pat = await A.as((c) => act.addPerson(c, A.co, A.a, { name: "Pat Helper", email: `pat-${A.tag}@example.com`, roles: ["controller"] }));
  await t.throws("roles: with a controller here, the owner's next count waits for them", async () => {
    const ct = await A.as((c) => inv.createCount(c, A.scope, { locationId: A.store })) as { id: string };
    await A.as((c) => inv.submitCount(c, A.scope, ct.id, []));
    await A.as((c) => inv.decideCount(c, A.scope, ct.id, { approve: true }));
  }, /cannot also approve it/);
  await A.as((c) => act.setRoles(c, A.co, A.a, { personId: pat.id, roles: ["viewer"] }));
  await A.as((c) => act.setRoles(c, A.co, A.a, { personId: pat.id, roles: ["viewer"] }));
  const removed = await rows<{ role: string; kind: string }>(t, `select role, kind from role_removal where tenant_id = $1 and app_user_id = $2`, [A.tenantId, pat.id]);
  t.ok("roles: taking away a role is kept (once), and setting the same roles again keeps nothing", removed.length === 1 && removed[0].role === "controller" && removed[0].kind === "grant_removed", JSON.stringify(removed));
  await t.throws("roles: the removals are append-only", () => tx(SYS, (c) => c.query(`delete from role_removal where tenant_id = $1 /* unscoped: check */`, [A.tenantId])), /append-only/);
  const lA2 = await A.as((c) => LV.request(c, A.scope, { employeeId: sa.employeeId, leaveTypeId: sa.leaveTypeId, startsOn: addDays(A.today, 30) }));
  const lA2ok = await A.as((c) => LV.decide(c, A.scope, lA2.id, { approve: true }));
  t.ok("roles: with the controller gone, the owner self-approves again", lA2ok.selfApproved === true);

  const dA = await tx({ kind: "system", label: "owner digest" }, (c) => OD.makeDigest(c, { ...A.scope, actor: { kind: "system", label: "owner digest" } }, new Date()));
  const nA = (await rows<{ id: string; items: { flow: string }[]; removals: { role: string; person: string }[]; emailed_message_id: string | null; body: string }>(t,
    `select id, items, removals, emailed_message_id, body from owner_notification where entity_id = $1 and kind = 'self_approval_digest'`, [A.entityId]));
  const flows = new Set((nA[0]?.items ?? []).map((i) => i.flow));
  const selfCount = (await rows<{ n: number }>(t, `select (select count(*) from approval_step s join approval_request r on r.id = s.request_id where r.entity_id = $1 and s.self_approved)
      + (select count(*) from inv_count where entity_id = $1 and self_approved) + (select count(*) from ar_writeoff where entity_id = $1 and self_approved)
      + (select count(*) from vendor_debit_memo where entity_id = $1 and self_approved) + (select count(*) from leave_request where entity_id = $1 and self_approved) as n`, [A.entityId]))[0].n;
  t.ok("digest: one notification lists every self-approval of the last 24 hours, from every flow",
    dA.made && nA.length === 1 && nA[0].items.length === Number(selfCount) && ["approval", "count", "writeoff", "debit_memo", "time_off"].every((f) => flows.has(f)), `${nA[0]?.items.length} of ${selfCount}: ${[...flows]}`);
  t.ok("digest: and the role taken away in the 24 hours before a self-approval", nA[0].removals.some((r) => r.role === "controller" && r.person === "Pat Helper") && /Pat Helper lost controller/.test(nA[0].body));
  t.ok("digest: no email connected, so nothing is emailed", !dA.emailed && !nA[0].emailed_message_id
    && !(await rows(t, `select 1 from outbound_message where entity_id = $1 and purpose = 'owner_digest'`, [A.entityId])).length);
  const again = await tx({ kind: "system", label: "owner digest" }, (c) => OD.makeDigest(c, { ...A.scope, actor: { kind: "system", label: "owner digest" } }, new Date()));
  t.ok("digest: a day's digest is made once", !again.made && /already made/.test(again.note));
  const homeA = await read(t, (c) => views.home(c, A.co, A.ownerId)) as { selfDigests: { id: string; items: unknown[] }[] };
  const homePat = await read(t, (c) => views.home(c, A.co, pat.id)) as { selfDigests: unknown[] };
  t.ok("digest: it is on the owner's Home, every line with it, and not on anyone else's", homeA.selfDigests[0]?.id === nA[0].id && homeA.selfDigests[0].items.length === nA[0].items.length && homePat.selfDigests.length === 0);
  t.ok("digest: Home shows it as a card that drills to its lines with Back, each line opening its record",
    /const digestCard = digests\.length \? section\('Self-approvals'/.test(appJs) && /function openDigest\(g\) \{[\s\S]{0,1600}return drillItems\(g\.title/.test(appJs) && /openSubject\(x\.link\)/.test(appJs) && /\btiles, digestCard, extras\b/.test(appJs));

  // email connected (company C), a suspended customer (D) and the demo: through the scheduler's own job
  const C = await freshCompany(t, "Mailing Furniture");
  const D = await freshCompany(t, "Paused Furniture");
  for (const x of [C, D]) {
    const vx = await x.as(async (c) => act.addVendor(c, x.co, x.a, { name: `Self Vendor ${x.tag}`, category: (await q<{ code: string }>(c, `select code from vendor_category where tenant_id = $1 and active and is_merchandise limit 1 /* unscoped: check */`, [x.tenantId]))[0].code, merchandise: true }));
    const r = (await rows<{ id: string }>(t, `select id from approval_request where entity_id = $1 and subject_type = 'vendor' and subject_id = $2`, [x.entityId, vx.id]))[0];
    await x.as((c) => act.decideRequest(c, x.co, x.a, { requestId: r.id, decision: "approved", note: "" }));
  }
  await tx(SYS, async (c) => {
    await c.query(`insert into admin_connection (tenant_id, entity_id, kind, provider, status, last_ok_at) values ($1, $2, 'email', 'smtp', 'connected', now())`, [C.tenantId, C.entityId]);
    await c.query(`update tenant set status = 'suspended' where id = $1 /* unscoped: check */`, [D.tenantId]);
  });
  const { JOBS, ownerDigests } = await import("../../server/scheduler.ts");
  t.ok("digest: the owner digest is one of the scheduler's daily jobs", JOBS.some((j) => j.id === "owner_digest" && j.everyMin === 24 * 60 && j.run === ownerDigests));
  const job = await ownerDigests(new Date());
  const nC = (await rows<{ id: string; emailed_message_id: string | null }>(t, `select id, emailed_message_id from owner_notification where entity_id = $1`, [C.entityId]))[0];
  const mail = nC ? await rows<{ purpose: string; to_addr: string; source_id: string }>(t, `select purpose, to_addr, source_id from outbound_message where entity_id = $1 and id = $2`, [C.entityId, nC.emailed_message_id]) : [];
  t.ok("digest: with email connected it goes to the owners through the outbox",
    !!nC?.emailed_message_id && mail[0]?.purpose === "owner_digest" && mail[0].source_id === nC.id && mail[0].to_addr === `owner-${C.tag}@example.com`, JSON.stringify(mail));
  t.ok("digest: a suspended customer gets none", !(await rows(t, `select 1 from owner_notification where entity_id = $1`, [D.entityId])).length
    && !job.items.some((i) => i.entityId === D.entityId));
  const demo = await rows<{ id: string }>(t, `select e.id from entity e join tenant t on t.id = e.tenant_id where t.kind = 'demo' /* unscoped: check */`);
  const walked = await read(t, (c) => OD.digestCompanies(c));
  t.ok("digest: the demo is never walked", demo.length > 0 && !walked.some((w) => demo.some((d) => d.id === w.id)) && walked.some((w) => w.id === C.entityId));

  // ======================================================== long words wrap on a phone
  const css = readFileSync(ROOT + "server/app.css", "utf8");
  const wrapRule = css.match(/([^{}]*)\{overflow-wrap:anywhere\}/g)?.join(" ") ?? "";
  t.ok("phone: a vendor card's inbound address (the row's note) wraps instead of overflowing", /\.li \.why[^{]*\{overflow-wrap:anywhere\}/.test(css) && /\.li \.why,[^{]*\{min-width:0\}/.test(css));
  t.ok("phone: so do notes, leads, result boxes, dialog titles and labels that can carry an email, an address or a fingerprint",
    [".lead", ".sub", ".fine", ".result>div", ".dlg-h h2", ".field>span", "p,", "label"].every((s) => wrapRule.includes(s)) && /\.li \.acts \.btn[^{]*\{white-space:normal;overflow-wrap:anywhere/.test(css));
  t.ok("phone: the web store and the trade portal wrap long words too", ["server/shop/store.css", "server/shop/trade.css"].every((f) => /overflow-wrap:anywhere/.test(readFileSync(ROOT + f, "utf8"))));
}
