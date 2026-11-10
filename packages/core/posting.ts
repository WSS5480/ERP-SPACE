// One way for a retail module to post to the general ledger.
//
// Accounts are named by code from the tenant's chart ('4000', '2300'), never
// by id, so the same posting works for every company on its own chart. The
// entry must balance (the database checks it too), lands in the open period
// that holds its date, and names the thing that caused it.

import { q, one, type Client, type Scope } from "./db.ts";

export type PostLine = {
  code: string;                 // GL account code in the tenant's chart
  debit?: bigint;
  credit?: bigint;
  profitObjectId?: string | null;
  memo?: string;
  bankAccountId?: string | null;  // a cash line: which of the company's bank accounts it moves
};

export class PostingError extends Error {}

export type SourceType = "sale" | "receipt" | "refund" | "inventory" | "commission" | "ar" | "fleet" | "finance" | "manual" | "opening" | "intercompany";

/** The store's profit object, so revenue and cost land on the right P&L column. */
export async function profitObjectFor(c: Client, entityId: string, locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  const r = await q<{ id: string }>(c,
    `select id from profit_object where entity_id = $1 and location_id = $2 and status = 'active' limit 1`,
    [entityId, locationId]);
  return r[0]?.id ?? null;
}

export async function post(c: Client, scope: Scope, e: {
  date: string;                 // YYYY-MM-DD
  sourceType: SourceType;
  sourceId: string | null;
  description: string;
  lines: PostLine[];
}): Promise<string> {
  const lines = e.lines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n);
  if (!lines.length) throw new PostingError("nothing to post");
  let dr = 0n, cr = 0n;
  for (const l of lines) {
    const d = l.debit ?? 0n, k = l.credit ?? 0n;
    if (d < 0n || k < 0n) throw new PostingError("a posting line cannot be negative; swap the side");
    if (d && k) throw new PostingError("a posting line is a debit or a credit, not both");
    dr += d; cr += k;
  }
  if (dr !== cr) throw new PostingError(`entry does not balance: debits ${dr}, credits ${cr}`);

  const codes = [...new Set(lines.map((l) => l.code))];
  const accts = await q<{ id: string; code: string }>(c,
    `select id, code from gl_account where tenant_id = $1 and code = any($2) /* unscoped: chart is tenant-wide */`,
    [scope.tenantId, codes]);
  const byCode = new Map(accts.map((a) => [a.code, a.id]));
  const missing = codes.filter((x) => !byCode.has(x));
  if (missing.length) throw new PostingError(`the chart of accounts has no account ${missing.join(", ")}; add it in Setup`);

  const period = await q<{ id: string; status: string }>(c,
    `select id, status from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`,
    [scope.entityId, e.date]);
  if (!period.length) throw new PostingError(`there is no fiscal period for ${e.date}; open one in Books`);
  if (period[0].status === "closed") throw new PostingError(`the period holding ${e.date} is closed`);

  const je = await one<{ id: string }>(c,
    `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, source_id, description, posted_by, actor_kind)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [scope.tenantId, scope.entityId, period[0].id, e.date, e.sourceType, e.sourceId, e.description.slice(0, 300),
     scope.actor.id || null, scope.actor.kind]);
  let seq = 1;
  for (const l of lines) {
    await c.query(
      `insert into journal_line (journal_entry_id, seq, gl_account_id, profit_object_id, debit_minor, credit_minor, memo, bank_account_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [je.id, seq++, byCode.get(l.code), l.profitObjectId ?? null, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString(), l.memo ?? null,
       l.bankAccountId ?? null]);
  }
  return je.id;
}
