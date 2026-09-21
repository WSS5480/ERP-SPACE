// Bank accounts, and choosing the right one.
//
// A company can hold many accounts at many banks: one per store for local
// deposits, plus company-level operating, payroll and tax. Which account a
// movement touches is a fact worth recording on the journal line, because
// three stores banking at three banks into one cash code cannot otherwise be
// told apart at reconciliation time.

import { type Client, type Scope, audit, one, q } from "./db.ts";

export type Purpose =
  | "operating"   // exactly one per company: the only account money leaves from
  | "deposit"     // a branch account, deposit-only, sweeps into operating
  | "payroll"
  | "tax"
  | "sweep"
  | "escrow"
  | "merchant";

export class BankingError extends Error {}

export type BankAccountRow = {
  id: string;
  name: string;
  purpose: Purpose;
  bank_name: string;
  account_last4: string;
  location_id: string | null;
  location_name: string | null;
  gl_account_id: string;
  ach_origination_enabled: boolean;
};

export async function listAccounts(
  c: Client,
  scope: Scope,
  opts: { locationId?: string | null; purpose?: Purpose } = {}
): Promise<BankAccountRow[]> {
  return q<BankAccountRow>(
    c,
    `select ba.id, ba.name, ba.purpose, ba.bank_name, ba.account_last4,
            ba.location_id, l.name as location_name, ba.gl_account_id,
            ba.ach_origination_enabled
       from bank_account ba
       left join location l on l.id = ba.location_id
      where ba.entity_id = $1 and ba.status = 'active'
        and ($2::uuid is null or ba.location_id = $2)
        and ($3::text is null or ba.purpose = $3)
      order by ba.location_id nulls first, ba.purpose, ba.name`,
    [scope.entityId, opts.locationId ?? null, opts.purpose ?? null]
  );
}

/**
 * The store's own account if it has one for this purpose, otherwise the
 * company's. Falling back rather than failing is right: a new location
 * banks out of the operating account until its own is opened.
 */
export async function resolveAccount(
  c: Client,
  scope: Scope,
  input: { locationId?: string | null; purpose: Purpose }
): Promise<BankAccountRow> {
  if (input.locationId) {
    const local = await q<BankAccountRow>(
      c,
      `select ba.id, ba.name, ba.purpose, ba.bank_name, ba.account_last4,
              ba.location_id, null::text as location_name, ba.gl_account_id,
              ba.ach_origination_enabled
         from bank_account ba
        where ba.entity_id = $1 and ba.location_id = $2
          and ba.purpose = $3 and ba.is_default and ba.status = 'active'`,
      [scope.entityId, input.locationId, input.purpose]
    );
    if (local[0]) return local[0];
  }

  const company = await q<BankAccountRow>(
    c,
    `select ba.id, ba.name, ba.purpose, ba.bank_name, ba.account_last4,
            ba.location_id, null::text as location_name, ba.gl_account_id,
            ba.ach_origination_enabled
       from bank_account ba
      where ba.entity_id = $1 and ba.location_id is null
        and ba.purpose = $2 and ba.is_default and ba.status = 'active'`,
    [scope.entityId, input.purpose]
  );
  if (!company[0])
    throw new BankingError(`no default ${input.purpose} account for this company`);
  return company[0];
}

/**
 * The one operating account. The database allows at most one active per
 * company, so this is a lookup rather than a choice.
 */
export async function operatingAccount(c: Client, scope: Scope): Promise<BankAccountRow> {
  const rows = await q<BankAccountRow>(
    c,
    `select ba.id, ba.name, ba.purpose, ba.bank_name, ba.account_last4,
            ba.location_id, null::text as location_name, ba.gl_account_id,
            ba.ach_origination_enabled
       from bank_account ba
      where ba.entity_id = $1 and ba.purpose = 'operating' and ba.status = 'active'`,
    [scope.entityId]
  );
  if (!rows[0]) throw new BankingError("this company has no operating account");
  return rows[0];
}

/**
 * Everything is paid from the one operating account, wherever the cost
 * belongs. The store dimension records where it belongs; it does not decide
 * which bank sends the money.
 */
export async function resolveDisbursementAccount(
  c: Client,
  scope: Scope,
  input: { method: "ach" | "check" | "card" | "fuel_account" }
): Promise<BankAccountRow> {
  const acct = await operatingAccount(c, scope);
  if (input.method === "ach" && !acct.ach_origination_enabled)
    throw new BankingError("the operating account is not enabled for ACH origination");
  return acct;
}

export type SweepMethod = "bank_zba" | "ach_pull" | "manual";

export type PlannedSweep = {
  transferId: string;
  fromAccount: string;
  bank: string;
  method: SweepMethod;
  amountMinor: bigint;
  status: "expected" | "planned" | "sent";
  dueOn: string | null;
  journalEntryId: string | null;
};

/** Post the two sides of a movement. Both hit the same cash code, which is
 *  exactly why each line names its bank account. */
async function postTransfer(
  c: Client,
  scope: Scope,
  t: { fromId: string; toId: string; fromGl: string; toGl: string; fromName: string; amount: bigint; onDate: string }
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
     values ($1,$2,$3,$4,'transfer',$5,$6,$7) returning id`,
    [scope.tenantId, scope.entityId, period.id, t.onDate,
     `Sweep from ${t.fromName}`, scope.actor.id ?? null, scope.actor.kind]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, debit_minor, memo)
     values ($1,1,$2,$3,$4,'swept in')`,
    [je.id, t.toGl, t.toId, t.amount.toString()]
  );
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, credit_minor, memo)
     values ($1,2,$2,$3,$4,'swept out')`,
    [je.id, t.fromGl, t.fromId, t.amount.toString()]
  );
  return je.id;
}

/**
 * Plan the day's concentration. What happens next depends on what the bank
 * will do:
 *
 *   bank_zba  the bank moves it overnight. We record that we expect it and
 *             post nothing -- confirming it against the statement does that.
 *   ach_pull  we originate the debit now, so it is sent and posted here.
 *   manual    a person has to move it. It gets a due date and an owner, and
 *             sits on the overdue list until someone confirms.
 *
 * Nothing posts to the ledger for a movement that has not happened. A sweep
 * we assumed is a reconciliation break three weeks later.
 */
export async function planSweeps(
  c: Client,
  scope: Scope,
  input: { asOf: string; createdBy: string }
): Promise<PlannedSweep[]> {
  const rules = await q<{
    rule_id: string; from_id: string; to_id: string; target: string; method: SweepMethod;
    due_days: number; assigned_to: string | null; from_name: string; bank_name: string;
    from_gl: string; to_gl: string; balance: string;
  }>(
    c,
    `select sr.id as rule_id, sr.from_bank_account_id as from_id,
            sr.to_bank_account_id as to_id, sr.target_balance_minor as target,
            sr.method, sr.due_days, sr.assigned_to,
            f.name as from_name, f.bank_name, f.gl_account_id as from_gl,
            t.gl_account_id as to_gl,
            coalesce((select sum(jl.debit_minor - jl.credit_minor)
                        from journal_line jl where jl.bank_account_id = f.id), 0) as balance
       from sweep_rule sr
       join bank_account f on f.id = sr.from_bank_account_id
       join bank_account t on t.id = sr.to_bank_account_id
      where sr.entity_id = $1 and sr.active and sr.mode <> 'manual'`,
    [scope.entityId]
  );

  const out: PlannedSweep[] = [];
  for (const r of rules) {
    const amount = BigInt(r.balance) - BigInt(r.target);
    if (amount <= 0n) continue;

    let status: PlannedSweep["status"];
    let je: string | null = null;

    if (r.method === "ach_pull") {
      status = "sent";
      je = await postTransfer(c, scope, {
        fromId: r.from_id, toId: r.to_id, fromGl: r.from_gl, toGl: r.to_gl,
        fromName: r.from_name, amount, onDate: input.asOf,
      });
    } else {
      status = r.method === "bank_zba" ? "expected" : "planned";
    }

    const tr = await one<{ id: string; due_on: string | null }>(
      c,
      `insert into bank_transfer
         (tenant_id, entity_id, from_bank_account_id, to_bank_account_id, amount_minor,
          transfer_date, sweep_rule_id, journal_entry_id, status, method, due_on,
          assigned_to, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6::date + ($11)::int,$12,$13)
       returning id, due_on, entity_id`,
      [scope.tenantId, scope.entityId, r.from_id, r.to_id, amount.toString(),
       input.asOf, r.rule_id, je, status, r.method, r.due_days, r.assigned_to, input.createdBy]
    );

    await audit(c, scope, {
      table: "bank_transfer", rowId: tr.id, action: "insert",
      after: { method: r.method, status, amount: amount.toString() },
      reason: r.method === "manual" ? "this bank will not automate it" : "planned by rule",
    });

    out.push({
      transferId: tr.id, fromAccount: r.from_name, bank: r.bank_name,
      method: r.method, amountMinor: amount, status, dueOn: tr.due_on, journalEntryId: je,
    });
  }
  return out;
}

/**
 * The money actually arrived. Used for the two methods we do not originate:
 * a bank sweep seen on the statement, and a manual transfer somebody made.
 * Posting happens here, on evidence, rather than on expectation.
 */
export async function confirmTransfer(
  c: Client,
  scope: Scope,
  input: { transferId: string; confirmedBy: string; onDate?: string; statementLineId?: string }
): Promise<string> {
  const t = await one<{
    id: string; status: string; method: string; amount_minor: string; transfer_date: string;
    from_id: string; to_id: string; from_gl: string; to_gl: string; from_name: string;
  }>(
    c,
    `select bt.id, bt.status, bt.method, bt.amount_minor, bt.transfer_date,
            bt.from_bank_account_id as from_id, bt.to_bank_account_id as to_id,
            f.gl_account_id as from_gl, t2.gl_account_id as to_gl, f.name as from_name
       from bank_transfer bt
       join bank_account f  on f.id  = bt.from_bank_account_id
       join bank_account t2 on t2.id = bt.to_bank_account_id
      where bt.id = $1 and bt.entity_id = $2`,
    [input.transferId, scope.entityId]
  );
  if (!["expected", "planned"].includes(t.status))
    throw new BankingError(`transfer is already ${t.status}`);

  const onDate = input.onDate ?? t.transfer_date;
  const je = await postTransfer(c, scope, {
    fromId: t.from_id, toId: t.to_id, fromGl: t.from_gl, toGl: t.to_gl,
    fromName: t.from_name, amount: BigInt(t.amount_minor), onDate,
  });

  await c.query(
    `update bank_transfer
        set status = 'settled', journal_entry_id = $2, confirmed_by = $3,
            confirmed_at = now(), statement_line_id = $4
      where id = $1`,
    [input.transferId, je, input.confirmedBy, input.statementLineId ?? null]
  );
  await audit(c, scope, {
    table: "bank_transfer", rowId: input.transferId, action: "transition",
    after: { status: "settled", journalEntryId: je },
    reason: input.statementLineId ? "matched on the bank statement" : "confirmed by a person",
  });
  return je;
}

/** What is still sitting out there, and who owes it. */
export async function outstandingSweeps(
  c: Client,
  scope: Scope
): Promise<{ from_account: string; bank_name: string; method: string; automated: boolean;
            awaiting_minor: string; overdue: string; last_swept_on: string | null }[]> {
  return q(
    c,
    `select from_account, bank_name, method, automated, awaiting_minor, overdue, last_swept_on
       from sweep_status where entity_id = $1 order by automated desc, from_account`,
    [scope.entityId]
  );
}

export async function automationCoverage(
  c: Client,
  scope: Scope
): Promise<{ branches: string; by_the_bank: string; by_us: string; by_hand: string }> {
  return one(
    c,
    `select branches, by_the_bank, by_us, by_hand
       from sweep_automation where entity_id = $1`,
    [scope.entityId]
  );
}

export type Position = {
  bank_account_id: string;
  name: string;
  bank_name: string;
  account_last4: string;
  location_name: string | null;
  ledger_balance_minor: string;
  last_statement_minor: string | null;
};

/** Cash by account, which one line in the trial balance cannot show. */
export async function positions(c: Client, scope: Scope): Promise<Position[]> {
  return q<Position>(
    c,
    `select bank_account_id, name, bank_name, account_last4, location_name,
            ledger_balance_minor, last_statement_minor
       from bank_position
      where entity_id = $1
      order by location_name nulls first, name`,
    [scope.entityId]
  );
}

export async function footprint(
  c: Client,
  scope: Scope
): Promise<{ bank_name: string; accounts: string; locations: string; ach_enabled: string }[]> {
  return q(
    c,
    `select bank_name, accounts, locations, ach_enabled
       from banking_footprint where entity_id = $1 order by bank_name`,
    [scope.entityId]
  );
}

/**
 * Record a cash movement against a specific account. Every cash line goes
 * through here so reconciliation has something to match against.
 */
export async function cashLine(
  c: Client,
  je: string,
  seq: number,
  account: BankAccountRow,
  side: "debit" | "credit",
  amountMinor: bigint,
  memo: string,
  profitObjectId?: string | null
): Promise<void> {
  await c.query(
    `insert into journal_line
       (journal_entry_id, seq, gl_account_id, profit_object_id, bank_account_id,
        debit_minor, credit_minor, memo)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      je, seq, account.gl_account_id, profitObjectId ?? null, account.id,
      side === "debit" ? amountMinor.toString() : "0",
      side === "credit" ? amountMinor.toString() : "0",
      memo,
    ]
  );
}
