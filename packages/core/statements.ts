// Bank statements: four dialects in, one shape out.
//
// Whatever the channel, a statement file is bytes. This turns those bytes
// into dated, signed, referenced lines and puts them where reconciliation
// expects them. The format is sniffed rather than trusted, because the file a
// bank calls .csv is frequently not one.
//
// Three formats are implemented: BAI2, OFX/QFX, and delimited text with a
// per-connection column mapping. MT940 is declared but not written, and says
// so plainly -- a file in a format we cannot read is quarantined with that
// reason, which is the honest outcome. Silently reading it wrong is not.
//
// Two guards worth naming:
//
//   A file is checked against the account its connection claims. Dropping
//   Palestine's statement on Enola's feed is caught here, not three weeks
//   later in a variance nobody can explain.
//
//   Lines are de-duplicated by the database on a fingerprint, so a daily file
//   that repeats the last three days -- which is most of them -- adds only
//   what is genuinely new.

import { type Client, type Scope, q, one } from "./db.ts";
import { fromDecimal, type Minor } from "./money.ts";
import { type Connection, type Parsed, type Arrival, registerHandler } from "./connections.ts";

export type StatementLine = {
  postedOn: string;
  description: string;
  amountMinor: Minor;
  externalRef?: string;
  raw: Record<string, unknown>;
};

export type StatementDoc = {
  accountHint?: string;
  statementDate: string;
  openingMinor?: Minor;
  closingMinor?: Minor;
  sequenceNo?: number;
  lines: StatementLine[];
};

// ------------------------------------------------------------------ sniffing

export function detectFormat(bytes: Buffer, declared?: string): string {
  const head = bytes.subarray(0, 2048).toString("utf8");
  if (/^\s*01,/.test(head)) return "bai2";
  if (/OFXHEADER|<OFX>|<STMTTRN>/i.test(head)) return "ofx";
  if (/^\s*:20:|^\s*:60F:/m.test(head)) return "mt940";
  if (declared && declared !== "json") return declared;
  if (head.includes(",") || head.includes("\t") || head.includes(";")) return "csv";
  return declared ?? "unknown";
}

// ---------------------------------------------------------------------- BAI2

const yymmdd = (s: string): string => {
  const t = s.padStart(6, "0");
  const yy = Number(t.slice(0, 2));
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${t.slice(2, 4)}-${t.slice(4, 6)}`;
};

/** BAI2 amounts are unsigned; the type code carries the direction. */
const bai2Sign = (typeCode: string): bigint => {
  const n = Number(typeCode);
  if (!Number.isFinite(n)) return 1n;
  return n >= 400 && n <= 699 ? -1n : 1n;
};

export function parseBai2(text: string): StatementDoc[] {
  const docs: StatementDoc[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let asOf = "";
  let cur: StatementDoc | null = null;
  let last: StatementLine | null = null;

  for (const raw of lines) {
    const body = raw.replace(/\/$/, "");
    const f = body.split(",");
    const code = f[0];

    if (code === "02") {
      asOf = f[4] ? yymmdd(f[4]) : asOf;
    } else if (code === "03") {
      if (cur && cur.lines.length) docs.push(cur);
      cur = {
        accountHint: f[1] || undefined,
        statementDate: asOf,
        lines: [],
      };
      // summary pairs: typeCode, amount, itemCount, fundsType
      for (let i = 3; i + 1 < f.length; i += 4) {
        const t = f[i];
        const amt = f[i + 1];
        if (!amt) continue;
        if (t === "010") cur.openingMinor = BigInt(amt);
        if (t === "015" || t === "045") cur.closingMinor = BigInt(amt);
      }
      last = null;
    } else if (code === "16" && cur) {
      const typeCode = f[1] ?? "";
      const amount = f[2] ?? "0";
      const bankRef = f[4] ?? "";
      const custRef = f[5] ?? "";
      const text16 = f.slice(6).join(",").trim();
      last = {
        postedOn: cur.statementDate,
        description: text16 || `type ${typeCode}`,
        amountMinor: bai2Sign(typeCode) * BigInt(amount.replace(/[^0-9]/g, "") || "0"),
        externalRef: (bankRef || custRef || "").trim() || undefined,
        raw: { record: "16", typeCode, bankRef, custRef, text: text16 },
      };
      cur.lines.push(last);
    } else if (code === "88" && last) {
      const extra = f.slice(1).join(",").trim();
      if (extra) last.description = `${last.description} ${extra}`.trim();
    } else if (code === "49") {
      if (cur && cur.lines.length) docs.push(cur);
      cur = null;
      last = null;
    }
  }
  if (cur && cur.lines.length) docs.push(cur);
  if (!docs.length) throw new Error("no BAI2 account or detail records found in this file");
  return docs;
}

// ----------------------------------------------------------------- OFX / QFX

const ofxTag = (block: string, tag: string): string | undefined => {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  return m ? m[1].trim() : undefined;
};

export function parseOfx(text: string): StatementDoc[] {
  const acct = ofxTag(text, "ACCTID");
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (!blocks.length) throw new Error("no OFX transactions found in this file");

  const byDate = new Map<string, StatementLine[]>();
  for (const b of blocks) {
    const posted = ofxTag(b, "DTPOSTED");
    const amt = ofxTag(b, "TRNAMT");
    if (!posted || !amt) continue;
    const day = `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}`;
    const name = ofxTag(b, "NAME") ?? "";
    const memo = ofxTag(b, "MEMO") ?? "";
    const line: StatementLine = {
      postedOn: day,
      description: [name, memo].filter(Boolean).join(" ").trim() || "transaction",
      amountMinor: fromDecimal(amt),
      externalRef: ofxTag(b, "FITID"),
      raw: { trnType: ofxTag(b, "TRNTYPE"), name, memo, fitid: ofxTag(b, "FITID") },
    };
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day)!.push(line);
  }

  const ledger = ofxTag(text, "BALAMT");
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, lines], i, all) => ({
      accountHint: acct,
      statementDate: day,
      closingMinor: i === all.length - 1 && ledger ? fromDecimal(ledger) : undefined,
      lines,
    }));
}

// ----------------------------------------------------------- delimited text

/** Splits one CSV row, honouring quotes and doubled quotes inside them. */
export function splitRow(row: string, delim = ","): string[] {
  const out: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQ) {
      if (ch === '"') {
        if (row[i + 1] === '"') { cell += '"'; i++; } else { inQ = false; }
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out.map((s) => s.trim());
}

export type CsvMapping = {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  ref?: string;
  dateFormat?: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";
  delimiter?: string;
  skipRows?: number;
  negateAmount?: boolean;
};

export function parseDate(v: string, fmt: CsvMapping["dateFormat"] = "YYYY-MM-DD"): string {
  const s = v.trim();
  if (fmt === "YYYY-MM-DD") {
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) throw new Error(`"${v}" is not a date in YYYY-MM-DD`);
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (!m) throw new Error(`"${v}" is not a date in ${fmt}`);
  const [a, b] = fmt === "MM/DD/YYYY" ? [m[1], m[2]] : [m[2], m[1]];
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
}

export function parseCsv(text: string, mapping: CsvMapping): StatementDoc[] {
  if (!mapping?.date || !mapping?.description) {
    throw new Error("this connection has no CSV column mapping; set date and description at least");
  }
  const delim = mapping.delimiter ?? ",";
  const rows = text.split(/\r?\n/).filter((r) => r.trim().length);
  const start = mapping.skipRows ?? 0;
  const header = splitRow(rows[start], delim).map((h) => h.toLowerCase());
  const at = (name?: string): number => (name ? header.indexOf(name.toLowerCase()) : -1);

  const iDate = at(mapping.date);
  const iDesc = at(mapping.description);
  if (iDate < 0) throw new Error(`the file has no "${mapping.date}" column`);
  if (iDesc < 0) throw new Error(`the file has no "${mapping.description}" column`);
  const iAmt = at(mapping.amount);
  const iDr = at(mapping.debit);
  const iCr = at(mapping.credit);
  const iRef = at(mapping.ref);
  if (iAmt < 0 && (iDr < 0 || iCr < 0)) {
    throw new Error("the file needs either an amount column or both debit and credit columns");
  }

  const byDate = new Map<string, StatementLine[]>();
  for (let r = start + 1; r < rows.length; r++) {
    const cells = splitRow(rows[r], delim);
    if (cells.length < header.length - 1) continue;
    const day = parseDate(cells[iDate], mapping.dateFormat);

    let amount: Minor;
    if (iAmt >= 0) {
      const cleaned = cells[iAmt].replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
      if (!cleaned) continue;
      amount = fromDecimal(cleaned);
    } else {
      const dr = cells[iDr].replace(/[$,\s]/g, "");
      const cr = cells[iCr].replace(/[$,\s]/g, "");
      amount = dr ? -fromDecimal(dr) : cr ? fromDecimal(cr) : 0n;
      if (amount === 0n) continue;
    }
    if (mapping.negateAmount) amount = -amount;

    const line: StatementLine = {
      postedOn: day,
      description: cells[iDesc] || "transaction",
      amountMinor: amount,
      externalRef: iRef >= 0 ? cells[iRef] || undefined : undefined,
      raw: Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])),
    };
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day)!.push(line);
  }

  if (!byDate.size) throw new Error("no rows in this file parsed into transactions");
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, lines]) => ({ statementDate: day, lines }));
}

// ------------------------------------------------------------- the handler

export function parseStatement(bytes: Buffer, conn: Connection, arrival?: Arrival): Parsed {
  const format = detectFormat(bytes, arrival?.format ?? (conn.config.format as string));
  const text = bytes.toString("utf8");

  let docs: StatementDoc[];
  switch (format) {
    case "bai2": docs = parseBai2(text); break;
    case "ofx":
    case "qfx": docs = parseOfx(text); break;
    case "csv": docs = parseCsv(text, (conn.config.mapping as CsvMapping) ?? ({} as CsvMapping)); break;
    case "mt940":
      throw new Error("MT940 is not implemented yet; this file needs a parser before it can be read");
    default:
      throw new Error(`cannot tell what format this file is (looks like "${format}")`);
  }

  return { rows: docs, format, note: `${docs.length} statement day(s)` };
}

/** Last four digits of whatever the file called the account. */
const last4 = (s?: string): string | undefined => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : undefined;
};

export async function applyStatement(
  c: Client,
  _scope: Scope,
  parsed: Parsed,
  fileId: string,
  conn: Connection
): Promise<number> {
  const docs = parsed.rows as StatementDoc[];
  if (!conn.bank_account_id) {
    throw new Error("this connection does not name a bank account, so its statements have nowhere to go");
  }

  const acct = await one<{ id: string; account_last4: string }>(
    c,
    `select id, account_last4 from bank_account
      where id = $1 /* unscoped: connection already carries the entity */`,
    [conn.bank_account_id]
  );

  let applied = 0;

  for (const doc of docs) {
    // A statement for the wrong account on the right feed is caught here.
    const hint = last4(doc.accountHint);
    if (hint && acct.account_last4 && hint !== acct.account_last4) {
      throw new Error(
        `this file is for an account ending ${hint}, but ${conn.name} delivers for ${acct.account_last4}`
      );
    }
    if (!doc.statementDate) {
      throw new Error("the file carries no statement date");
    }

    const stmt = await one<{ id: string }>(
      c,
      `insert into bank_statement
         (bank_account_id, statement_date, opening_balance_minor, closing_balance_minor,
          source, inbound_file_id, sequence_no, channel)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (bank_account_id, statement_date, coalesce(sequence_no, 0))
         do update set inbound_file_id = coalesce(bank_statement.inbound_file_id, excluded.inbound_file_id)
       returning id /* unscoped: bank account carries the entity */`,
      [
        conn.bank_account_id,
        doc.statementDate,
        (doc.openingMinor ?? 0n).toString(),
        (doc.closingMinor ?? 0n).toString(),
        parsed.format,
        fileId,
        doc.sequenceNo ?? null,
        conn.channel,
      ]
    );

    for (const line of doc.lines) {
      const ins = await q<{ id: string }>(
        c,
        `insert into bank_statement_line
           (bank_statement_id, posted_on, description, amount_minor, external_ref,
            bank_account_id, raw)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict do nothing
         returning id /* unscoped: statement carries the account and entity */`,
        [
          stmt.id,
          line.postedOn,
          line.description.slice(0, 500),
          line.amountMinor.toString(),
          line.externalRef ?? null,
          conn.bank_account_id,
          JSON.stringify(line.raw),
        ]
      );
      if (ins.length) applied++;
    }
  }

  return applied;
}

registerHandler({
  source: "bank_statement",
  parse: parseStatement,
  apply: applyStatement,
});
