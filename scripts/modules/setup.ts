// Business setup checks: packs only add, modules switch per company, imports
// match and refuse the right rows, opening balances post once and balance.
import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { scopeOf } from "../../server/actions.ts";
import { applyPack, enabledModules, setModule, importCustomers, importOpenAr, saveLocation, parseCsv, setting, PACKS, MODULE_IDS } from "../../packages/core/setup.ts";

export async function run(t: T) {
  const c = await t.pool.connect();
  const count = async (sql: string, p: unknown[]) => Number((await c.query(sql, p)).rows[0].n);
  try {
    t.ok("five packs ship in the box", PACKS.length === 5, PACKS.map((p) => p.id).join(", "));
    t.ok("a company with no pack sees every module", (await enabledModules(c, ENTITY)).length === MODULE_IDS.length);
  } finally { c.release(); }

  const r1 = await t.as(PEOPLE.STEVE, (c, co, a) => applyPack(c, scopeOf(co, a), "furniture", "Steve"));
  t.ok("the furniture pack applies", r1.pack === "furniture" && r1.modulesOn === PACKS.find((p) => p.id === "furniture")!.modules.length, JSON.stringify(r1));
  const r2 = await t.as(PEOPLE.STEVE, (c, co, a) => applyPack(c, scopeOf(co, a), "furniture", "Steve"));
  t.ok("applying it again adds nothing", r2.accountsAdded === 0 && r2.reasonsAdded === 0 && r2.settingsAdded === 0);

  // A person's own setting survives a pack.
  await t.as(PEOPLE.STEVE, async (c) => {
    await c.query(`update entity_setting set value = '2500', from_pack = false where entity_id = $1 and key = 'pos.discount_limit_bps'`, [ENTITY]);
  });
  await t.as(PEOPLE.STEVE, (c, co, a) => applyPack(c, scopeOf(co, a), "appliance", "Steve"));
  const lim = await t.as(PEOPLE.STEVE, (c) => setting(c, ENTITY, "pos.discount_limit_bps", 0));
  t.ok("a pack never overwrites a setting someone changed", Number(lim) === 2500, String(lim));

  await t.as(PEOPLE.STEVE, (c) => setModule(c, ENTITY, "fleet", false, "Steve"));
  const mods = await t.as(PEOPLE.STEVE, (c) => enabledModules(c, ENTITY));
  t.ok("turning fleet off leaves the rest on", !mods.includes("fleet") && mods.length === MODULE_IDS.length - 1);
  const rio = await t.as(PEOPLE.STEVE, (c) => enabledModules(c, RIO_ENTITY));
  t.ok("another client's company is untouched", rio.length === MODULE_IDS.length && rio.includes("fleet"));
  await t.as(PEOPLE.STEVE, (c) => setModule(c, ENTITY, "fleet", true, "Steve"));
  await t.throws("an unknown module is refused", () => t.as(PEOPLE.STEVE, (c) => setModule(c, ENTITY, "payroll2", true, "Steve")), /no module called/);

  // CSV parsing handles quotes, commas in fields and CRLF.
  const parsed = parseCsv('Number,Name,Email\r\n"C-9","Smith, Jo ""JJ""",jo@example.com\r\n');
  t.ok("CSV: quoted comma and doubled quote", parsed.length === 1 && parsed[0].name === 'Smith, Jo "JJ"' && parsed[0].number === "C-9");

  const csv = [
    "number,name,email,phone,address,city,state,zip,credit_limit,terms_days",
    "C-000001,Alicia Gomez-Ruiz,alicia@example.com,717-555-0101,12 Oak Ln,Camp Hill,PA,17011,500,0",
    "LEG-1001,Frank Ortiz,frank@example.com,717-555-0199,5 Pine St,Enola,PA,17025,\"1,250.00\",30",
    ",Nameless No Number,not-an-email,,,,,,,",
    "LEG-1002,,x@example.com,,,,,,,",
  ].join("\n");
  const imp = await t.as(PEOPLE.CONTROLLER, (c, co, a) => importCustomers(c, scopeOf(co, a), csv, "legacy.csv", "Controller"));
  t.ok("customer import: one matched and updated, one added", imp.updated === 1 && imp.added === 1, JSON.stringify(imp));
  t.ok("customer import: bad email and missing name refused with row numbers",
    imp.problems.some((p) => p.row === 4 && /email/.test(p.problem)) && imp.problems.some((p) => p.row === 5 && /no name/.test(p.problem)));
  const frank = await t.as(PEOPLE.STEVE, async (c) => (await c.query(
    `select c.credit_limit_minor, c.terms_days, a.city from customer c left join customer_address a on a.customer_id = c.id
      where c.entity_id = $1 and c.number = 'LEG-1001'`, [ENTITY])).rows[0]);
  t.ok("imported money is exact cents and the address came with it", frank && frank.credit_limit_minor === "125000" && frank.city === "Enola");

  const ar = [
    "customer_number,reference,as_of,due_on,balance",
    "LEG-1001,OLD-INV-77,2026-11-01,2026-12-01,312.45",
    "C-000003,OLD-INV-78,2026-11-01,,-20.00",
    "NOPE-1,OLD-INV-79,2026-11-01,,10",
    "LEG-1001,OLD-INV-80,11/01/2026,,10",
  ].join("\n");
  const o1 = await t.as(PEOPLE.CONTROLLER, (c, co, a) => importOpenAr(c, scopeOf(co, a), ar, "ar.csv", "Controller"));
  t.ok("open A/R: two balances in, a credit included", o1.added === 2 && o1.totalMinor === 29245n, `${o1.added} ${o1.totalMinor}`);
  t.ok("open A/R: unknown customer and bad date refused", o1.problems.length === 2);
  const o2 = await t.as(PEOPLE.CONTROLLER, (c, co, a) => importOpenAr(c, scopeOf(co, a), ar, "ar.csv", "Controller"));
  t.ok("open A/R: the same file twice adds nothing", o2.added === 0 && o2.problems.filter((p) => /already imported/.test(p.problem)).length === 2);
  const tb = await t.as(PEOPLE.STEVE, async (c) => (await c.query(`
    select coalesce(sum(jl.debit_minor - jl.credit_minor),0)::text n from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
      join gl_account g on g.id = jl.gl_account_id where g.code = '1100' and je.source_type = 'opening'`, [ENTITY])).rows[0].n);
  t.ok("open A/R ties to the ledger: 1100 carries $292.45", tb === "29245", tb);

  const dc2 = await t.as(PEOPLE.STEVE, (c, co, a) => saveLocation(c, scopeOf(co, a), {
    code: "dc2", name: "South DC", kind: "warehouse", taxRateBps: 0, address: { line1: "9 Dock Rd", city: "El Paso", state: "TX", postal: "79901" }, lng: -106.44, lat: 31.76 }));
  t.ok("a warehouse is added with a map point", !!dc2);
  const outlet = await t.as(PEOPLE.STEVE, (c, co, a) => saveLocation(c, scopeOf(co, a), { code: "OUT1", name: "Clearance outlet", kind: "outlet", taxRateBps: 825 }));
  const po = await t.as(PEOPLE.STEVE, async (c) => (await c.query(`select count(*)::int n from profit_object where entity_id = $1 and location_id = $2`, [ENTITY, outlet])).rows[0].n);
  t.ok("a selling location gets its own P&L column", po === 1);
  await t.throws("a 25% tax rate is refused", () => t.as(PEOPLE.STEVE, (c, co, a) => saveLocation(c, scopeOf(co, a), { code: "BAD", name: "Bad", kind: "store", taxRateBps: 2500 })), /between 0% and 20%/);
  await t.throws("a location kind outside the list is refused", () => t.as(PEOPLE.STEVE, (c, co, a) => saveLocation(c, scopeOf(co, a), { code: "BAD", name: "Bad", kind: "garage" })), /one of/);
}
