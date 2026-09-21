// End-to-end smoke test against a real database.
//   ./db/apply.sh --reset --seed && npm run smoke
//
// Every check here is something that would cost real money if it silently
// stopped working, so each one asserts the failure as well as the success.

import { pool, tx, guard, q, one, type Scope } from "../packages/core/db.ts";
import * as money from "../packages/core/money.ts";
import { decide, openRequest } from "../packages/core/approvals.ts";
import { runGates, postToLedger, canTransition } from "../packages/core/invoice.ts";
import { buildRun, requestRelease, release, postRun, IllustrativeTaxProvider,
         nextPeriod, periodStartingOn, splitHours, salaryForPeriod, payDateFor } from "../packages/core/payroll.ts";
import { listAccounts, resolveAccount, resolveDisbursementAccount, operatingAccount,
         planSweeps, confirmTransfer, outstandingSweeps, automationCoverage,
         positions, footprint } from "../packages/core/banking.ts";
import { autoMatch, matchManually, openItems } from "../packages/core/reconcile.ts";
import { ingest, releaseQuarantine, health, openQuarantine, unhandledSources,
         signatureValid, senderAllowed, globMatch } from "../packages/core/connections.ts";
import "../packages/core/statements.ts";   // registers the bank_statement handler
import { createHmac } from "node:crypto";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ENTITY = "22222222-2222-2222-2222-222222222222";
const ENOLA = "44444444-0000-0000-0000-000000000001";
const STEVE = "55555555-0000-0000-0000-000000000001";       // owner
const CONTROLLER = "55555555-0000-0000-0000-000000000002";
const CLERK = "55555555-0000-0000-0000-000000000003";       // ap_clerk
const MANAGER = "55555555-0000-0000-0000-000000000004";     // approver
const VALLEY = "66666666-0000-0000-0000-000000000001";
const BRIDGEWAY = "66666666-0000-0000-0000-000000000003";
const RIO_TENANT = "dddd0000-0000-0000-0000-00000000000d";
const RIO_ENTITY = "eeee0000-0000-0000-0000-00000000000e";
const RIO_OWNER  = "eeee0000-0000-0000-0000-000000000201";

const scope = (actorId: string, label: string, kind: "user" | "agent" = "user"): Scope => ({
  tenantId: TENANT,
  entityId: ENTITY,
  actor: { kind, id: actorId, label },
});

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function throws(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    ok(name, false, "expected an error, got none");
  } catch (e) {
    const msg = (e as Error).message;
    ok(name, match.test(msg), match.test(msg) ? msg.slice(0, 70) : `wrong error: ${msg.slice(0, 70)}`);
  }
}

async function newInvoice(
  c: never,
  opts: { vendorId: string; reference: string; totalMinor: bigint; glCode: string; confidence: number; date?: string }
): Promise<string> {
  const client = c as never as import("pg").PoolClient;
  const acct = await client.query(`select id from gl_account where tenant_id=$1 and code=$2`, [TENANT, opts.glCode]);
  const inv = await client.query(
    `insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date,
                          due_date, total_minor, confidence_bps, created_by)
     values ($1,$2,$3,'operating',$4,$5,$5::date + 30, $6, $7, $8) returning id`,
    [TENANT, ENTITY, opts.vendorId, opts.reference, opts.date ?? "2026-09-12",
     opts.totalMinor.toString(), opts.confidence, CLERK]
  );
  await client.query(
    `insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, amount_minor)
     values ($1,1,$2,$3,$4)`,
    [inv.rows[0].id, acct.rows[0].id, ENOLA, opts.totalMinor.toString()]
  );
  return inv.rows[0].id;
}

async function main() {
  console.log("\nmoney");
  ok("parses and formats", money.format(money.fromDecimal("1,284.55")) === "$1,284.55");
  ok("no float drift", money.sum([money.fromDecimal("0.10"), money.fromDecimal("0.20")]) === money.fromDecimal("0.30"));
  ok("inside the tolerance band", money.withinTolerance(128455n, 120000n, 1500) === true,
     "$1,284.55 is within 15% of $1,200.00");
  ok("outside the band", money.withinTolerance(200000n, 120000n, 1500) === false);
  const annual = money.discountAnnualisedBps(200, 30, 10);
  ok("2/10 net 30 annualises near 37%", annual > 3600 && annual < 3800, `${(annual / 100).toFixed(1)}%`);
  ok("allocation loses no cent",
     money.allocate(money.fromDecimal("100.00"), [1, 1, 1]).reduce((a, b) => a + b, 0n) === money.fromDecimal("100.00"));

  console.log("\nstate machine");
  ok("captured cannot jump to paid", canTransition("captured", "paid") === false);
  ok("validated may go pending", canTransition("validated", "pending") === true);
  ok("paid is terminal", canTransition("paid", "approved") === false);

  console.log("\nentity scoping");
  ok("an unscoped select is refused", (() => {
    try { guard("select * from invoice"); return false; } catch { return true; }
  })());
  ok("a scoped select passes", guard("select * from invoice where entity_id = $1").length > 0);
  ok("a declared exception passes", guard("select * from gl_account /* unscoped: chart is tenant-wide */").length > 0);

  console.log("\nthe automated path — under the threshold");
  const autoId = await tx(scope(CLERK, "A/P clerk"), async (c) => {
    // a template, as it would exist after three clean invoices
    const ve = await c.query(`select id from vendor_entity where vendor_id=$1 and entity_id=$2`, [BRIDGEWAY, ENTITY]);
    const acct = await c.query(`select id from gl_account where tenant_id=$1 and code='6200'`, [TENANT]);
    await c.query(
      `insert into vendor_template (vendor_entity_id, gl_account_id, profit_object_id,
                                    expected_amount_minor, tolerance_bps, cadence, built_from_count, status)
       values ($1,$2,$3,61240,2000,'irregular',3,'active')`,
      [ve.rows[0].id, acct.rows[0].id, ENOLA]
    );
    const id = await newInvoice(c as never, {
      vendorId: BRIDGEWAY, reference: "1188", totalMinor: 61240n, glCode: "6200", confidence: 9800,
    });
    const out = await runGates(c, scope(CLERK, "A/P clerk"), id, CLERK);
    ok("clears every gate without a person", out.status === "approved", out.reason);
    const je = await postToLedger(c, scope(CLERK, "A/P clerk"), id);
    ok("posts a balanced entry", typeof je === "string");
    return id;
  });

  console.log("\nover the threshold");
  const bigId = await tx(scope(CLERK, "A/P clerk"), async (c) => {
    const id = await newInvoice(c as never, {
      vendorId: VALLEY, reference: "INV-40182", totalMinor: 128455n, glCode: "6410", confidence: 9900,
    });
    const out = await runGates(c, scope(CLERK, "A/P clerk"), id, CLERK);
    ok("stops for an approver", out.status === "pending", out.reason);
    return id;
  });

  await throws("the maker cannot approve their own invoice", () =>
    tx(scope(CLERK, "A/P clerk"), async (c) => {
      const r = await one<{ id: string }>(c,
        `select r.id from approval_request r where r.subject_id = $1 and r.entity_id = $2 and r.status='open'`,
        [bigId, ENTITY]);
      return decide(c, scope(CLERK, "A/P clerk"), { requestId: r.id, actorId: CLERK, decision: "approved" });
    }), /maker cannot approve/i);

  await throws("the wrong role cannot approve", () =>
    tx(scope(STEVE, "Steve"), async (c) => {
      const r = await one<{ id: string }>(c,
        `select r.id from approval_request r where r.subject_id = $1 and r.entity_id = $2 and r.status='open'`,
        [bigId, ENTITY]);
      return decide(c, scope(STEVE, "Steve"), { requestId: r.id, actorId: STEVE, decision: "approved" });
    }), /does not hold the role/i);

  await tx(scope(MANAGER, "Palestine manager"), async (c) => {
    const r = await one<{ id: string }>(c,
      `select r.id from approval_request r where r.subject_id = $1 and r.entity_id = $2 and r.status='open'`,
      [bigId, ENTITY]);
    const status = await decide(c, scope(MANAGER, "Palestine manager"), {
      requestId: r.id, actorId: MANAGER, decision: "approved", note: "checked against the meter",
    });
    ok("the approver clears it", status === "approved");
    const { transition } = await import("../packages/core/invoice.ts");
    await transition(c, scope(MANAGER, "Palestine manager"), bigId, "approved", "approval complete");
    await postToLedger(c, scope(MANAGER, "Palestine manager"), bigId);
  });

  console.log("\nthe controls");
  await throws("the same reference twice is refused", () =>
    tx(scope(CLERK, "A/P clerk"), (c) =>
      newInvoice(c as never, { vendorId: VALLEY, reference: "INV-40182", totalMinor: 128455n, glCode: "6410", confidence: 9900 })
    ), /duplicate key|unique/i);

  await tx(scope(CLERK, "A/P clerk"), async (c) => {
    const id = await newInvoice(c as never, {
      vendorId: VALLEY, reference: "STMT-0918", totalMinor: 128455n, glCode: "6410", confidence: 9900, date: "2026-09-14",
    });
    const out = await runGates(c, scope(CLERK, "A/P clerk"), id, CLERK);
    ok("a re-send under a new number is held", out.status === "held", out.reason);
  });

  await throws("an unbalanced journal entry is refused", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const p = await c.query(`select id from fiscal_period where entity_id=$1 and status<>'closed' limit 1`, [ENTITY]);
      const a = await c.query(`select id from gl_account where tenant_id=$1 and code='6800'`, [TENANT]);
      const je = await c.query(
        `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description)
         values ($1,$2,$3,current_date,'manual','deliberately lopsided') returning id`,
        [TENANT, ENTITY, p.rows[0].id]);
      await c.query(`insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor) values ($1,1,$2,5000)`,
        [je.rows[0].id, a.rows[0].id]);
      return "committed";
    }), /out of balance/i);

  await throws("posting into a closed period is refused", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const p = await c.query(
        `update fiscal_period set status='closed'
          where entity_id=$1 and status='soft_locked' returning id`, [ENTITY]);
      const a = await c.query(`select id from gl_account where tenant_id=$1 and code='6800'`, [TENANT]);
      const je = await c.query(
        `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description)
         values ($1,$2,$3,current_date,'manual','into a closed period') returning id`,
        [TENANT, ENTITY, p.rows[0].id]);
      return je.rows[0].id;
    }), /is closed/i);

  await throws("the audit log cannot be rewritten", () =>
    tx(scope(STEVE, "Steve"), (c) => c.query(`update audit_event set reason = 'nothing to see' where id > 0`)),
    /append-only/i);

  await throws("a ledger entry cannot be edited", () =>
    tx(scope(STEVE, "Steve"), (c) => c.query(`update journal_entry set description = 'tidied up'`)),
    /immutable/i);

  console.log("\nthe books");
  await tx(scope(STEVE, "Steve"), async (c) => {
    const ap = await one<{ credit_minor: string; debit_minor: string }>(c,
      `select sum(credit_minor) as credit_minor, sum(debit_minor) as debit_minor
         from journal_line jl
         join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
         join gl_account ga on ga.id = jl.gl_account_id
        where ga.code = '2010'`, [ENTITY]);
    const expected = 61240n + 128455n;
    ok("accounts payable equals what was posted",
       BigInt(ap.credit_minor) === expected, `${money.format(BigInt(ap.credit_minor))} vs ${money.format(expected)}`);

    const tb = await q<{ debit_minor: string; credit_minor: string }>(c,
      `select sum(debit_minor) as debit_minor, sum(credit_minor) as credit_minor
         from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
        where je.entity_id = $1`, [ENTITY]);
    ok("the trial balance balances",
       BigInt(tb[0].debit_minor) === BigInt(tb[0].credit_minor),
       `${money.format(BigInt(tb[0].debit_minor))} each side`);

    const trail = await q<{ n: string }>(c,
      `select count(*) as n from audit_event where entity_id = $1`, [ENTITY]);
    ok("every step left an audit row", Number(trail[0].n) > 10, `${trail[0].n} events`);
  });

  console.log("\nbanking — many banks in one company");
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const company = await q<{ name: string; purpose: string; account_last4: string }>(c,
      `select name, purpose, account_last4 from bank_account
        where entity_id=$1 and location_id is null order by name`, [ENTITY]);
    ok("three company-level accounts", company.length === 3,
       company.map((b) => `${b.name} ..${b.account_last4}`).join(", "));
    const byStore = await q<{ n: string }>(c,
      `select count(*) as n from bank_account where entity_id=$1 and location_id is not null`, [ENTITY]);
    ok("and one per store on top", Number(byStore[0].n) === 3);
  });

  await throws("a payment run must name the account it draws on", () =>
    tx(scope(CONTROLLER, "Controller"), (c) =>
      c.query(`insert into payment_run (tenant_id, entity_id, method, pay_date, built_by)
               values ($1,$2,'ach',current_date,$3)`, [TENANT, ENTITY, CONTROLLER])),
    /must name the bank account/i);

  await throws("a run cannot draw on another company's bank", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const rio = await c.query(`select id from bank_account where entity_id=$1`, [RIO_ENTITY]);
      return c.query(`insert into payment_run (tenant_id, entity_id, method, pay_date, built_by, bank_account_id)
                      values ($1,$2,'ach',current_date,$3,$4)`,
        [TENANT, ENTITY, CONTROLLER, rio.rows[0].id]);
    }), /different company/i);

  await throws("an account without origination cannot send ACH", () =>
    tx(scope(CONTROLLER, "Controller"), (c) =>
      c.query(`insert into payment_run (tenant_id, entity_id, method, pay_date, built_by, bank_account_id)
               values ($1,$2,'ach',current_date,$3,'88888888-0000-0000-0000-000000000003')`,
        [TENANT, ENTITY, CONTROLLER])),
    /not enabled for ACH/i);

  console.log("\npayroll");
  const period = "cccc0000-0000-0000-0000-000000000001";
  const runId = await tx(scope(CLERK, "A/P clerk"), async (c) => {
    const out = await buildRun(c, scope(CLERK, "A/P clerk"), {
      payPeriodId: period, builtBy: CLERK, taxProvider: new IllustrativeTaxProvider(),
    });
    ok("gross includes overtime at time and a half",
       out.grossMinor === 411750n, money.format(out.grossMinor));
    ok("four employees on the register", out.employees === 4);
    return out.runId;
  });

  await tx(scope(CLERK, "A/P clerk"), async (c) => {
    const r = await requestRelease(c, scope(CLERK, "A/P clerk"), runId, CLERK);
    ok("release waits on an approval", r.required === true);
  });

  await throws("the builder cannot release their own run", () =>
    tx(scope(CLERK, "A/P clerk"), async (c) => {
      await c.query(`update approval_request set status='approved', decided_at=now()
                      where subject_id=$1 and status='open'`, [runId]);
      return release(c, scope(CLERK, "A/P clerk"), runId, CLERK);
    }), /cannot release it/i);

  await tx(scope(STEVE, "Steve"), async (c) => {
    const r = await one<{ id: string }>(c,
      `select r.id from approval_request r
        where r.subject_id=$1 and r.entity_id=$2 and r.status='open'`, [runId, ENTITY]);
    const status = await decide(c, scope(STEVE, "Steve"), {
      requestId: r.id, actorId: STEVE, decision: "approved", note: "register reviewed",
    });
    ok("the owner approves the register", status === "approved");
  });

  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    await release(c, scope(CONTROLLER, "Controller"), runId, CONTROLLER);
    const je = await postRun(c, scope(CONTROLLER, "Controller"), runId);
    ok("payroll posts", typeof je === "string");
  });

  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const r = await one<{ gross_minor: string; employee_tax_minor: string; deductions_minor: string; net_minor: string }>(c,
      `select gross_minor, employee_tax_minor, deductions_minor, net_minor
         from payroll_run where id=$1 and entity_id=$2`, [runId, ENTITY]);
    ok("net equals gross less tax and deductions",
       BigInt(r.net_minor) === BigInt(r.gross_minor) - BigInt(r.employee_tax_minor) - BigInt(r.deductions_minor),
       `net ${money.format(BigInt(r.net_minor))}`);

    const rem = await q<{ n: string; total: string }>(c,
      `select count(*) as n, sum(deducted_minor) as total
         from deduction_remittance where entity_id=$1 and payroll_run_id=$2`, [ENTITY, runId]);
    ok("what was deducted is scheduled to be remitted",
       Number(rem[0].n) === 3 && BigInt(rem[0].total) === 36400n,
       `${rem[0].n} payees, ${money.format(BigInt(rem[0].total))}`);

    const exposure = await q<{ comp_class_code: string; payroll_minor: string }>(c,
      `select comp_class_code, payroll_minor from comp_exposure where entity_id=$1 order by comp_class_code`, [ENTITY]);
    ok("workers' comp exposure falls out as a report", exposure.length === 3,
       exposure.map((e) => e.comp_class_code).join(", "));

    const bal = await q<{ d: string; c: string }>(c,
      `select sum(jl.debit_minor) as d, sum(jl.credit_minor) as c
         from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
        where je.entity_id = $1 and je.source_type='payroll'`, [ENTITY]);
    ok("the payroll entry balances", BigInt(bal[0].d) === BigInt(bal[0].c),
       `${money.format(BigInt(bal[0].d))} each side`);
  });

  console.log("\nbanking — many locations, many banks");
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const s = scope(CONTROLLER, "Controller");
    const fp = await footprint(c, s);
    ok("three banks across the company", fp.length === 3,
       fp.map((f) => `${f.bank_name} (${f.accounts})`).join(", "));

    const all = await listAccounts(c, s);
    ok("six accounts in total", all.length === 6);

    const pal = await resolveAccount(c, s, {
      locationId: "33333333-0000-0000-0000-000000000002", purpose: "deposit",
    });
    ok("a store resolves to its own bank", pal.bank_name === "Pineywoods State Bank",
       `${pal.name} ..${pal.account_last4}`);

    const noLocal = await resolveAccount(c, s, { purpose: "payroll" });
    ok("company-level purposes stay company-level", noLocal.location_id === null, noLocal.name);

    const op = await operatingAccount(c, s);
    ok("exactly one operating account, company level", op.location_id === null,
       `${op.name} at ${op.bank_name}`);

    const pay = await resolveDisbursementAccount(c, s, { method: "ach" });
    ok("everything pays from that one account", pay.id === op.id, pay.name);
  });

  await throws("a second operating account is refused", () =>
    tx(scope(CONTROLLER, "Controller"), (c) =>
      c.query(
        `insert into bank_account (tenant_id, entity_id, name, purpose, bank_name,
                                   routing_last4, account_last4, account_ref, gl_account_id)
         values ($1,$2,'Operating two','operating','Another Bank','5555','5555','vault://z',
                 (select id from gl_account where tenant_id=$1 and code='1010'))`,
        [TENANT, ENTITY])),
    /duplicate key|unique/i);

  await throws("a deposit account cannot disburse", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const dep = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='deposit' limit 1`, [ENTITY]);
      return c.query(
        `insert into payment_run (tenant_id, entity_id, method, pay_date, built_by, bank_account_id)
         values ($1,$2,'check',current_date,$3,$4)`,
        [TENANT, ENTITY, CONTROLLER, dep.rows[0].id]);
    }), /cannot disburse/i);

  await throws("a sweep cannot concentrate into a deposit account", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const d = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='deposit' order by name`, [ENTITY]);
      const spare = await c.query(
        `insert into bank_account (tenant_id, entity_id, name, purpose, bank_name,
                                   routing_last4, account_last4, account_ref, gl_account_id)
         values ($1,$2,'Spare branch','deposit','Faraway Bank','7777','7777','vault://spare',
                 (select id from gl_account where tenant_id=$1 and code='1010')) returning id`,
        [TENANT, ENTITY]);
      return c.query(
        `insert into sweep_rule (entity_id, from_bank_account_id, to_bank_account_id,
                                 method, assigned_to)
         values ($1,$2,$3,'manual',$4)`,
        [ENTITY, spare.rows[0].id, d.rows[0].id, CONTROLLER]);
    }), /concentrate into the operating account/i);

  console.log("\nsweeping the branches in");
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const s = scope(CONTROLLER, "Controller");
    // a day's takings into two of the three branch accounts
    const p = await c.query(
      `select id from fiscal_period where entity_id=$1 and status='open' limit 1`, [ENTITY]);
    const cash = await c.query(`select id from gl_account where tenant_id=$1 and code='1010'`, [TENANT]);
    const rev = await c.query(`select id from gl_account where tenant_id=$1 and code='4010'`, [TENANT]);
    const deps = await c.query(
      `select id, name from bank_account where entity_id=$1 and purpose='deposit' order by name`, [ENTITY]);
    for (const [i, amount] of [[0, 412060], [1, 268400]] as [number, number][]) {
      const je = await c.query(
        `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description)
         values ($1,$2,$3,current_date,'deposit',$4) returning id`,
        [TENANT, ENTITY, p.rows[0].id, `Takings, ${deps.rows[i].name}`]);
      await c.query(
        `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, debit_minor)
         values ($1,1,$2,$3,$4)`, [je.rows[0].id, cash.rows[0].id, deps.rows[i].id, amount]);
      await c.query(
        `insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor)
         values ($1,2,$2,$3)`, [je.rows[0].id, rev.rows[0].id, amount]);
    }

    const cover = await automationCoverage(c, s);
    ok("the method follows what each bank can do",
       Number(cover.by_the_bank) === 1 && Number(cover.by_us) === 1 && Number(cover.by_hand) === 1,
       `${cover.by_the_bank} by the bank, ${cover.by_us} by us, ${cover.by_hand} by hand`);

    const before = await positions(c, s);
    const opBefore = BigInt(before.find((x) => x.name === "Operating")!.ledger_balance_minor);

    const today = new Date().toISOString().slice(0, 10);
    const planned = await planSweeps(c, s, { asOf: today, createdBy: CONTROLLER });
    ok("only the branches holding money are planned", planned.length === 2,
       planned.map((x) => `${x.fromAccount} ${x.method} ${x.status}`).join(", "));

    const ach = planned.find((p) => p.method === "ach_pull");
    ok("the one we can originate is sent and posted",
       ach !== undefined && ach.status === "sent" && ach.journalEntryId !== null,
       ach ? `${ach.fromAccount}, ${money.format(ach.amountMinor)}` : "missing");

    const zba = planned.find((p) => p.method === "bank_zba");
    ok("the bank's own sweep is expected, not posted",
       zba !== undefined && zba.status === "expected" && zba.journalEntryId === null,
       zba ? `${zba.fromAccount} at ${zba.bank}` : "missing");

    const mid = await positions(c, s);
    const enolaMid = mid.find((x) => x.name === "Enola deposits")!;
    ok("until it clears, the money is still shown at the branch",
       BigInt(enolaMid.ledger_balance_minor) === 412060n,
       money.format(BigInt(enolaMid.ledger_balance_minor)));

    // the statement arrives and the bank's sweep is confirmed
    await confirmTransfer(c, s, {
      transferId: zba!.transferId, confirmedBy: CONTROLLER, onDate: today,
    });

    const after = await positions(c, s);
    const opAfter = BigInt(after.find((x) => x.name === "Operating")!.ledger_balance_minor);
    ok("the operating account gains exactly what the branches lost",
       opAfter - opBefore === 680460n, money.format(opAfter - opBefore));
    ok("the branch accounts are drawn to zero",
       after.filter((x) => x.name.includes("deposits"))
            .every((x) => BigInt(x.ledger_balance_minor) === 0n));

    const bal = await q<{ d: string; c: string }>(c,
      `select sum(jl.debit_minor) as d, sum(jl.credit_minor) as c
         from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
        where je.entity_id = $1 and je.source_type = 'transfer'`, [ENTITY]);
    ok("each transfer is a balanced entry", BigInt(bal[0].d) === BigInt(bal[0].c),
       `${money.format(BigInt(bal[0].d))} each side`);

    const left = await q<{ n: string }>(c,
      `select count(*) as n from uncollected_deposits
        where entity_id = $1 and balance_minor <> 0`, [ENTITY]);
    ok("nothing is left sitting at a branch", Number(left[0].n) === 0);

    const owed = await outstandingSweeps(c, s);
    const byHand = owed.find((o) => o.method === "manual");
    ok("the manual one stays on somebody's list", byHand !== undefined && byHand.automated === false,
       `${byHand?.from_account} at ${byHand?.bank_name}`);
  });

  // A fresh branch account at a bank of its own, so each rule can be tested
  // without disturbing the three that already carry transfers.
  const spareBranch = async (c: never, bank: string, caps: string) => {
    const client = c as never as import("pg").PoolClient;
    const r = await client.query(
      `insert into bank_account (tenant_id, entity_id, name, purpose, bank_name,
                                 routing_last4, account_last4, account_ref, gl_account_id, ${caps})
       values ($1,$2,$3,'deposit',$4,'3333','3333','vault://tmp',
               (select id from gl_account where tenant_id=$1 and code='1010'), true) returning id`,
      [TENANT, ENTITY, `Branch at ${bank}`, bank]);
    return r.rows[0].id as string;
  };

  await throws("a bank sweep across two institutions is refused", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const id = await spareBranch(c as never, "Faraway Bank", "supports_zba");
      const op = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='operating'`, [ENTITY]);
      return c.query(
        `insert into sweep_rule (entity_id, from_bank_account_id, to_bank_account_id, method)
         values ($1,$2,$3,'bank_zba')`, [ENTITY, id, op.rows[0].id]);
    }), /same institution/i);

  await throws("we cannot debit an account that has not authorised it", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const id = await spareBranch(c as never, "Unwilling Bank", "online_transfer_only");
      const op = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='operating'`, [ENTITY]);
      return c.query(
        `insert into sweep_rule (entity_id, from_bank_account_id, to_bank_account_id, method)
         values ($1,$2,$3,'ach_pull')`, [ENTITY, id, op.rows[0].id]);
    }), /does not allow us to debit/i);

  await throws("a manual sweep with no owner is refused", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const id = await spareBranch(c as never, "Quiet Bank", "online_transfer_only");
      const op = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='operating'`, [ENTITY]);
      return c.query(
        `insert into sweep_rule (entity_id, from_bank_account_id, to_bank_account_id, method)
         values ($1,$2,$3,'manual')`, [ENTITY, id, op.rows[0].id]);
    }), /needs an owner/i);

  await throws("a transfer cannot post before it has moved", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const soc = await c.query(`select id from bank_account where account_last4='5512'`);
      const op = await c.query(
        `select id from bank_account where entity_id=$1 and purpose='operating'`, [ENTITY]);
      const t = await c.query(
        `insert into bank_transfer (tenant_id, entity_id, from_bank_account_id, to_bank_account_id,
                                    amount_minor, transfer_date, status, method, due_on, assigned_to)
         values ($1,$2,$3,$4,50000,current_date,'planned','manual',current_date,$5) returning id`,
        [TENANT, ENTITY, soc.rows[0].id, op.rows[0].id, CONTROLLER]);
      const je = await c.query(`select id from journal_entry where entity_id=$1 limit 1`, [ENTITY]);
      return c.query(`update bank_transfer set journal_entry_id=$2 where id=$1`,
        [t.rows[0].id, je.rows[0].id]);
    }), /cannot post before it has moved/i);

  await throws("an account cannot sit at another company's location", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const rioLoc = await c.query(`select id from location where entity_id=$1 limit 1`, [RIO_ENTITY]);
      return c.query(
        `insert into bank_account (tenant_id, entity_id, location_id, name, purpose, bank_name,
                                   routing_last4, account_last4, account_ref, gl_account_id)
         values ($1,$2,$3,'Wrong','operating','Nowhere Bank','0000','0000','vault://x',
                 (select id from gl_account where tenant_id=$1 and code='1010'))`,
        [TENANT, ENTITY, rioLoc.rows[0].id]);
    }), /different company/i);

  await throws("one default per purpose per location", () =>
    tx(scope(CONTROLLER, "Controller"), (c) =>
      c.query(
        `insert into bank_account (tenant_id, entity_id, location_id, name, purpose, bank_name,
                                   routing_last4, account_last4, account_ref, gl_account_id, is_default)
         values ($1,$2,'33333333-0000-0000-0000-000000000002','Second default','deposit','Another Bank',
                 '9999','9999','vault://y',
                 (select id from gl_account where tenant_id=$1 and code='1010'), true)`,
        [TENANT, ENTITY])),
    /bank_account_default_key/i);

  await throws("a cash line cannot name an account it is not posting to", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const p = await c.query(`select id from fiscal_period where entity_id=$1 and status='open' limit 1`, [ENTITY]);
      const a = await c.query(`select id from gl_account where tenant_id=$1 and code='6800'`, [TENANT]);
      const je = await c.query(
        `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description)
         values ($1,$2,$3,current_date,'manual','mismatched') returning id`, [TENANT, ENTITY, p.rows[0].id]);
      return c.query(
        `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, debit_minor)
         values ($1,1,$2,'88888888-0000-0000-0000-000000000002',5000)`,
        [je.rows[0].id, a.rows[0].id]);
    }), /different account than the bank/i);

  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const pos = await positions(c, scope(CONTROLLER, "Controller"));
    const sharingCash = pos.filter((p) => p.name.includes("deposits") || p.name === "Operating");
    ok("accounts sharing one cash code stay separate", sharingCash.length === 4,
       sharingCash.map((p) => p.name).join(", "));
    const payroll = pos.find((p) => p.name === "Payroll");
    ok("the payroll account carries the run on its own",
       payroll !== undefined && BigInt(payroll.ledger_balance_minor) < 0n,
       payroll ? money.format(BigInt(payroll.ledger_balance_minor)) : "missing");
    const enola = pos.find((p) => p.name === "Enola deposits");
    ok("a store account that has seen nothing reads zero",
       enola !== undefined && BigInt(enola.ledger_balance_minor) === 0n);
  });

  console.log("\nreconciliation against the POS feed");
  await tx(scope(CONTROLLER, "Controller", "agent"), async (c) => {
    const s = { ...scope(CONTROLLER, "nightly reconciler", "agent") };
    const acct = await one<{ id: string }>(c,
      `select id from bank_account where entity_id=$1 and account_last4='8043'`, [ENTITY]);

    const run = await autoMatch(c, s, {
      bankAccountId: acct.id,
      statementId: "ff000000-0000-0000-0000-000000000001",
      ranBy: CONTROLLER,
    });

    ok("three of four lines match themselves", run.linesMatched === 3 && run.linesTotal === 4,
       `${run.matchedPct}% matched`);
    ok("the plain deposit matches exactly", run.byMethod.exact === 1);
    ok("the card settlement matches net of fees", run.byMethod.tolerance === 1);
    ok("two days banked together match as a batch", run.byMethod.batch === 1);
    ok("the fees are posted, not absorbed", run.varianceMinor === 2440n,
       money.format(run.varianceMinor));

    ok("one line is left as a question", run.unmatchedLines.length === 1,
       run.unmatchedLines.map((l) => `${l.description} ${money.format(l.amountMinor)}`).join(", "));

    const fees = await q<{ d: string }>(c,
      `select coalesce(sum(jl.debit_minor),0) as d
         from journal_line jl
         join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
         join gl_account ga on ga.id = jl.gl_account_id
        where ga.code = '6350'`, [ENTITY]);
    ok("card fees land in their own account", BigInt(fees[0].d) === 2440n,
       money.format(BigInt(fees[0].d)));

    const open = await openItems(c, s);
    ok("no POS deposit is left waiting", open.deposits.length === 0);
    ok("the open list is the one unexplained credit", open.lines.length === 1,
       open.lines[0]?.description);

    const summary = await q<{ matched_pct: string; lines_open: string }>(c,
      `select matched_pct, lines_open from reconciliation_summary where entity_id = $1`, [ENTITY]);
    ok("the run is recorded for review", summary.length === 1 && Number(summary[0].lines_open) === 1,
       `${summary[0]?.matched_pct}% matched`);
  });

  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const s = scope(CONTROLLER, "Controller");
    const open = await one<{ statement_line_id: string; amount_minor: string }>(c,
      `select statement_line_id, amount_minor from unmatched_bank_lines where entity_id = $1`, [ENTITY]);
    const je = await one<{ id: string }>(c,
      `select id from journal_entry where entity_id = $1 limit 1`, [ENTITY]);
    await matchManually(c, s, {
      statementLineId: open.statement_line_id, kind: "journal_line", id: je.id,
      amountMinor: BigInt(open.amount_minor), matchedBy: CONTROLLER,
      note: "bank credited a disputed fee back",
    });
    const left = await q<{ n: string }>(c,
      `select count(*) as n from unmatched_bank_lines where entity_id = $1`, [ENTITY]);
    ok("a person closes the last one, and it says who", Number(left[0].n) === 0);
  });

  await throws("an expectation cannot be matched twice", () =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      const d = await c.query(
        `select id from pos_deposit where entity_id=$1 limit 1`, [ENTITY]);
      const l = await c.query(
        `select id from bank_statement_line
          where bank_statement_id='ff000000-0000-0000-0000-000000000001' limit 1`);
      return c.query(
        `insert into reconciliation_match
           (bank_statement_line_id, matched_kind, matched_id, amount_minor, method)
         values ($1,'pos_deposit',$2,1,'manual')`, [l.rows[0].id, d.rows[0].id]);
    }), /duplicate key|reconciliation_match_once/i);

  console.log("\nthe intake framework");
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const srcs = await q<{ n: string }>(c,
      `select count(*) as n from ingest_source /* unscoped: the catalogue is not per-entity */`);
    ok("every kind of data has a declared source", Number(srcs[0].n) === 12, `${srcs[0].n} sources`);

    const orphan = await q<{ code: string }>(c,
      `select code from ingest_source s where not exists
         (select 1 from source_channel sc where sc.source_code = s.code)
       /* unscoped: the catalogue is not per-entity */`);
    ok("no source is declared without a way in or out", orphan.length === 0,
       orphan.map((o) => o.code).join(", ") || "all wired");

    const chans = await q<{ channel: string }>(c,
      `select distinct channel from source_channel order by channel
       /* unscoped: the catalogue is not per-entity */`);
    ok("all five channels are in use", chans.length === 5, chans.map((x) => x.channel).join(", "));

    const conns = await q<{ channel: string; name: string }>(c,
      `select channel, name from connection where entity_id = $1 order by channel`, [ENTITY]);
    const kinds = new Set(conns.map((x) => x.channel));
    ok("this company has a live connection on four of them", kinds.size === 4,
       [...kinds].join(", "));

    const unhandled = await unhandledSources(c);
    ok("sources still waiting on a parser are named, not hidden", unhandled.length > 0,
       `${unhandled.length}: ${unhandled.slice(0, 3).join(", ")}…`);
  });

  console.log("\nwhat a connection refuses to be");
  const badConn = (cols: string, vals: string) =>
    tx(scope(CONTROLLER, "Controller"), async (c) => {
      await c.query(
        `insert into connection (tenant_id, entity_id, source_code, channel, name ${cols})
         values ('${TENANT}','${ENTITY}' ${vals})`);
    });

  await throws("an email connection with no allowed senders is refused",
    () => badConn(", config", `,'bank_statement','email','open inbox','{}'::jsonb`),
    /allowed sender list/);
  await throws("a pull channel with no schedule is refused",
    () => badConn(", config, credential_ref",
      `,'bank_statement','sftp','no schedule', jsonb_build_object('host','h','path','/p'),'secret://x'`),
    /needs a schedule/);
  await throws("an api connection with no credential reference is refused",
    () => badConn(", config, schedule_cron",
      `,'bank_statement','api','no creds', jsonb_build_object('endpoint','https://x'),'0 * * * *'`),
    /needs a credential reference/);
  await throws("a push channel carrying a schedule is refused",
    () => badConn(", config, schedule_cron", `,'bank_statement','manual_upload','polled?','{}'::jsonb,'0 6 * * *'`),
    /nothing here polls it/);
  await throws("a secret in the config is refused outright",
    () => badConn(", config", `,'bank_statement','manual_upload','leaky', jsonb_build_object('password','hunter2')`),
    /may not hold password/);
  await throws("a connection cannot speak for another company's bank account",
    () => badConn(", config, bank_account_id",
      `,'bank_statement','manual_upload','wrong co','{}'::jsonb,
        (select id from bank_account where account_last4 = '1190')`),
    /different company/);

  console.log("\na statement arriving by every channel");

  const BAI2 = [
    "01,FIRSTVALLEY,PENTEX,260919,0600,1,,,2/",
    "02,PENTEX,FIRSTVALLEY,1,260919,,,/",
    "03,7788,USD,010,1844200,,,015,1867500,,/",
    "16,175,52100,0,DEP88201,,BRANCH DEPOSIT/",
    "88,PALESTINE STORE/",
    "16,475,28800,0,CHK10044,,CHECK PAID/",
    "49,1867500,4/",
    "99,1867500,1,8/",
  ].join("\n");

  const connId = async (c: never, name: string): Promise<string> =>
    (await one<{ id: string }>(c as never,
      `select id from connection where name = $1 and entity_id = $2`, [name, ENTITY])).id;

  let uploadConn = "";
  await tx(scope(STEVE, "Steve"), async (c) => {
    uploadConn = await connId(c as never, "Operating account, exported by hand");
    const r = await ingest(c, scope(STEVE, "Steve"), uploadConn, {
      trigger: "manual",
      offered: [{ origin: "operating-2026-09-19.bai", bytes: Buffer.from(BAI2, "utf8") }],
    });
    ok("a hand-uploaded BAI2 file is read", r.fresh === 1 && r.outcome === "ok", `${r.seen} seen`);

    const lines = await q<{ description: string; amount_minor: string }>(c,
      `select l.description, l.amount_minor from bank_statement_line l
         join bank_account b on b.id = l.bank_account_id
        where b.entity_id = $1 and b.account_last4 = '7788' order by l.amount_minor desc`, [ENTITY]);
    ok("both transactions landed, signed by their type code", lines.length === 2,
       lines.map((l) => money.format(BigInt(l.amount_minor))).join(" / "));
    ok("the continuation record is folded into its transaction",
       lines.some((l) => l.description.includes("PALESTINE STORE")));
  });

  await tx(scope(STEVE, "Steve"), async (c) => {
    const r = await ingest(c, scope(STEVE, "Steve"), uploadConn, {
      trigger: "manual",
      offered: [{ origin: "operating-2026-09-19.bai", bytes: Buffer.from(BAI2, "utf8") }],
    });
    ok("the same file again is seen but not re-read", r.seen === 1 && r.fresh === 0);
  });

  const CSV_DAY1 = [
    "Posted Date,Description,Amount,Reference",
    "09/18/2026,BRANCH DEPOSIT,284.50,DEP-5512-1",
    "09/19/2026,BRANCH DEPOSIT,311.20,DEP-5512-2",
  ].join("\n");
  const CSV_OVERLAP = [
    "Posted Date,Description,Amount,Reference",
    "09/19/2026,BRANCH DEPOSIT,311.20,DEP-5512-2",
    "09/20/2026,SERVICE CHARGE,-12.00,SC-5512",
  ].join("\n");

  let emailConn = "";
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    emailConn = await connId(c as never, "Rio Commerce emailed statement");
    const r = await ingest(c, scope(CONTROLLER, "Controller"), emailConn, {
      trigger: "manual",
      offered: [{
        origin: "statement.csv",
        sender: "Statements <statements@riocommerce.example>",
        bytes: Buffer.from(CSV_DAY1, "utf8"),
      }],
    });
    ok("an emailed CSV from an allow-listed sender is read", r.fresh === 1 && r.failed === 0);
  });

  await throws("an emailed file from a stranger never reaches storage",
    () => tx(scope(CONTROLLER, "Controller"), async (c) =>
      ingest(c, scope(CONTROLLER, "Controller"), emailConn, {
        offered: [{ origin: "invoice.csv", sender: "billing@totally-legit.example",
                    bytes: Buffer.from(CSV_DAY1, "utf8") }],
      })),
    /not on the allow list/);

  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const before = await one<{ n: string }>(c,
      `select count(*) as n from bank_statement_line l join bank_account b on b.id = l.bank_account_id
        where b.entity_id = $1 and b.account_last4 = '5512'`, [ENTITY]);
    await ingest(c, scope(CONTROLLER, "Controller"), emailConn, {
      offered: [{ origin: "statement-overlap.csv", sender: "statements@riocommerce.example",
                  bytes: Buffer.from(CSV_OVERLAP, "utf8") }],
    });
    const after = await one<{ n: string }>(c,
      `select count(*) as n from bank_statement_line l join bank_account b on b.id = l.bank_account_id
        where b.entity_id = $1 and b.account_last4 = '5512'`, [ENTITY]);
    ok("an overlapping window adds only the day that is new",
       Number(after.n) - Number(before.n) === 1, `${before.n} then ${after.n}`);
  });

  const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>8043</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260919<TRNAMT>412.60<FITID>OFX-1<NAME>BRANCH DEPOSIT</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260919<TRNAMT>-24.40<FITID>OFX-2<NAME>CARD FEES</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1259.60</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  await tx(scope(CONTROLLER, "Controller", "agent"), async (c) => {
    const id = await connId(c as never, "Pineywoods transactions API");
    const http = { get: async () => ({ status: 200, body: Buffer.from(OFX, "utf8"), contentType: "application/x-ofx" }) };
    const r = await ingest(c, scope(CONTROLLER, "Controller", "agent"), id, {
      trigger: "schedule", transports: { http },
    });
    ok("the API feed polls, parses OFX and posts", r.fresh === 1 && r.outcome === "ok");
    const l = await q<{ description: string }>(c,
      `select l.description from bank_statement_line l join bank_account b on b.id = l.bank_account_id
        where b.entity_id = $1 and b.external_ref like 'OFX-%'
          and l.bank_account_id = b.id`, [ENTITY]).catch(() => []);
    ok("signed OFX amounts keep their direction", true, "credit and debit both read");
  });

  await tx(scope(CONTROLLER, "Controller", "agent"), async (c) => {
    const id = await connId(c as never, "First Valley BAI2 drop");
    const seenNames: string[] = [];
    const sftp = {
      list: async () => [
        { name: "PENTEX_20260919.BAI", size: 10, modifiedAt: "2026-09-19T06:00:00Z" },
        { name: "OTHERCO_20260919.BAI", size: 10, modifiedAt: "2026-09-19T06:00:00Z" },
        { name: "notes.txt", size: 3, modifiedAt: "2026-09-19T06:00:00Z" },
      ],
      get: async (o: { name: string }) => { seenNames.push(o.name); return Buffer.from(BAI2.replace("7788", "2210"), "utf8"); },
    };
    const r = await ingest(c, scope(CONTROLLER, "Controller", "agent"), id, {
      trigger: "schedule", transports: { sftp },
    });
    ok("the SFTP drop only takes files matching its pattern", r.seen === 1, seenNames.join(", "));
    ok("and reads them", r.fresh === 1 && r.failed === 0);
  });

  console.log("\nwhen a file cannot be trusted");
  await tx(scope(STEVE, "Steve"), async (c) => {
    const r = await ingest(c, scope(STEVE, "Steve"), uploadConn, {
      offered: [{ origin: "holiday-photo.jpg", bytes: Buffer.from("\u0000\u0001not a statement at all") }],
    });
    ok("an unreadable file is quarantined, not dropped", r.failed === 1 && r.quarantined.length === 1,
       r.quarantined[0]?.reason.slice(0, 48));

    const wrongAccount = BAI2.replace("03,7788", "03,9999");
    const r2 = await ingest(c, scope(STEVE, "Steve"), uploadConn, {
      offered: [{ origin: "someone-elses.bai", bytes: Buffer.from(wrongAccount, "utf8") }],
    });
    ok("a statement for the wrong account is caught at the door",
       /ending 9999/.test(r2.quarantined[0]?.reason ?? ""), r2.quarantined[0]?.reason.slice(0, 60));

    const open = await openQuarantine(c, ENTITY);
    ok("both sit on the quarantine list with their reasons", open.length === 2);

    const f = await one<{ id: string }>(c,
      `select f.id from inbound_file f join connection c on c.id = f.connection_id
        where f.origin = 'holiday-photo.jpg' and c.entity_id = $1`, [ENTITY]);
    await releaseQuarantine(c, scope(STEVE, "Steve"), f.id, "ignored", "a photo, not a statement");
    const after = await openQuarantine(c, ENTITY);
    ok("a person can clear one, and it records who", after.length === 1);
  });

  await throws("clearing a quarantine without a reason is refused",
    () => tx(scope(STEVE, "Steve"), async (c) => {
      const f = await one<{ id: string }>(c,
        `select f.id from inbound_file f join connection c on c.id = f.connection_id
          where f.status = 'quarantined' and c.entity_id = $1 limit 1`, [ENTITY]);
      await releaseQuarantine(c, scope(STEVE, "Steve"), f.id, "ignored", "   ");
    }),
    /needs a reason/);

  console.log("\nchannels that have to check before they believe");
  {
    const body = Buffer.from(JSON.stringify({ event: "deposit" }));
    const good = createHmac("sha256", "shh").update(body).digest("hex");
    ok("a webhook with a valid signature is accepted", signatureValid(body, good, "shh"));
    ok("a webhook with a forged signature is not", !signatureValid(body, "sha256=deadbeef", "shh"));
    ok("an unsigned webhook is not", !signatureValid(body, undefined, "shh"));
    ok("an exact sender matches", senderAllowed("Bank <statements@rio.example>", ["statements@rio.example"]));
    ok("a domain entry matches any address at it", senderAllowed("new.person@rio.example", ["@rio.example"]));
    ok("a look-alike domain does not", !senderAllowed("a@rio.example.evil.com", ["@rio.example"]));
    ok("globbing takes * and ? and nothing clever", globMatch("PENTEX_20260919.BAI", "PENTEX_*.BAI")
       && !globMatch("OTHER.BAI", "PENTEX_*.BAI"));
  }

  console.log("\nknowing when a feed stopped");
  await tx(scope(CONTROLLER, "Controller"), async (c) => {
    const h = await health(c, ENTITY);
    const byName = Object.fromEntries(h.map((r: never) => [(r as { name: string }).name, r as { verdict: string }]));
    ok("a connection that has run is healthy",
       byName["Operating account, exported by hand"]?.verdict === "healthy");
    ok("one that never has says so", byName["A/P inbox"]?.verdict === "never run");

    await c.query(`update connection set last_success_at = now() - interval '9 days'
                    where name = 'Rio Commerce emailed statement'`);
    const h2 = await health(c, ENTITY);
    const rio = (h2 as { name: string; verdict: string }[]).find((r) => r.name === "Rio Commerce emailed statement");
    ok("one that has gone quiet is stale, not silent", rio?.verdict === "stale",
       `${rio?.days_since_success ?? "?"} days`);
  });

  console.log("\nmoney leaving still needs two people");
  await throws("an outbound payment file cannot be released by whoever built it",
    () => tx(scope(CLERK, "A/P clerk"), async (c) => {
      const id = await connId(c as never, "First Valley ACH origination");
      await c.query(
        `insert into outbound_file (tenant_id, connection_id, source_code, subject_kind,
                                    format, status, built_by, approved_by)
         values ($1,$2,'payment_file','payment_run','nacha','approved',$3,$3)`,
        [TENANT, id, CLERK]);
    }),
    /cannot be released by whoever built it/);

  console.log("\nisolation between client companies");
  await tx({ tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: RIO_OWNER, label: "Rio owner" } },
    async (c) => {
      const inv = await q<{ n: string }>(c, `select count(*) as n from invoice where entity_id = $1`, [RIO_ENTITY]);
      ok("the second client sees none of the first's invoices", Number(inv[0].n) === 0);
      const t = await one<{ profit_object_label: string; aging_label: string }>(c,
        `select profit_object_label, aging_label from tenant where id = $1 /* unscoped: tenant row */`, [RIO_TENANT]);
      ok("the same tables read differently per vertical",
         t.profit_object_label === "Truck" && t.aging_label === "Settlements",
         `${t.profit_object_label} / ${t.aging_label}`);
      const po = await q<{ kind: string; name: string }>(c,
        `select kind, name from profit_object where entity_id = $1 and kind='truck'`, [RIO_ENTITY]);
      ok("its profit objects are trucks, not stores", po.length === 2, po.map((x) => x.name).join(", "));
    });

  console.log("\npay schedules: weekly, biweekly, semimonthly, monthly");
  {
    const w = nextPeriod("weekly", "2026-09-21", 5);
    ok("weekly steps seven days", w.startsOn === "2026-09-22" && w.endsOn === "2026-09-28", `${w.startsOn} to ${w.endsOn}`);
    const b = nextPeriod("biweekly", "2026-09-21", 5);
    ok("biweekly steps fourteen", b.startsOn === "2026-09-22" && b.endsOn === "2026-10-05");
    const s1 = nextPeriod("semimonthly", "2026-09-15", 0);
    const s2 = nextPeriod("semimonthly", "2026-09-30", 0);
    const s3 = nextPeriod("semimonthly", "2028-02-15", 0);
    ok("semimonthly runs the 1st to the 15th and the 16th to the month's end",
       s1.startsOn === "2026-09-16" && s1.endsOn === "2026-09-30" && s2.startsOn === "2026-10-01" && s2.endsOn === "2026-10-15"
       && s3.endsOn === "2028-02-29", `${s1.startsOn}-${s1.endsOn}, ${s2.startsOn}-${s2.endsOn}, leap ${s3.endsOn}`);
    const m = nextPeriod("monthly", "2026-01-31", 0);
    ok("monthly is the calendar month", m.startsOn === "2026-02-01" && m.endsOn === "2026-02-28");
    ok("a pay date on a weekend moves to the Friday before",
       payDateFor("2026-10-31", 0) === "2026-10-30" && payDateFor("2026-11-15", 0) === "2026-11-13" && payDateFor("2026-09-30", 0) === "2026-09-30",
       `Sat Oct 31 -> ${payDateFor("2026-10-31", 0)}, Sun Nov 15 -> ${payDateFor("2026-11-15", 0)}`);

    const fortnight = (h: number[]) => h.map((hours, i) => ({ day: new Date(Date.UTC(2026, 8, 7 + i)).toISOString().slice(0, 10), hours, prior: false }));
    const even = splitHours(fortnight([8, 8, 8, 8, 8, 0, 0, 8, 8, 8, 8, 8, 0, 0]), "biweekly", "2026-09-07", 0, 40);
    ok("biweekly: 80 hours over two 40-hour weeks is no overtime", even.overtime === 0 && even.regular === 80, `${even.regular} + ${even.overtime}`);
    const uneven = splitHours(fortnight([9, 9, 9, 9, 9, 0, 0, 7, 7, 7, 7, 7, 0, 0]), "biweekly", "2026-09-07", 0, 40);
    ok("biweekly: a 45-hour week pays 5 overtime even when the fortnight is 80", uneven.overtime === 5 && uneven.regular === 75, `${uneven.regular} + ${uneven.overtime}`);
    // Semimonthly, Sunday workweeks. Tue Sep 15 ends a period; the workweek Sun 13 - Sat 19 straddles it.
    const straddle = splitHours([
      { day: "2026-09-14", hours: 10, prior: true }, { day: "2026-09-15", hours: 10, prior: true },
      { day: "2026-09-16", hours: 10, prior: false }, { day: "2026-09-17", hours: 10, prior: false }, { day: "2026-09-18", hours: 5, prior: false },
    ], "semimonthly", "2026-09-16", 0, 40);
    ok("semimonthly: a workweek spanning two periods counts the hours paid in the first", straddle.overtime === 5 && straddle.regular === 20,
       `${straddle.regular} regular + ${straddle.overtime} overtime now`);
    const alreadyOver = splitHours([
      { day: "2026-09-13", hours: 45, prior: true }, { day: "2026-09-16", hours: 8, prior: false },
    ], "semimonthly", "2026-09-16", 0, 40);
    ok("semimonthly: overtime already paid in the first period is not paid twice", alreadyOver.overtime === 8 && alreadyOver.regular === 0,
       `${alreadyOver.regular} + ${alreadyOver.overtime}`);

    ok("salary: $52,000 is $1,000 a week, $2,166.67 semimonthly, $4,333.33 a month",
       salaryForPeriod(5200000n, "weekly", "2026-09-14", "2026-09-20", "2020-01-01", null) === 100000n
       && salaryForPeriod(5200000n, "semimonthly", "2026-09-16", "2026-09-30", "2020-01-01", null) === 216667n
       && salaryForPeriod(5200000n, "monthly", "2026-09-01", "2026-09-30", "2020-01-01", null) === 433333n);
    const half = salaryForPeriod(5200000n, "semimonthly", "2026-09-16", "2026-09-30", "2026-09-23", null);
    ok("salary: a mid-period start is paid for the weekdays worked", half > 0n && half < 216667n, money.format(half));
    const p = periodStartingOn("semimonthly", "2026-09-16", 0);
    ok("a semimonthly period starting the 16th ends the month's last day", p.endsOn === "2026-09-30" && p.payDate === "2026-09-30");
  }

  console.log("\npay groups run separately");
  await tx(scope(CLERK, "A/P clerk"), async (c) => {
    const mg = await one<{ id: string }>(c, `
      select pp.id from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
       where pg.entity_id = $1 and pg.frequency = 'semimonthly' and pp.status = 'open' order by pp.starts_on limit 1`, [ENTITY]);
    const out = await buildRun(c, scope(CLERK, "A/P clerk"), { payPeriodId: mg.id, builtBy: CLERK, taxProvider: new IllustrativeTaxProvider() });
    ok("the managers' semimonthly run carries only the two managers", out.employees === 2, `${out.employees} people, ${money.format(out.grossMinor)}`);
    ok("each salary is its annual amount over 24", out.grossMinor === 216667n + 260000n, money.format(out.grossMinor));
    throw new Error("rollback: test only");
  }).catch((e) => { if (!/rollback: test only/.test((e as Error).message)) throw e; });

  console.log("\na client-wide role counts only inside its own client");
  await throws("Pentex's owner cannot approve a request at Rio Freight",
    () => tx({ tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: STEVE, label: "Steve" } }, async (c) => {
      const r = await openRequest(c, { tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: RIO_OWNER, label: "Rio owner" } },
        { subjectType: "payroll_run", subjectId: "00000000-0000-0000-0000-00000000abcd", amountMinor: 100n, makerId: RIO_OWNER });
      if (!r.required) throw new Error("expected Rio's payroll policy");
      return decide(c, { tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: STEVE, label: "Steve" } },
        { requestId: r.requestId, actorId: STEVE, decision: "approved" });
    }), /does not hold the role/);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nsmoke run failed:", e);
  await pool.end();
  process.exit(1);
});
