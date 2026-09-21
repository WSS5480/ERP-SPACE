// Three weeks of made-up activity for the trial company, so every screen has
// something true to show.
//
// Nothing here writes around the engine. Bills go through the same gates a
// clerk's would and are approved by the right person; sweeps are planned and
// confirmed by the banking module; the deposit accounts are reconciled by the
// real matchers; payroll is built, approved by the owner, released by the
// controller and posted. The only shortcuts are the ones that stand in for the
// outside world: the stores' takings, the POS expectations and the bank
// statements, which a real install gets from the POS and the banks.
//
// It runs once, only in the trial (ERP_SEED=placeholder), only for the
// placeholder company, and only if that company has no bills yet. It leaves
// a few things deliberately undone so there is work waiting for a person: a
// rent bill for the owner to approve, a utility bill for the store manager,
// two bills held at the gates, a possible duplicate, this week's timecards,
// Friday's sweeps to confirm and two bank lines nobody can explain.

import { tx, q, one, type Client } from "../packages/core/db.ts";
import { planSweeps, confirmTransfer } from "../packages/core/banking.ts";
import { autoMatch } from "../packages/core/reconcile.ts";
import { runGates, postToLedger } from "../packages/core/invoice.ts";
import { loadCompany, type Company } from "./views.ts";
import {
  scopeOf, decideRequest, createPaymentRun, submitPaymentRun, releasePaymentRun,
  approveTimecards, buildPayroll, requestPayroll, releasePayroll, postPayroll, type Actor,
} from "./actions.ts";

const MARK = "sample/activity-v1";
const PLACEHOLDER_COMPANY = "22222222-2222-2222-2222-222222222222";

// ------------------------------------------------------------------ dates

const toDate = (s: string) => new Date(s + "T00:00:00Z");
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = (s: string) => toDate(s).getUTCDay();
const isBankDay = (s: string) => dow(s) >= 1 && dow(s) <= 5;
const nextBankDay = (s: string) => { let x = addDays(s, 1); while (!isBankDay(x)) x = addDays(x, 1); return x; };
const addBankDays = (s: string, n: number) => { let x = s; for (let i = 0; i < n; i++) x = nextBankDay(x); return x; };
const compact = (s: string) => s.slice(2).replace(/-/g, "");

// Same seed, same numbers: the sample reads the same on every fresh trial.
function rng(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h = (h + 0x6D2B79F5) >>> 0; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cents = (r: () => number, lo: number, hi: number) => BigInt(Math.round((lo + r() * (hi - lo)) * 100));

type Line = { posted: string; description: string; amount: bigint; ref: string };

export async function loadSampleActivity(log: (s: string) => void): Promise<void> {
  await tx({ kind: "system", label: "trial sample" }, async (c) => {
    const done = await q(c, `select 1 from schema_migration where filename = $1 /* unscoped: install bookkeeping */`, [MARK]);
    if (done.length) return;
    const mark = () => c.query(`insert into schema_migration (filename, sha256) values ($1, 'sample')`, [MARK]);

    const co = await loadCompany(c, PLACEHOLDER_COMPANY);
    if (!co) { await mark(); return; }
    const has = await q(c, `select 1 from invoice where entity_id = $1 limit 1`, [co.id]);
    if (has.length) { log("sample activity skipped: the trial company already has bills"); await mark(); return; }

    const summary = await build(c, co, log);
    await mark();
    log(`sample activity loaded: ${summary}`);
  });
}

async function build(c: Client, co: Company, log: (s: string) => void): Promise<string> {
  // ------------------------------------------------------------- people
  const byRole = async (role: string) => (await q<{ id: string; name: string }>(c, `
    select u.id, u.name from role_grant g join app_user u on u.id = g.app_user_id
     where g.role = $2 and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $3))
     order by g.entity_id nulls last limit 1`, [co.id, role, co.tenantId]))[0];
  const people = {
    owner: await byRole("owner"), controller: await byRole("controller"),
    clerk: await byRole("ap_clerk"), approver: await byRole("approver"),
  };
  if (!people.owner || !people.controller || !people.clerk || !people.approver) {
    log("sample activity skipped: the trial's people are not all there");
    return "nothing (people missing)";
  }
  const as = (p: { id: string; name: string }): Actor => ({ personId: p.id, personName: p.name, label: `${p.name} (trial sample)` });
  const owner = as(people.owner), controller = as(people.controller), clerk = as(people.clerk), approver = as(people.approver);
  const reconciler = { ...controller, label: "nightly reconciler (trial sample)" };

  // -------------------------------------------------------------- dates
  const today = (await one<{ d: string }>(c, `select current_date::text as d /* unscoped: the clock */`)).d;
  const yesterday = addDays(today, -1);
  let start = today.slice(0, 8) + "01";
  if ((toDate(today).getTime() - toDate(start).getTime()) / 86_400_000 < 14) start = addDays(today, -21);
  const storeDays: string[] = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) if (dow(d) !== 0) storeDays.push(d);
  const lastBankDay = [...storeDays].reverse().find(isBankDay) ?? yesterday;

  // -------------------------------------------------------- the company
  const gl: Record<string, string> = {};
  for (const r of await q<{ id: string; code: string }>(c, `
      select id, code from gl_account where tenant_id = $1 /* unscoped: the chart is tenant-wide */`, [co.tenantId])) gl[r.code] = r.id;
  const banks = await q<{ id: string; name: string; purpose: string; gl_account_id: string; location_id: string | null;
                          settlement_days: number; bank_name: string }>(c, `
    select id, name, purpose, gl_account_id, location_id, settlement_days, bank_name
      from bank_account where entity_id = $1 and status = 'active'`, [co.id]);
  const operating = banks.find((b) => b.purpose === "operating");
  const payrollBank = banks.find((b) => b.purpose === "payroll");
  const taxBank = banks.find((b) => b.purpose === "tax");
  const stores = await q<{ id: string; code: string; name: string; location_id: string }>(c, `
    select id, code, name, location_id from profit_object
     where entity_id = $1 and kind = 'store' and status = 'active' and location_id is not null order by code`, [co.id]);
  const branches = stores.map((s) => ({ store: s, bank: banks.find((b) => b.purpose === "deposit" && b.location_id === s.location_id) }))
    .filter((x) => x.bank) as { store: typeof stores[number]; bank: typeof banks[number] }[];
  if (!operating || !payrollBank || branches.length === 0) return "nothing (banking not set up)";

  // Card fees need somewhere to land at every branch, not just the one the seed set.
  await q(c, `update bank_account set fee_gl_account_id = $2
               where entity_id = $1 and purpose = 'deposit' and fee_gl_account_id is null`, [co.id, gl["6350"]]);

  const periodFor = async (day: string) => (await one<{ id: string }>(c, `
    select id from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [co.id, day])).id;

  const post = async (day: string, source: string, description: string,
                      lines: { gl: string; debit?: bigint; credit?: bigint; store?: string | null; bank?: string | null; memo?: string }[]) => {
    const je = await one<{ id: string }>(c, `
      insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description, posted_by, actor_kind)
      values ($1, $2, $3, $4, $5, $6, $7, 'system') returning id`,
      [co.tenantId, co.id, await periodFor(day), day, source, description, controller.personId]);
    let seq = 1;
    for (const l of lines) {
      await q(c, `
        insert into journal_line (journal_entry_id, seq, gl_account_id, profit_object_id, bank_account_id, debit_minor, credit_minor, memo)
        select $1, $2, $3, $4, $5, $6, $7, $8 where exists (select 1 from journal_entry where id = $1 and entity_id = $9)`,
        [je.id, seq++, l.gl, l.store ?? null, l.bank ?? null, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString(), l.memo ?? null, co.id]);
    }
    return je.id;
  };

  // ---------------------------------------------------- opening balances
  const openDay = addDays(start, -1);
  const opening: [typeof banks[number] | undefined, bigint][] = [
    [operating, 18422015n], [payrollBank, 2400000n], [taxBank, 3890000n],
  ];
  const openLines = opening.filter(([b]) => b).map(([b, amt]) => ({ gl: b!.gl_account_id, debit: amt, bank: b!.id, memo: "balance brought forward" }));
  const openTotal = opening.filter(([b]) => b).reduce((s, [, amt]) => s + amt, 0n);
  await post(openDay, "opening", "Balances brought forward", [...openLines, { gl: gl["3900"], credit: openTotal, memo: "balance brought forward" }]);

  // ------------------------------------------- takings, sweeps, the banks
  const lines = new Map<string, Line[]>(); // bank account id -> lines
  const addLine = (acct: string, l: Line) => {
    if (l.posted > yesterday) return; // tomorrow's statement has not come yet
    if (!lines.has(acct)) lines.set(acct, []);
    lines.get(acct)!.push(l);
  };
  const statementBalance = new Map<string, bigint>();
  const existingDeposits = new Set((await q<{ k: string }>(c, `
    select location_id::text || '|' || business_date::text as k from pos_deposit where entity_id = $1`, [co.id])).map((r) => r.k));

  const writeStatement = async (acct: string, day: string) => {
    const todays = (lines.get(acct) ?? []).filter((l) => l.posted === day);
    if (!todays.length) return null;
    const exists = await q(c, `select 1 from bank_statement s join bank_account b on b.id = s.bank_account_id
                                where s.bank_account_id = $1 and s.statement_date = $2 and b.entity_id = $3`, [acct, day, co.id]);
    if (exists.length) return null;
    const open = statementBalance.get(acct) ?? 600000n; // the float every branch keeps
    const close = todays.reduce((s, l) => s + l.amount, open);
    statementBalance.set(acct, close);
    const st = await one<{ id: string }>(c, `
      insert into bank_statement (bank_account_id, statement_date, opening_balance_minor, closing_balance_minor, source)
      select $1, $2, $3, $4, 'manual' where exists (select 1 from bank_account where id = $1 and entity_id = $5)
      returning id`, [acct, day, open.toString(), close.toString(), co.id]);
    for (const l of todays) {
      await q(c, `
        insert into bank_statement_line (bank_statement_id, posted_on, description, amount_minor, external_ref, bank_account_id)
        select $1, $2, $3, $4, $5, $6 where exists (select 1 from bank_account where id = $6 and entity_id = $7)`,
        [st.id, l.posted, l.description, l.amount.toString(), l.ref, acct, co.id]);
    }
    return st.id;
  };

  const socorroHeld = new Map<string, bigint>(); // cash held back one day to bank two days together
  const skipCardDay = storeDays[Math.max(0, storeDays.length - 5)];
  let takingsDays = 0, sweepsPlanned = 0, matched = 0, linesTotal = 0;

  for (const day of storeDays) {
    if (isBankDay(day)) {
      // Yesterday's sweeps show up on today's statements, and are confirmed on
      // that evidence before today's are planned -- otherwise the same money
      // would be counted twice.
      const pending = await q<{ id: string; method: string; amount_minor: string; from_bank_account_id: string; transfer_date: string }>(c, `
        select id, method, amount_minor, from_bank_account_id, transfer_date::text from bank_transfer
         where entity_id = $1 and status in ('expected', 'planned') order by transfer_date`, [co.id]);
      for (const t of pending) {
        await confirmTransfer(c, scopeOf(co, controller), { transferId: t.id, confirmedBy: controller.personId, onDate: day });
        addLine(t.from_bank_account_id, {
          posted: day, amount: -BigInt(t.amount_minor), ref: `SWP${compact(t.transfer_date)}${t.method === "bank_zba" ? "Z" : "M"}`,
          description: t.method === "bank_zba" ? "ZBA TRANSFER DEBIT TO XX7788" : "ONLINE TRANSFER TO XX7788",
        });
      }
      if (day === lastBankDay) {
        const enola = branches[0].bank;
        addLine(enola.id, { posted: day, amount: 317n, ref: `INT${compact(day)}`, description: "INTEREST PAID" });
      }
      // The night's reconciliation, account by account.
      for (const b of branches) {
        const st = await writeStatement(b.bank.id, day);
        if (st) {
          const r = await autoMatch(c, scopeOf(co, reconciler, "agent"), { bankAccountId: b.bank.id, statementId: st, ranBy: controller.personId });
          matched += r.linesMatched; linesTotal += r.linesTotal;
        }
      }
    }

    // The day's takings at each store.
    for (const { store, bank } of branches) {
      const r = rng(`${store.code}|${day}`);
      const seeded = existingDeposits.has(`${store.location_id}|${day}`);
      let cash = cents(r, 280, 820), card = cents(r, 780, 2350);
      if (seeded) {
        // The seed already imported this day's POS takings; post those amounts.
        const s = await q<{ method: string; amount_minor: string }>(c, `
          select method, amount_minor from pos_deposit where entity_id = $1 and location_id = $2 and business_date = $3`,
          [co.id, store.location_id, day]);
        cash = s.filter((x) => x.method !== "card").reduce((t, x) => t + BigInt(x.amount_minor), 0n);
        card = s.filter((x) => x.method === "card").reduce((t, x) => t + BigInt(x.amount_minor), 0n);
      }
      const total = cash + card;
      if (total === 0n) continue;
      const fees = total * 8n / 100n; // late fees, processing, club -- the non-rental revenue
      await post(day, "deposit", `Takings, ${store.name}`, [
        { gl: bank.gl_account_id, debit: total, bank: bank.id, memo: "day's takings" },
        { gl: gl["4010"], credit: total - fees, store: store.id, memo: "rental payments" },
        { gl: gl["4020"], credit: fees, store: store.id, memo: "fees and other" },
      ]);
      takingsDays++;
      if (seeded) continue;

      const cashOn = nextBankDay(day);
      const cardOn = addBankDays(day, bank.settlement_days || 1);
      for (const [method, amount, on] of [["cash", cash, cashOn], ["card", card, cardOn]] as [string, bigint, string][]) {
        await q(c, `
          insert into pos_deposit (tenant_id, entity_id, location_id, bank_account_id, business_date, method, amount_minor, expected_on, source_ref)
          select $1, $2, $3, $4, $5, $6, $7, $8, $9 where exists (select 1 from bank_account where id = $4 and entity_id = $2)`,
          [co.tenantId, co.id, store.location_id, bank.id, day, method, amount.toString(), on, `sample:${store.code}:${day}:${method}`]);
      }
      // What the bank will show for it.
      if (store.code === "SOC" && dow(day) === 4) {
        socorroHeld.set(store.id, cash); // Thursday's cash goes in with Friday's
      } else {
        const held = socorroHeld.get(store.id) ?? 0n;
        socorroHeld.delete(store.id);
        addLine(bank.id, { posted: cashOn, amount: cash + held, ref: `DEP${compact(day)}${store.code}`,
                           description: held ? "BRANCH DEPOSIT 2 BAGS" : "BRANCH DEPOSIT" });
      }
      if (!(store.code === "PAL" && day === skipCardDay)) {
        const fee = card * BigInt(220 + Math.floor(r() * 70)) / 10000n;
        addLine(bank.id, { posted: cardOn, amount: card - fee, ref: `CRD${compact(day)}${store.code}`,
                           description: "MERCHANT SETTLEMENT BANKCARD" });
      }
    }

    if (isBankDay(day)) {
      const planned = await planSweeps(c, scopeOf(co, controller, "system"), { asOf: day, createdBy: controller.personId });
      sweepsPlanned += planned.length;
      for (const p of planned) {
        if (p.method !== "ach_pull") continue;
        const t = await one<{ from_bank_account_id: string }>(c, `
          select from_bank_account_id from bank_transfer where id = $1 and entity_id = $2`, [p.transferId, co.id]);
        addLine(t.from_bank_account_id, { posted: nextBankDay(day), amount: -p.amountMinor, ref: `ACH${compact(day)}`,
                                          description: "ACH DEBIT PENTEX CONCENTRATION" });
      }
    }
  }
  // Anything from before the sample (the seed's own statement) gets its turn too.
  const leftover = await q<{ id: string; bank_account_id: string }>(c, `
    select distinct s.id, s.bank_account_id, s.statement_date from bank_statement s
      join bank_account b on b.id = s.bank_account_id and b.entity_id = $1 and b.purpose = 'deposit'
      join bank_statement_line l on l.bank_statement_id = s.id and l.match_status = 'unmatched'
     order by s.statement_date`, [co.id]);
  for (const s of leftover) {
    const r = await autoMatch(c, scopeOf(co, reconciler, "agent"), { bankAccountId: s.bank_account_id, statementId: s.id, ranBy: controller.personId });
    matched += r.linesMatched; linesTotal += r.linesTotal;
  }

  // ------------------------------------------------------------ vendors
  const vendorId = async (name: string) => (await one<{ id: string }>(c, `
    select v.id from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $1
     where v.legal_name = $2`, [co.id, name])).id;
  const template = async (vendor: string, glCode: string, expected: bigint, tolBps: number) => {
    const ve = await one<{ id: string }>(c, `select id from vendor_entity where vendor_id = $1 and entity_id = $2`, [vendor, co.id]);
    const has = await q(c, `select 1 from vendor_template t join vendor_entity ve on ve.id = t.vendor_entity_id
                             where t.vendor_entity_id = $1 and ve.entity_id = $2 and t.status = 'active'`, [ve.id, co.id]);
    if (has.length) return;
    await q(c, `
      insert into vendor_template (vendor_entity_id, gl_account_id, expected_amount_minor, tolerance_bps, cadence, built_from_count, status)
      select $1, $2, $3, $4, 'monthly', 3, 'active' where exists (select 1 from vendor_entity where id = $1 and entity_id = $5)`,
      [ve.id, gl[glCode], expected.toString(), tolBps, co.id]);
  };
  const newVendor = async (name: string, glCode: string, terms: number) => {
    const v = await one<{ id: string }>(c, `
      insert into vendor (tenant_id, legal_name, is_1099, w9_on_file, status, created_by)
      values ($1, $2, false, true, 'active', $3) returning id`, [co.tenantId, name, clerk.personId]);
    await q(c, `
      insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id, status)
      select $1, $2, $3, $4, 'active' where exists (select 1 from entity where id = $2 and tenant_id = $5)
      /* unscoped: inserting this company's own row */`, [v.id, co.id, terms, gl[glCode], co.tenantId]);
    return v.id;
  };

  const power = await vendorId("Valley Power and Light");
  const fuel = await vendorId("Lone Star Fuel Services");
  const repairs = await vendorId("Bridgeway Repairs");
  const supply = await vendorId("Meridian Supply");
  await template(fuel, "6310", 42500n, 3000);
  await template(repairs, "6200", 61240n, 2500);
  const landlords = [
    { store: "ENL", name: "Enola Plaza Partners", rent: 320000n },
    { store: "PAL", name: "Palestine Commons LLC", rent: 265000n },
    { store: "SOC", name: "Socorro Retail Center", rent: 240000n },
  ];
  const rentVendor: Record<string, string> = {};
  for (const l of landlords) {
    rentVendor[l.store] = await newVendor(l.name, "6400", 5);
    await template(rentVendor[l.store], "6400", l.rent, 0);
  }

  // -------------------------------------------------------------- bills
  const storeId = (code: string) => stores.find((s) => s.code === code)?.id ?? null;
  const enter = async (vendor: string, ref: string, day: string, amount: bigint, glCode: string, store: string | null,
                       kind: "operating" | "merchandise" = "operating") => {
    const d = day > yesterday ? yesterday : day;
    const inv = await one<{ id: string }>(c, `
      insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, confidence_bps, created_by)
      select $1, $2, $3, $4, $5, $6::date, $6::date + ve.terms_days, $7, 9800, $8
        from vendor_entity ve where ve.vendor_id = $3 and ve.entity_id = $2
      returning id`, [co.tenantId, co.id, vendor, kind, ref, d, amount.toString(), clerk.personId]);
    await q(c, `
      insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, amount_minor)
      select $1, 1, $2, $3, $4 where exists (select 1 from invoice where id = $1 and entity_id = $5)`,
      [inv.id, gl[glCode], store, amount.toString(), co.id]);
    const out = await runGates(c, scopeOf(co, clerk), inv.id, clerk.personId);
    if (out.status === "approved") await postToLedger(c, scopeOf(co, clerk), inv.id);
    return { id: inv.id, status: out.status };
  };
  const approve = async (billId: string, who: Actor, note: string) => {
    const r = await one<{ id: string }>(c, `
      select id from approval_request where entity_id = $1 and subject_type = 'invoice' and subject_id = $2 and status = 'open'`,
      [co.id, billId]);
    await decideRequest(c, co, who, { requestId: r.id, decision: "approved", note });
  };

  const d = (n: number) => addDays(start, n);
  const b1 = await enter(power, `VPL-${compact(d(1))}-ENL`, d(1), 118430n, "6410", storeId("ENL"));
  const b2 = await enter(power, `VPL-${compact(d(1))}-PAL`, d(1), 132210n, "6410", storeId("PAL"));
  await enter(power, `VPL-${compact(d(3))}-PAL-R`, d(3), 132210n, "6410", storeId("PAL")); // the same bill, re-sent
  const fuelBills = [];
  for (const [i, amt] of [[2, 41260n], [9, 45520n], [16, 39875n]] as [number, bigint][]) {
    if (d(i) <= yesterday) fuelBills.push(await enter(fuel, `LSF-${compact(d(i))}`, d(i), amt, "6310", storeId(["PAL", "SOC", "ENL"][i % 3])));
  }
  const b9 = await enter(repairs, `BR-${compact(d(5))}`, d(5), 61240n, "6200", storeId("PAL"));
  await enter(repairs, `BR-${compact(addDays(yesterday, -4))}`, addDays(yesterday, -4), 185000n, "6200", storeId("SOC"));
  // Merchandise: four pieces ordered, two received, all four billed. The
  // three-way match stops it until someone sorts out the missing two.
  {
    const po = await one<{ id: string }>(c, `
      insert into purchase_order (tenant_id, entity_id, vendor_id, number, ordered_on, profit_object_id, created_by)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [co.tenantId, co.id, supply, `PO-${compact(d(2))}`, d(2), storeId("ENL"), clerk.personId]);
    const items: [string, number, bigint][] = [["Sectional sofa, grey", 2, 121500n], ["Power recliner, brown", 2, 121500n]];
    const poLines: string[] = [];
    for (const [i, [desc, qty, price]] of items.entries()) {
      poLines.push((await one<{ id: string }>(c, `
        insert into purchase_order_line (purchase_order_id, seq, description, quantity, unit_price_minor, gl_account_id)
        select $1, $2, $3, $4, $5, $6 where exists (select 1 from purchase_order where id = $1 and entity_id = $7)
        returning id`, [po.id, i + 1, desc, qty, price.toString(), gl["1210"], co.id])).id);
    }
    const gr = await one<{ id: string }>(c, `
      insert into goods_receipt (purchase_order_id, received_on, received_by, note)
      select $1, $2, $3, $4 where exists (select 1 from purchase_order where id = $1 and entity_id = $5)
      returning id`, [po.id, d(5), clerk.personId, "sofas in; recliners back-ordered", co.id]);
    await q(c, `
      insert into goods_receipt_line (goods_receipt_id, purchase_order_line_id, quantity, unit_ids)
      select $1, $2, 2, array['ENL-1041', 'ENL-1042'] where exists (select 1 from purchase_order where id = $3 and entity_id = $4)`,
      [gr.id, poLines[0], po.id, co.id]);
    const billDay = d(6) > yesterday ? yesterday : d(6);
    const inv = await one<{ id: string }>(c, `
      insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor,
                           confidence_bps, purchase_order_id, created_by)
      select $1, $2, $3, 'merchandise', $4, $5::date, $5::date + ve.terms_days, $6, 9700, $7, $8
        from vendor_entity ve where ve.vendor_id = $3 and ve.entity_id = $2
      returning id`, [co.tenantId, co.id, supply, `MS-${compact(billDay)}`, billDay, "486000", po.id, clerk.personId]);
    for (const [i, lineId] of poLines.entries()) {
      await q(c, `
        insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, purchase_order_line_id, description, amount_minor)
        select $1, $2, $3, $4, $5, $6, $7 where exists (select 1 from invoice where id = $1 and entity_id = $8)`,
        [inv.id, i + 1, gl["1210"], storeId("ENL"), lineId, items[i][0], (BigInt(items[i][1]) * items[i][2]).toString(), co.id]);
    }
    await runGates(c, scopeOf(co, clerk), inv.id, clerk.personId);
  }
  const rents: Record<string, { id: string; status: string }> = {};
  for (const l of landlords) rents[l.store] = await enter(rentVendor[l.store], `RENT-${start.slice(0, 7)}-${l.store}`, start, l.rent, "6400", storeId(l.store));
  const b3 = await enter(power, `VPL-${compact(addDays(yesterday, -2))}-SOC`, addDays(yesterday, -2), 124175n, "6410", storeId("SOC"));

  await approve(b1.id, approver, "matches the meter read");
  await approve(b2.id, approver, "in line with last month");
  await approve(rents.ENL.id, approver, "lease rate confirmed");
  await approve(rents.SOC.id, approver, "lease rate confirmed");
  void b3; // left for the store manager, with Palestine's rent

  // A quarterly premium big enough to need two people: the manager has
  // approved it; the controller has not yet.
  const insurer = await newVendor("Lone Star Mutual Insurance", "6500", 15);
  await template(insurer, "6500", 1248000n, 0);
  const premium = await enter(insurer, `LSM-Q4-${start.slice(0, 4)}`, addDays(yesterday, -3), 1248000n, "6500", null);
  if (premium.status === "pending") await approve(premium.id, approver, "premium matches the renewal quote");

  // ------------------------------------------------------- a payment run
  let payDay = d(10);
  while (!isBankDay(payDay)) payDay = addDays(payDay, 1);
  if (payDay > yesterday) payDay = addDays(yesterday, -1);
  const toPay = await q<{ id: string }>(c, `
    select id from invoice where entity_id = $1 and status = 'approved' and invoice_date <= $2::date`, [co.id, payDay]);
  let paid = 0;
  if (toPay.length) {
    const run = await createPaymentRun(c, co, clerk, { payDate: payDay, method: "ach", invoiceIds: toPay.map((x) => x.id) }, { allowPast: true });
    await submitPaymentRun(c, co, clerk, { id: run.id });
    const r = await q<{ id: string }>(c, `
      select id from approval_request where entity_id = $1 and subject_type = 'payment_run' and subject_id = $2 and status = 'open'`,
      [co.id, run.id]);
    if (r.length) await decideRequest(c, co, controller, { requestId: r[0].id, decision: "approved", note: "run reviewed against the aging" });
    await releasePaymentRun(c, co, owner, { id: run.id });
    paid = toPay.length;
  }
  void b9; void fuelBills;

  // ------------------------------------------------------------ payroll
  const group = (await q<{ id: string }>(c, `select id from pay_group where entity_id = $1 and status = 'active' limit 1`, [co.id]))[0];
  let runs = 0;
  if (group) {
    let last = (await q<{ starts_on: string; ends_on: string; pay_date: string }>(c, `
      select starts_on::text, ends_on::text, pay_date::text from pay_period pp
        join pay_group pg on pg.id = pp.pay_group_id
       where pp.pay_group_id = $1 and pg.entity_id = $2 order by starts_on desc limit 1`, [group.id, co.id]))[0];
    for (let guard = 0; last && last.ends_on < today && guard < 8; guard++) {
      last = await one(c, `
        insert into pay_period (pay_group_id, starts_on, ends_on, pay_date)
        select $1, $2::date + 7, $3::date + 7, $4::date + 7 where exists (select 1 from pay_group where id = $1 and entity_id = $5)
        returning starts_on::text, ends_on::text, pay_date::text`, [group.id, last.starts_on, last.ends_on, last.pay_date, co.id]);
    }
    const periods = await q<{ id: string; starts_on: string; ends_on: string; status: string }>(c, `
      select pp.id, pp.starts_on::text, pp.ends_on::text, pp.status from pay_period pp
        join pay_group pg on pg.id = pp.pay_group_id
       where pp.pay_group_id = $1 and pg.entity_id = $2 and pp.status in ('open', 'timecards_approved')
       order by pp.starts_on`, [group.id, co.id]);
    const staff = await q<{ id: string; profit_object_id: string | null; employee_no: string }>(c, `
      select id, profit_object_id, employee_no from employee where entity_id = $1 and status = 'active' order by employee_no`, [co.id]);
    for (const p of periods) {
      const cards = await q<{ n: number }>(c, `
        select count(*)::int as n from timecard t join employee e on e.id = t.employee_id and e.entity_id = $2
         where t.pay_period_id = $1`, [p.id, co.id]);
      if (cards[0].n === 0) {
        for (const [i, e] of staff.entries()) {
          for (let day = p.starts_on; day <= p.ends_on && day < today; day = addDays(day, 1)) {
            if (dow(day) === 0 || dow(day) === 1) continue; // stores' staff work Tuesday to Saturday
            const r = rng(`${e.employee_no}|${day}`);
            const hours = (i === 1 ? 8.5 : 7) + Math.round(r() * 4) / 2; // one of them runs into overtime
            await q(c, `
              insert into timecard (employee_id, pay_period_id, worked_on, hours, profit_object_id, source, status)
              select $1, $2, $3, $4, $5, 'clock', 'recorded' where exists (select 1 from employee where id = $1 and entity_id = $6)`,
              [e.id, p.id, day, hours, e.profit_object_id, co.id]);
          }
        }
      }
      if (p.ends_on >= today) continue; // this week's are left for a person
      await approveTimecards(c, co, approver, { periodId: p.id });
      const built = await buildPayroll(c, co, clerk, { periodId: p.id });
      await requestPayroll(c, co, clerk, { runId: built.runId });
      const r = await q<{ id: string }>(c, `
        select id from approval_request where entity_id = $1 and subject_type = 'payroll_run' and subject_id = $2 and status = 'open'`,
        [co.id, built.runId]);
      if (r.length) await decideRequest(c, co, owner, { requestId: r[0].id, decision: "approved", note: "register reviewed" });
      await releasePayroll(c, co, controller, { runId: built.runId });
      await postPayroll(c, co, controller, { runId: built.runId });
      runs++;
    }
  }

  return `${takingsDays} store-days of takings, ${sweepsPlanned} sweeps, ${matched} of ${linesTotal} bank lines matched, ` +
         `bills entered with ${paid} paid, ${runs} payroll run${runs === 1 ? "" : "s"} posted`;
}
