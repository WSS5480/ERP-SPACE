// Payroll: time in, gross, the register, approval, release, and the posting.
//
// Tax calculation and tax filing are NOT here. They are bought, because the
// rates move constantly and the penalties land on the employer. What this
// module owns is everything above that line -- and the register it hands the
// provider, which is the part that makes the system yours rather than theirs.
//
// Nothing below is industry-specific. It runs for a store group, a haulier
// or a services firm; only the profit object means something different.

import { type Client, type Scope, audit, one, q } from "./db.ts";
import { openRequest } from "./approvals.ts";
import { mulBps } from "./money.ts";

// ------------------------------------------------------------- tax seam --

export type TaxInput = {
  employeeId: string;
  workState: string;
  grossMinor: bigint;
  preTaxDeductionsMinor: bigint;
};

export type TaxResult = {
  employeeTaxMinor: bigint;
  employerTaxMinor: bigint;
};

export interface TaxProvider {
  readonly name: string;
  calculate(input: TaxInput[]): Promise<Map<string, TaxResult>>;
}

/**
 * Illustrative only. Flat rates so the pipeline can be exercised end to end.
 * A real install swaps this for the provider that also files, and the swap
 * is this one interface.
 */
export class IllustrativeTaxProvider implements TaxProvider {
  readonly name = "illustrative (not for filing)";
  async calculate(input: TaxInput[]): Promise<Map<string, TaxResult>> {
    const out = new Map<string, TaxResult>();
    for (const i of input) {
      const taxable = i.grossMinor - i.preTaxDeductionsMinor;
      out.set(i.employeeId, {
        employeeTaxMinor: mulBps(taxable, 1450), // withholding + employee FICA
        employerTaxMinor: mulBps(taxable, 920),  // employer FICA + unemployment
      });
    }
    return out;
  }
}

export class PayrollError extends Error {}

// ------------------------------------------------------------ schedules --
//
// Dates are YYYY-MM-DD strings, worked in UTC so no time zone moves a day.

export type Frequency = "weekly" | "biweekly" | "semimonthly" | "monthly";
export const PERIODS_PER_YEAR: Record<Frequency, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
export const isFrequency = (s: unknown): s is Frequency =>
  s === "weekly" || s === "biweekly" || s === "semimonthly" || s === "monthly";

const DAY = 86_400_000;
const toUtc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fromUtc(toUtc(s) + n * DAY);
export const dayOfWeek = (s: string) => new Date(toUtc(s)).getUTCDay(); // 0 = Sunday
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY);
const endOfMonth = (s: string) => fromUtc(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0));

/** Pay date: so many days after the period ends; a weekend moves to the Friday before. Bank holidays are not known yet. */
export function payDateFor(endsOn: string, lagDays: number): string {
  const d = addDays(endsOn, lagDays);
  const w = dayOfWeek(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

/** Where a schedule's periods may start: semimonthly on the 1st or the 16th, monthly on the 1st. */
export function periodStartProblem(freq: Frequency, startsOn: string): string | null {
  const day = Number(startsOn.slice(8, 10));
  if (freq === "semimonthly" && day !== 1 && day !== 16) return "a semimonthly period starts on the 1st or the 16th";
  if (freq === "monthly" && day !== 1) return "a monthly period starts on the 1st";
  return null;
}

/** The period of a schedule that starts on a given day. */
export function periodStartingOn(freq: Frequency, startsOn: string, lagDays: number) {
  let endsOn: string;
  if (freq === "weekly") endsOn = addDays(startsOn, 6);
  else if (freq === "biweekly") endsOn = addDays(startsOn, 13);
  else if (freq === "semimonthly") endsOn = Number(startsOn.slice(8, 10)) <= 15 ? `${startsOn.slice(0, 8)}15` : endOfMonth(startsOn);
  else endsOn = endOfMonth(startsOn);
  return { startsOn, endsOn, payDate: payDateFor(endsOn, lagDays) };
}

/** The period after the one that ends on endsOn. */
export const nextPeriod = (freq: Frequency, endsOn: string, lagDays: number) =>
  periodStartingOn(freq, addDays(endsOn, 1), lagDays);

/**
 * The first day of the workweek a day falls in. Weekly and biweekly groups
 * count workweeks from the period start, so a week never spans two periods;
 * semimonthly and monthly groups use the group's fixed workweek.
 */
export function workweekStart(day: string, freq: Frequency, periodStart: string, startDow: number): string {
  if (freq === "weekly" || freq === "biweekly") {
    return addDays(periodStart, 7 * Math.floor(daysBetween(periodStart, day) / 7));
  }
  return addDays(day, -((dayOfWeek(day) - startDow + 7) % 7));
}

/**
 * Regular and overtime hours for one person's period, counted per workweek as
 * federal rules require. A workweek that began in the previous period counts
 * the hours already paid there, and only the overtime not yet paid lands now.
 * Hours are worked in hundredths so nothing drifts.
 */
export function splitHours(
  days: { day: string; hours: number; prior: boolean }[],
  freq: Frequency, periodStart: string, startDow: number, overtimeAfter: number,
): { regular: number; overtime: number } {
  const cap = Math.round(overtimeAfter * 100);
  const weeks = new Map<string, { prior: number; now: number }>();
  for (const d of days) {
    const k = workweekStart(d.day, freq, periodStart, startDow);
    const w = weeks.get(k) ?? { prior: 0, now: 0 };
    const h = Math.round(d.hours * 100);
    if (d.prior) w.prior += h; else w.now += h;
    weeks.set(k, w);
  }
  let regular = 0, overtime = 0;
  for (const w of weeks.values()) {
    const ot = Math.max(0, w.prior + w.now - cap) - Math.max(0, w.prior - cap);
    overtime += ot;
    regular += w.now - ot;
  }
  return { regular: regular / 100, overtime: overtime / 100 };
}

const weekdaysBetween = (a: string, b: string) => {
  let n = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) { const w = dayOfWeek(d); if (w !== 0 && w !== 6) n++; }
  return n;
};

/**
 * One period's salary: the annual amount over the schedule's periods a year,
 * cut by weekdays when someone starts or leaves partway through.
 */
export function salaryForPeriod(annualMinor: bigint, freq: Frequency, startsOn: string, endsOn: string,
                                hiredOn: string, terminatedOn: string | null): bigint {
  const from = hiredOn > startsOn ? hiredOn : startsOn;
  const to = terminatedOn && terminatedOn < endsOn ? terminatedOn : endsOn;
  if (to < from) return 0n;
  const all = BigInt(weekdaysBetween(startsOn, endsOn));
  const worked = BigInt(weekdaysBetween(from, to));
  if (all === 0n) return 0n;
  const den = BigInt(PERIODS_PER_YEAR[freq]) * all;
  return (annualMinor * worked * 2n + den) / (den * 2n); // rounded to the cent
}

// --------------------------------------------------------------- build --

type LineDraft = {
  employeeId: string;
  profitObjectId: string | null;
  departmentId: string | null;
  compClassCode: string | null;
  regularHours: number;
  overtimeHours: number;
  grossMinor: bigint;
  deductions: { typeId: string; amountMinor: bigint; employerMatchMinor: bigint; preTax: boolean }[];
};

/**
 * Build one pay group's run for one period. Only that group's people are on
 * it: store staff paid weekly never share a register with managers paid
 * semimonthly.
 */
export async function buildRun(
  c: Client,
  scope: Scope,
  input: { payPeriodId: string; builtBy: string; taxProvider: TaxProvider }
): Promise<{ runId: string; grossMinor: bigint; netMinor: bigint; employees: number }> {
  const period = await one<{
    id: string; pay_group_id: string; status: string; pay_date: string; starts_on: string; ends_on: string;
    bank_account_id: string; overtime_after_hours: string; overtime_multiplier: string;
    frequency: Frequency; workweek_start_dow: number;
  }>(
    c,
    `select pp.id, pp.pay_group_id, pp.status, pp.pay_date::text as pay_date,
            pp.starts_on::text as starts_on, pp.ends_on::text as ends_on,
            pg.bank_account_id, pg.overtime_after_hours, pg.overtime_multiplier,
            pg.frequency, pg.workweek_start_dow
       from pay_period pp
       join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $2
      where pp.id = $1`,
    [input.payPeriodId, scope.entityId]
  );
  if (!["open", "timecards_approved"].includes(period.status))
    throw new PayrollError(`pay period is ${period.status}`);

  const otAfter = Number(period.overtime_after_hours);
  const otMult = Number(period.overtime_multiplier);

  // The group's people who were employed at some point in the period.
  const rows = await q<{
    employee_id: string; profit_object_id: string | null; department_id: string | null;
    comp_class_code: string | null; pay_type: string; base_rate_minor: string;
    hired_on: string; terminated_on: string | null; unapproved: number;
  }>(
    c,
    `select e.id as employee_id, e.profit_object_id, e.department_id, e.comp_class_code,
            e.pay_type, e.base_rate_minor, e.hired_on::text as hired_on, e.terminated_on::text as terminated_on,
            (select count(*) from timecard t
              where t.employee_id = e.id and t.pay_period_id = $1 and t.status <> 'approved')::int as unapproved
       from employee e
      where e.entity_id = $2 and e.pay_group_id = $3
        and e.hired_on <= $5::date
        and (e.status = 'active' or (e.status = 'terminated' and e.terminated_on >= $4::date))
      order by e.employee_no`,
    [input.payPeriodId, scope.entityId, period.pay_group_id, period.starts_on, period.ends_on]
  );

  const blocked = rows.filter((r) => Number(r.unapproved) > 0);
  if (blocked.length > 0)
    throw new PayrollError(`${blocked.length} employee(s) still have unapproved timecards`);

  // Approved time in this period, plus the days of a workweek that began in
  // the previous one, so overtime is counted over the whole workweek.
  const weekFrom = workweekStart(period.starts_on, period.frequency, period.starts_on, period.workweek_start_dow);
  const cards = await q<{ employee_id: string; day: string; hours: string; prior: boolean }>(
    c,
    `select t.employee_id, t.worked_on::text as day, sum(t.hours) as hours, (t.pay_period_id <> $1) as prior
       from timecard t
       join employee e on e.id = t.employee_id and e.entity_id = $2
      where e.pay_group_id = $3 and t.status = 'approved'
        and (t.pay_period_id = $1 or (t.worked_on >= $4::date and t.worked_on < $5::date))
      group by t.employee_id, t.worked_on, (t.pay_period_id <> $1)`,
    [input.payPeriodId, scope.entityId, period.pay_group_id, weekFrom, period.starts_on]
  );
  const byPerson = new Map<string, { day: string; hours: number; prior: boolean }[]>();
  for (const t of cards) {
    const list = byPerson.get(t.employee_id) ?? [];
    list.push({ day: t.day, hours: Number(t.hours), prior: t.prior });
    byPerson.set(t.employee_id, list);
  }

  const drafts: LineDraft[] = [];
  for (const r of rows) {
    const rate = BigInt(r.base_rate_minor);
    let regular = 0;
    let overtime = 0;
    let gross: bigint;

    if (r.pay_type === "hourly") {
      const days = byPerson.get(r.employee_id) ?? [];
      if (!days.some((d) => !d.prior && d.hours > 0)) continue;
      ({ regular, overtime } = splitHours(days, period.frequency, period.starts_on, period.workweek_start_dow, otAfter));
      gross =
        rate * BigInt(Math.round(regular * 100)) / 100n +
        mulBps(rate * BigInt(Math.round(overtime * 100)) / 100n, Math.round(otMult * 10000));
    } else {
      gross = salaryForPeriod(rate, period.frequency, period.starts_on, period.ends_on, r.hired_on, r.terminated_on);
      if (gross === 0n) continue;
    }

    const deds = await q<{
      id: string; kind: string; amount_minor: string | null;
      percent_bps: number | null; employer_match_bps: number | null;
    }>(
      c,
      `select dt.id, dt.kind, ed.amount_minor, ed.percent_bps, ed.employer_match_bps
         from employee_deduction ed
         join deduction_type dt on dt.id = ed.deduction_type_id
         join employee e on e.id = ed.employee_id and e.entity_id = $2
        where ed.employee_id = $1
          and ed.effective_from <= $3::date
          and (ed.effective_to is null or ed.effective_to >= $3::date)
        order by ed.priority`,
      [r.employee_id, scope.entityId, period.pay_date]
    );

    const deductions = deds.map((d) => {
      const amount = d.amount_minor ? BigInt(d.amount_minor) : mulBps(gross, d.percent_bps ?? 0);
      return {
        typeId: d.id,
        amountMinor: amount,
        employerMatchMinor: d.employer_match_bps ? mulBps(gross, d.employer_match_bps) : 0n,
        // retirement and the health plans reduce taxable pay; a garnishment does not
        preTax: ["retirement", "health", "dental", "vision", "hsa", "fsa"].includes(d.kind),
      };
    });

    drafts.push({
      employeeId: r.employee_id,
      profitObjectId: r.profit_object_id,
      departmentId: r.department_id,
      compClassCode: r.comp_class_code,
      regularHours: regular,
      overtimeHours: overtime,
      grossMinor: gross,
      deductions,
    });
  }

  if (drafts.length === 0) throw new PayrollError("no payable employees in this period");

  const tax = await input.taxProvider.calculate(
    drafts.map((d) => ({
      employeeId: d.employeeId,
      workState: "",
      grossMinor: d.grossMinor,
      preTaxDeductionsMinor: d.deductions.filter((x) => x.preTax).reduce((a, b) => a + b.amountMinor, 0n),
    }))
  );

  const run = await one<{ id: string }>(
    c,
    `insert into payroll_run
       (tenant_id, entity_id, pay_period_id, bank_account_id, built_by, tax_provider)
     values ($1,$2,$3,$4,$5,$6) returning id, entity_id`,
    [scope.tenantId, scope.entityId, input.payPeriodId, period.bank_account_id,
     input.builtBy, input.taxProvider.name]
  );

  let gross = 0n, empTax = 0n, erTax = 0n, deds = 0n, net = 0n;
  for (const d of drafts) {
    const t = tax.get(d.employeeId) ?? { employeeTaxMinor: 0n, employerTaxMinor: 0n };
    const dedTotal = d.deductions.reduce((a, b) => a + b.amountMinor, 0n);
    const lineNet = d.grossMinor - t.employeeTaxMinor - dedTotal;
    if (lineNet < 0n) throw new PayrollError(`deductions exceed pay for employee ${d.employeeId}`);

    const line = await one<{ id: string }>(
      c,
      `insert into payroll_line
         (payroll_run_id, employee_id, profit_object_id, department_id, regular_hours,
          overtime_hours, gross_minor, employee_tax_minor, employer_tax_minor,
          deductions_minor, net_minor, comp_class_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [run.id, d.employeeId, d.profitObjectId, d.departmentId, d.regularHours, d.overtimeHours,
       d.grossMinor.toString(), t.employeeTaxMinor.toString(), t.employerTaxMinor.toString(),
       dedTotal.toString(), lineNet.toString(), d.compClassCode]
    );

    for (const x of d.deductions) {
      await c.query(
        `insert into payroll_deduction (payroll_line_id, deduction_type_id, amount_minor, employer_match_minor)
         values ($1,$2,$3,$4)`,
        [line.id, x.typeId, x.amountMinor.toString(), x.employerMatchMinor.toString()]
      );
    }

    gross += d.grossMinor; empTax += t.employeeTaxMinor; erTax += t.employerTaxMinor;
    deds += dedTotal; net += lineNet;
  }

  await c.query(
    `update payroll_run set gross_minor=$2, employee_tax_minor=$3, employer_tax_minor=$4,
            deductions_minor=$5, net_minor=$6 where id=$1`,
    [run.id, gross.toString(), empTax.toString(), erTax.toString(), deds.toString(), net.toString()]
  );

  // What was deducted, and by when it has to be sent. The reconciliation that
  // catches everything else.
  await c.query(
    `insert into deduction_remittance
       (entity_id, deduction_type_id, payroll_run_id, deducted_minor, employer_match_minor, due_on)
     select $2, pd.deduction_type_id, $1,
            sum(pd.amount_minor), sum(pd.employer_match_minor),
            $3::date + dt.remit_within_days
       from payroll_deduction pd
       join payroll_line pl on pl.id = pd.payroll_line_id
       join deduction_type dt on dt.id = pd.deduction_type_id
      where pl.payroll_run_id = $1
      group by pd.deduction_type_id, dt.remit_within_days`,
    [run.id, scope.entityId, period.pay_date]
  );

  await c.query(`update pay_period set status='built' where id=$1`, [input.payPeriodId]);
  await audit(c, scope, {
    table: "payroll_run", rowId: run.id, action: "insert",
    after: { gross: gross.toString(), net: net.toString(), employees: drafts.length },
    reason: "register built from approved timecards",
  });

  return { runId: run.id, grossMinor: gross, netMinor: net, employees: drafts.length };
}

// ---------------------------------------------------- approve and release --

export async function requestRelease(
  c: Client,
  scope: Scope,
  runId: string,
  makerId: string
): Promise<{ required: boolean; requestId?: string }> {
  const run = await one<{ id: string; net_minor: string; status: string }>(
    c,
    `select id, net_minor, status from payroll_run where id=$1 and entity_id=$2`,
    [runId, scope.entityId]
  );
  if (run.status !== "building") throw new PayrollError(`run is ${run.status}`);

  const res = await openRequest(c, scope, {
    subjectType: "payroll_run",
    subjectId: runId,
    amountMinor: BigInt(run.net_minor),
    makerId,
  });
  await c.query(`update payroll_run set status='pending_release' where id=$1`, [runId]);
  return res.required ? { required: true, requestId: res.requestId } : { required: false };
}

/**
 * Release is a second person, always, and the funding account has to be able
 * to carry it. A late approval here is a late paycheck, which is why the
 * deadline sits earlier than accounts payable.
 */
export async function release(
  c: Client,
  scope: Scope,
  runId: string,
  releasedBy: string
): Promise<void> {
  const run = await one<{ id: string; status: string; built_by: string; net_minor: string }>(
    c,
    `select id, status, built_by, net_minor from payroll_run where id=$1 and entity_id=$2`,
    [runId, scope.entityId]
  );
  if (run.built_by === releasedBy)
    throw new PayrollError("whoever built the run cannot release it");

  const open = await q(
    c,
    `select 1 from approval_request r
      where r.subject_type='payroll_run' and r.subject_id=$1
        and r.entity_id=$2 and r.status='open' limit 1`,
    [runId, scope.entityId]
  );
  if (open.length > 0) throw new PayrollError("approval is still open");

  await c.query(
    `update payroll_run set status='released', released_by=$2, released_at=now() where id=$1`,
    [runId, releasedBy]
  );
  await audit(c, scope, {
    table: "payroll_run", rowId: runId, action: "transition",
    after: { status: "released", net: run.net_minor },
    reason: "released for funding",
  });
}

// --------------------------------------------------------------- posting --

/**
 * Debit wages by profit object, debit the employer's own taxes and match.
 * Credit net pay to the payroll bank account's cash, the taxes to payroll
 * liabilities, and the deductions to what is owed to their payees.
 */
export async function postRun(c: Client, scope: Scope, runId: string): Promise<string> {
  const run = await one<{
    id: string; status: string; bank_account_id: string; pay_date: string;
    gross_minor: string; employee_tax_minor: string; employer_tax_minor: string;
    deductions_minor: string; net_minor: string;
  }>(
    c,
    `select pr.id, pr.status, pr.bank_account_id, pp.pay_date::text as pay_date, pr.gross_minor,
            pr.employee_tax_minor, pr.employer_tax_minor, pr.deductions_minor, pr.net_minor
       from payroll_run pr
       join pay_period pp on pp.id = pr.pay_period_id
      where pr.id=$1 and pr.entity_id=$2`,
    [runId, scope.entityId]
  );
  if (run.status !== "released") throw new PayrollError(`run is ${run.status}; release it first`);

  const period = await one<{ id: string }>(
    c,
    `select id from fiscal_period where entity_id=$1 and $2::date between starts_on and ends_on`,
    [scope.entityId, run.pay_date]
  );

  const acct = async (code: string) =>
    (await one<{ id: string }>(
      c,
      `select id from gl_account where tenant_id=$1 and code=$2 /* unscoped: chart is tenant-wide */`,
      [scope.tenantId, code]
    )).id;

  const cash = (await one<{ gl_account_id: string }>(
    c,
    `select ba.gl_account_id from bank_account ba where ba.id=$1 and ba.entity_id=$2`,
    [run.bank_account_id, scope.entityId]
  )).gl_account_id;

  const wages = await acct("6100");
  const taxes = await acct("6110");
  const benefits = await acct("6120");
  const payrollLiab = await acct("2150");
  const dedPayable = await acct("2200");

  const je = await one<{ id: string }>(
    c,
    `insert into journal_entry
       (tenant_id, entity_id, period_id, posting_date, source_type, source_id, description,
        posted_by, actor_kind)
     values ($1,$2,$3,$4,'payroll',$5,$6,$7,$8) returning id`,
    [scope.tenantId, scope.entityId, period.id, run.pay_date, runId,
     `Payroll, pay date ${run.pay_date}`, scope.actor.id ?? null, scope.actor.kind]
  );

  let seq = 1;
  const byObject = await q<{ profit_object_id: string | null; department_id: string | null; gross: string }>(
    c,
    `select pl.profit_object_id, pl.department_id, sum(pl.gross_minor) as gross
       from payroll_line pl
       join payroll_run pr on pr.id = pl.payroll_run_id and pr.entity_id = $2
      where pl.payroll_run_id = $1
      group by pl.profit_object_id, pl.department_id`,
    [runId, scope.entityId]
  );
  for (const g of byObject) {
    await c.query(
      `insert into journal_line (journal_entry_id, seq, gl_account_id, profit_object_id, department_id, debit_minor, memo)
       values ($1,$2,$3,$4,$5,$6,'gross wages')`,
      [je.id, seq++, wages, g.profit_object_id, g.department_id, g.gross]
    );
  }

  const match = (await one<{ m: string }>(
    c,
    `select coalesce(sum(pd.employer_match_minor),0) as m
       from payroll_deduction pd
       join payroll_line pl on pl.id = pd.payroll_line_id
       join payroll_run pr on pr.id = pl.payroll_run_id and pr.entity_id = $2
      where pl.payroll_run_id=$1`,
    [runId, scope.entityId]
  )).m;

  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, memo)
     values ($1,$2,$3,$4,'employer taxes')`,
    [je.id, seq++, taxes, run.employer_tax_minor]
  );
  if (BigInt(match) > 0n) {
    await c.query(
      `insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, memo)
       values ($1,$2,$3,$4,'employer match')`,
      [je.id, seq++, benefits, match]
    );
  }
  // Names the account the money leaves, not just the cash code, so the
  // payroll bank reconciles on its own.
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, credit_minor, memo)
     values ($1,$2,$3,$4,$5,'net pay')`,
    [je.id, seq++, cash, run.bank_account_id, run.net_minor]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor, memo)
     values ($1,$2,$3,$4,'payroll taxes payable')`,
    [je.id, seq++, payrollLiab, (BigInt(run.employee_tax_minor) + BigInt(run.employer_tax_minor)).toString()]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor, memo)
     values ($1,$2,$3,$4,'deductions payable')`,
    [je.id, seq++, dedPayable, (BigInt(run.deductions_minor) + BigInt(match)).toString()]
  );

  await c.query(`update payroll_run set status='posted' where id=$1`, [runId]);
  await c.query(
    `update pay_period set status='posted' where id = (select pay_period_id from payroll_run where id=$1)`,
    [runId]
  );
  await audit(c, scope, {
    table: "journal_entry", rowId: je.id, action: "insert",
    after: { source: "payroll", runId, net: run.net_minor },
    reason: "posted on release",
  });
  return je.id;
}
