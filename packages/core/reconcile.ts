// Automatic bank reconciliation against the POS feed.
//
// The POS knows what each store took and roughly when it should land. The
// bank says what actually arrived. Matching the two is most of a daily
// close, and the interesting output is what does NOT match.
//
// Matchers run most-certain first, and each one only ever claims a line
// nothing else has claimed:
//
//   1. transfers   a sweep we planned, landing
//   2. payments    money we sent, clearing
//   3. exact       one POS expectation, same amount, inside the window
//   4. tolerance   same within a band -- a card settlement net of fees
//   5. batch       several days' takings settled in one credit
//
// Whatever is left is a question for a person, and the run reports it.

import { type Client, type Scope, audit, one, q } from "./db.ts";

/** How far either side of the expected date a match may sit. */
export const DATE_WINDOW_DAYS = 3;

/** Card settlements arrive net of fees; anything inside this band matches. */
export const FEE_TOLERANCE_BPS = 500; // 5%

/** How many days' takings may be combined into one settlement. */
export const MAX_BATCH = 4;

export class ReconcileError extends Error {}

type Line = {
  id: string;
  posted_on: string;
  description: string;
  amount_minor: string;
};

type Expectation = {
  id: string;
  business_date: string;
  expected_on: string;
  method: string;
  amount_minor: string;
};

export type RunResult = {
  runId: string;
  linesTotal: number;
  linesMatched: number;
  matchedPct: number;
  varianceMinor: bigint;
  byMethod: Record<string, number>;
  unmatchedLines: { id: string; postedOn: string; description: string; amountMinor: bigint }[];
};

const daysBetween = (a: string, b: string) =>
  Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

export async function autoMatch(
  c: Client,
  scope: Scope,
  input: { bankAccountId: string; statementId: string; ranBy?: string }
): Promise<RunResult> {
  const acct = await one<{
    id: string; name: string; gl_account_id: string; fee_gl_account_id: string | null;
  }>(
    c,
    `select ba.id, ba.name, ba.gl_account_id, ba.fee_gl_account_id
       from bank_account ba where ba.id = $1 and ba.entity_id = $2`,
    [input.bankAccountId, scope.entityId]
  );

  const lines = await q<Line>(
    c,
    `select bsl.id, bsl.posted_on, bsl.description, bsl.amount_minor
       from bank_statement_line bsl
       join bank_statement bs on bs.id = bsl.bank_statement_id
       join bank_account ba on ba.id = bs.bank_account_id and ba.entity_id = $2
      where bsl.bank_statement_id = $1 and bsl.match_status = 'unmatched'
      order by bsl.posted_on, bsl.id`,
    [input.statementId, scope.entityId]
  );

  const run = await one<{ id: string }>(
    c,
    `insert into reconciliation_run
       (tenant_id, entity_id, bank_account_id, bank_statement_id, ran_by, actor_kind, lines_total)
     values ($1,$2,$3,$4,$5,$6,$7) returning id, entity_id`,
    [scope.tenantId, scope.entityId, input.bankAccountId, input.statementId,
     input.ranBy ?? null, scope.actor.kind, lines.length]
  );

  const byMethod: Record<string, number> = { exact: 0, tolerance: 0, batch: 0, transfer: 0, payment: 0 };
  let matched = 0;
  let variance = 0n;
  const claimed = new Set<string>();

  const record = async (
    lineId: string,
    kind: "pos_deposit" | "payment" | "bank_transfer",
    id: string,
    amount: bigint,
    method: "exact" | "tolerance" | "batch",
    varianceMinor: bigint,
    confidence: number,
    varianceJe: string | null
  ) => {
    await c.query(
      `insert into reconciliation_match
         (run_id, bank_statement_line_id, matched_kind, matched_id, amount_minor,
          variance_minor, method, confidence_bps, variance_journal_entry_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [run.id, lineId, kind, id, amount.toString(), varianceMinor.toString(),
       method, confidence, varianceJe]
    );
  };

  for (const line of lines) {
    const amount = BigInt(line.amount_minor);

    // 1 -- a sweep we planned, landing
    if (amount !== 0n) {
      const tr = await q<{ id: string }>(
        c,
        `select bt.id from bank_transfer bt
          where bt.entity_id = $1
            and (bt.to_bank_account_id = $2 or bt.from_bank_account_id = $2)
            and bt.amount_minor = $3
            and abs(bt.transfer_date - $4::date) <= $5
            and not exists (select 1 from reconciliation_match m
                             where m.matched_kind = 'bank_transfer' and m.matched_id = bt.id)
          limit 1`,
        [scope.entityId, input.bankAccountId, (amount < 0n ? -amount : amount).toString(),
         line.posted_on, DATE_WINDOW_DAYS]
      );
      if (tr[0]) {
        await record(line.id, "bank_transfer", tr[0].id, amount, "exact", 0n, 10000, null);
        byMethod.transfer++; matched++; claimed.add(line.id);
        continue;
      }
    }

    // 2 -- money we sent, clearing
    if (amount < 0n) {
      const pay = await q<{ id: string }>(
        c,
        `select p.id from payment p
          join payment_run pr on pr.id = p.payment_run_id
                             and pr.entity_id = $1 and pr.bank_account_id = $2
          where p.amount_minor = $3
            and abs(pr.pay_date - $4::date) <= $5
            and not exists (select 1 from reconciliation_match m
                             where m.matched_kind = 'payment' and m.matched_id = p.id)
          limit 1`,
        [scope.entityId, input.bankAccountId, (-amount).toString(), line.posted_on, DATE_WINDOW_DAYS]
      );
      if (pay[0]) {
        await record(line.id, "payment", pay[0].id, amount, "exact", 0n, 10000, null);
        byMethod.payment++; matched++; claimed.add(line.id);
        continue;
      }
      continue; // a debit that is not ours to explain from the POS feed
    }

    // POS expectations still open on this account, near this date
    const open = await q<Expectation>(
      c,
      `select pd.id, pd.business_date, pd.expected_on, pd.method, pd.amount_minor
         from pos_deposit pd
        where pd.entity_id = $1 and pd.bank_account_id = $2 and pd.status = 'open'
          and abs(pd.expected_on - $3::date) <= $4
        order by pd.expected_on, pd.id`,
      [scope.entityId, input.bankAccountId, line.posted_on, DATE_WINDOW_DAYS + MAX_BATCH]
    );

    // 3 -- exact
    const exact = open.find((o) => BigInt(o.amount_minor) === amount &&
      daysBetween(o.expected_on, line.posted_on) <= DATE_WINDOW_DAYS);
    if (exact) {
      await record(line.id, "pos_deposit", exact.id, amount, "exact", 0n, 10000, null);
      byMethod.exact++; matched++; claimed.add(line.id);
      continue;
    }

    // 4 -- tolerance: a card settlement arriving net of fees
    const near = open.find((o) => {
      if (o.method !== "card") return false;
      const exp = BigInt(o.amount_minor);
      if (amount > exp) return false;                 // fees reduce, never increase
      const band = (exp * BigInt(FEE_TOLERANCE_BPS)) / 10000n;
      return exp - amount <= band &&
        daysBetween(o.expected_on, line.posted_on) <= DATE_WINDOW_DAYS;
    });
    if (near) {
      const fee = BigInt(near.amount_minor) - amount;
      let je: string | null = null;
      if (fee > 0n && acct.fee_gl_account_id) {
        je = await postFee(c, scope, {
          onDate: line.posted_on, feeMinor: fee, feeAccount: acct.fee_gl_account_id,
          cashAccount: acct.gl_account_id, bankAccountId: acct.id, accountName: acct.name,
        });
      }
      await record(line.id, "pos_deposit", near.id, amount, "tolerance", -fee, 9000, je);
      byMethod.tolerance++; matched++; variance += fee; claimed.add(line.id);
      continue;
    }

    // 5 -- batch: several days settled in one credit
    const batch = findSubset(open, amount, MAX_BATCH);
    if (batch) {
      for (const b of batch)
        await record(line.id, "pos_deposit", b.id, BigInt(b.amount_minor), "batch", 0n, 8000, null);
      byMethod.batch++; matched++; claimed.add(line.id);
      continue;
    }
  }

  await c.query(
    `update reconciliation_run set lines_matched = $2, variance_minor = $3 where id = $1`,
    [run.id, matched, variance.toString()]
  );

  const leftovers = lines.filter((l) => !claimed.has(l.id));
  await audit(c, scope, {
    table: "reconciliation_run", rowId: run.id, action: "insert",
    after: { lines: lines.length, matched, open: leftovers.length, variance: variance.toString() },
    reason: "automatic reconciliation",
  });

  return {
    runId: run.id,
    linesTotal: lines.length,
    linesMatched: matched,
    matchedPct: lines.length === 0 ? 0 : Math.round((1000 * matched) / lines.length) / 10,
    varianceMinor: variance,
    byMethod,
    unmatchedLines: leftovers.map((l) => ({
      id: l.id, postedOn: l.posted_on, description: l.description, amountMinor: BigInt(l.amount_minor),
    })),
  };
}

/** Card fees are a real cost, so they post rather than being absorbed silently. */
async function postFee(
  c: Client,
  scope: Scope,
  t: { onDate: string; feeMinor: bigint; feeAccount: string; cashAccount: string;
       bankAccountId: string; accountName: string }
): Promise<string> {
  const period = await one<{ id: string }>(
    c,
    `select id from fiscal_period
      where entity_id = $1 and $2::date between starts_on and ends_on`,
    [scope.entityId, t.onDate]
  );
  const je = await one<{ id: string }>(
    c,
    `insert into journal_entry
       (tenant_id, entity_id, period_id, posting_date, source_type, description, posted_by, actor_kind)
     values ($1,$2,$3,$4,'manual',$5,$6,$7) returning id`,
    [scope.tenantId, scope.entityId, period.id, t.onDate,
     `Card processing fees, ${t.accountName}`, scope.actor.id ?? null, scope.actor.kind]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, memo)
     values ($1,1,$2,$3,'merchant fees')`,
    [je.id, t.feeAccount, t.feeMinor.toString()]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, credit_minor, memo)
     values ($1,2,$2,$3,$4,'settled net of fees')`,
    [je.id, t.cashAccount, t.bankAccountId, t.feeMinor.toString()]
  );
  return je.id;
}

/** Smallest combination of expectations that sums to the amount, up to `max`. */
function findSubset(open: Expectation[], target: bigint, max: number): Expectation[] | null {
  const pool = open.slice(0, 12); // the window is small; keep this cheap
  for (let size = 2; size <= max; size++) {
    const found = combine(pool, size, target);
    if (found) return found;
  }
  return null;
}

function combine(pool: Expectation[], size: number, target: bigint): Expectation[] | null {
  const idx: number[] = [];
  const walk = (start: number): Expectation[] | null => {
    if (idx.length === size) {
      const picked = idx.map((i) => pool[i]);
      const sum = picked.reduce((a, b) => a + BigInt(b.amount_minor), 0n);
      return sum === target ? picked : null;
    }
    for (let i = start; i < pool.length; i++) {
      idx.push(i);
      const hit = walk(i + 1);
      if (hit) return hit;
      idx.pop();
    }
    return null;
  };
  return walk(0);
}

/** A person decided. Recorded with who, which is the point. */
export async function matchManually(
  c: Client,
  scope: Scope,
  input: {
    statementLineId: string;
    kind: "pos_deposit" | "payment" | "bank_transfer" | "journal_line";
    id: string;
    amountMinor: bigint;
    matchedBy: string;
    note?: string;
  }
): Promise<void> {
  await c.query(
    `insert into reconciliation_match
       (bank_statement_line_id, matched_kind, matched_id, amount_minor, method,
        confidence_bps, matched_by)
     values ($1,$2,$3,$4,'manual',10000,$5)`,
    [input.statementLineId, input.kind, input.id, input.amountMinor.toString(), input.matchedBy]
  );
  await audit(c, scope, {
    table: "bank_statement_line", rowId: input.statementLineId, action: "transition",
    after: { matched: input.kind, id: input.id }, reason: input.note ?? "matched by hand",
  });
}

export async function openItems(
  c: Client,
  scope: Scope
): Promise<{
  lines: { account_name: string; posted_on: string; description: string; amount_minor: string; days_open: string }[];
  deposits: { location_name: string; business_date: string; method: string; amount_minor: string; days_late: string }[];
}> {
  const lines = await q<{ account_name: string; posted_on: string; description: string; amount_minor: string; days_open: string }>(
    c,
    `select account_name, posted_on, description, amount_minor, days_open
       from unmatched_bank_lines where entity_id = $1 order by posted_on`,
    [scope.entityId]
  );
  const deposits = await q<{ location_name: string; business_date: string; method: string; amount_minor: string; days_late: string }>(
    c,
    `select location_name, business_date, method, amount_minor, days_late
       from unmatched_pos_deposits where entity_id = $1 order by expected_on`,
    [scope.entityId]
  );
  return { lines, deposits };
}
