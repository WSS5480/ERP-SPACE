// X12 EDI, versions 004010 and 005010: pure functions, no database.
//
// The envelope: ISA / GS / ST ... SE / GE / IEA, with control numbers and
// counts checked both ways. Separators are configurable when writing and
// read from the ISA when parsing: the element separator is the character
// after "ISA", the sub-element separator is ISA16, and the segment
// terminator is the character after ISA16 (a newline after it is allowed).
// In 005010 ISA11 is the repetition separator; in 004010 it is "U".
//
// Transaction sets, each with a writer and a reader:
//   850 purchase order            (we send)
//   855 purchase order ack        (vendor sends)
//   856 ship notice (ASN)         (vendor sends)
//   810 invoice                   (vendor sends)
//   832 price/sales catalog       (vendor sends)
//   846 inventory advice          (vendor sends)
//   997 functional acknowledgment (both ways)
//
// A reader returns what the document says plus a list of plain-sentence
// problems; a document with problems is quarantined by the caller, never
// half-applied. Money comes back as bigint minor units.

export class X12Error extends Error {}

export type Separators = { element: string; segment: string; sub: string; repetition: string };
export const DEFAULT_SEPARATORS: Separators = { element: "*", segment: "~", sub: ">", repetition: "^" };

export type Segment = string[];                  // [id, e01, e02, ...]
export type Party = { qual: string; id: string };
export type Version = "004010" | "005010";

export const FUNCTIONAL_ID: Record<string, string> = { "850": "PO", "855": "PR", "856": "SH", "810": "IN", "832": "SC", "846": "IB", "997": "FA" };
export const DOC_TYPES = Object.keys(FUNCTIONAL_ID);
export const DOC_NAMES: Record<string, string> = {
  "850": "Purchase order", "855": "PO acknowledgment", "856": "Ship notice", "810": "Invoice", "832": "Price catalog", "846": "Inventory advice", "997": "Functional ack", freight: "Freight by store",
};

// ------------------------------------------------------------- helpers --

const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
const zpad = (n: number | string, w: number) => String(n).padStart(w, "0").slice(-w);

/** A value made safe to write: no separators, no control characters, trimmed, cut to max. */
export function clean(v: unknown, sep: Separators = DEFAULT_SEPARATORS, max = 80): string {
  let s = v == null ? "" : String(v);
  for (const ch of [sep.element, sep.segment, sep.sub, sep.repetition]) s = s.split(ch).join(" ");
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** "289.5" -> 28950n; "12" -> 1200n; half-up past the cent. Null when it is not a number. */
export function toMinor(v: string | undefined | null): bigint | null {
  const s = String(v ?? "").trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m || (!m[2] && !m[3])) return null;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = BigInt(m[2] || "0") * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  return m[1] ? -cents : cents;
}
/** 28950n -> "289.50" (an explicit decimal, X12 type R). */
export function fromMinor(m: bigint): string {
  const neg = m < 0n, a = neg ? -m : m;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}
const num = (v: string | undefined): number | null => {
  const s = String(v ?? "").trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
};
const qtyOut = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** CCYYMMDD or YYMMDD -> YYYY-MM-DD; null when it is not a real date. */
export function x12Date(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  let y: string, mo: string, d: string;
  if (/^\d{8}$/.test(s)) { y = s.slice(0, 4); mo = s.slice(4, 6); d = s.slice(6, 8); }
  else if (/^\d{6}$/.test(s)) { y = `20${s.slice(0, 2)}`; mo = s.slice(2, 4); d = s.slice(4, 6); }
  else return null;
  const iso = `${y}-${mo}-${d}`;
  const t = new Date(iso + "T00:00:00Z");
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}
const dateOut = (iso: string | null | undefined) => (iso ? iso.replace(/-/g, "").slice(0, 8) : "");

// ------------------------------------------------------------ envelopes --

export type Envelope = {
  sender: Party; receiver: Party;            // ISA05/06 and ISA07/08
  gsSender: string; gsReceiver: string;      // GS02 and GS03
  version: Version; usage: "T" | "P";
  isaControl: number; gsControl: number;     // GS control is per group; several groups count up from it
  at?: Date; ackRequested?: boolean;
};
export type TxSet = { type: string; control: number | string; segments: Segment[] };

const ISA_LENGTHS = [2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1];

function checkSeparators(sep: Separators) {
  const all = [sep.element, sep.segment, sep.sub, sep.repetition];
  if (all.some((x) => typeof x !== "string" || x.length !== 1 || /[A-Za-z0-9 ]/.test(x))) throw new X12Error("each separator is one character that is not a letter, digit or space");
  if (new Set(all).size !== 4) throw new X12Error("the element, segment, sub-element and repetition separators must all differ");
}

const segText = (s: Segment, sep: Separators) => {
  const els = [...s];
  while (els.length > 1 && els[els.length - 1] === "") els.pop();      // no trailing empty elements
  return els.join(sep.element) + sep.segment;
};

/** Write a whole interchange: one GS per functional group, sets in the order given. */
export function writeInterchange(env: Envelope, sets: TxSet[], sep: Separators = DEFAULT_SEPARATORS, opts: { newline?: boolean } = {}): string {
  checkSeparators(sep);
  if (!sets.length) throw new X12Error("an interchange carries at least one transaction set");
  const at = env.at ?? new Date();
  const ymd = `${at.getUTCFullYear()}${zpad(at.getUTCMonth() + 1, 2)}${zpad(at.getUTCDate(), 2)}`;
  const hm = `${zpad(at.getUTCHours(), 2)}${zpad(at.getUTCMinutes(), 2)}`;
  const nl = opts.newline ? "\n" : "";
  const isa: Segment = ["ISA", "00", pad("", 10), "00", pad("", 10), pad(clean(env.sender.qual, sep), 2), pad(clean(env.sender.id, sep, 15), 15),
    pad(clean(env.receiver.qual, sep), 2), pad(clean(env.receiver.id, sep, 15), 15), ymd.slice(2), hm,
    env.version === "005010" ? sep.repetition : "U", env.version === "005010" ? "00501" : "00401", zpad(env.isaControl, 9),
    env.ackRequested ? "1" : "0", env.usage, sep.sub];
  const out: string[] = [isa.join(sep.element) + sep.segment];
  const groups = new Map<string, TxSet[]>();
  for (const s of sets) {
    const f = FUNCTIONAL_ID[s.type];
    if (!f) throw new X12Error(`${s.type} is not a transaction set this system writes`);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push(s);
  }
  let gs = env.gsControl;
  for (const [fid, list] of groups) {
    out.push(segText(["GS", fid, clean(env.gsSender, sep, 15), clean(env.gsReceiver, sep, 15), ymd, hm, String(gs), "X", env.version], sep));
    for (const s of list) {
      const st = zpad(s.control, 4);
      const body = s.segments.map((x) => [x[0], ...x.slice(1).map((v) => clean(v, sep, 264))]);
      out.push(segText(["ST", s.type, st], sep));
      for (const b of body) out.push(segText(b, sep));
      out.push(segText(["SE", String(body.length + 2), st], sep));
    }
    out.push(segText(["GE", String(list.length), String(gs)], sep));
    gs++;
  }
  out.push(segText(["IEA", String(groups.size), zpad(env.isaControl, 9)], sep));
  return out.join(nl) + nl;
}

/** Read the separators from the ISA segment. */
export function detectSeparators(text: string): Separators {
  const at = text.indexOf("ISA");
  if (at < 0 || text.slice(0, at).trim() !== "" && !/^﻿?\s*$/.test(text.slice(0, at))) throw new X12Error("this is not an X12 file: it does not start with an ISA segment");
  const element = text[at + 3];
  if (!element || /[A-Za-z0-9\s]/.test(element)) throw new X12Error("the ISA segment has no element separator after ISA");
  // Walk sixteen elements; most senders pad to the fixed widths, some do not.
  let i = at + 4;
  for (let n = 0; n < 15; n++) {
    const j = text.indexOf(element, i);
    if (j < 0) throw new X12Error("the ISA segment is cut short; it needs sixteen elements");
    i = j + 1;
  }
  const sub = text[i], segment = text[i + 1];
  if (!sub || !segment) throw new X12Error("the ISA segment is cut short; it needs a sub-element separator and a segment terminator");
  if (segment === element || sub === element || sub === segment) throw new X12Error("the ISA's separators are not distinct");
  const fields = text.slice(at, i - 1).split(element);
  const isa11 = fields[11] ?? "U";
  const repetition = fields[12] === "00501" && isa11.length === 1 && !/[A-Za-z0-9 ]/.test(isa11) ? isa11 : "^";
  return { element, segment, sub, repetition: [element, segment, sub].includes(repetition) ? "\u0001" : repetition };
}

export type ParsedSet = { type: string; control: string; index: number; segments: Segment[]; errors: string[] };
export type ParsedGroup = { functionalId: string; sender: string; receiver: string; date: string | null; control: string; version: string; sets: ParsedSet[]; errors: string[] };
export type Interchange = {
  separators: Separators; sender: Party; receiver: Party; date: string | null; time: string; control: string;
  usage: string; version: string; ackRequested: boolean; groups: ParsedGroup[]; errors: string[];
};

/** Split, check counts and control numbers at every level. Unreadable files throw; envelope problems are listed. */
export function parseInterchange(text: string): Interchange {
  if (typeof text !== "string" || !text.trim()) throw new X12Error("the file is empty");
  if (text.length > 20 * 1024 * 1024) throw new X12Error("the file is over 20 MB");
  const sep = detectSeparators(text);
  const start = text.indexOf("ISA");
  const segs: Segment[] = text.slice(start).split(sep.segment).map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, "")).filter((s) => s.trim() !== "")
    .map((s) => s.split(sep.element));
  const isa = segs[0];
  if (isa[0] !== "ISA" || isa.length < 17) throw new X12Error("the ISA segment does not have sixteen elements");
  const errors: string[] = [];
  ISA_LENGTHS.forEach((len, k) => { if (k !== 15 && isa[k + 1].length !== len && ![1, 3, 5, 7].includes(k)) errors.push(`ISA${zpad(k + 1, 2)} should be ${len} characters long`); });
  const ix: Interchange = {
    separators: sep, sender: { qual: isa[5].trim(), id: isa[6].trim() }, receiver: { qual: isa[7].trim(), id: isa[8].trim() },
    date: x12Date(isa[9]), time: isa[10], control: isa[13].trim(), usage: isa[15].trim(), version: isa[12].trim(),
    ackRequested: isa[14].trim() === "1", groups: [], errors,
  };
  if (!/^\d{9}$/.test(isa[13])) errors.push("the interchange control number (ISA13) is not nine digits");
  if (!["T", "P"].includes(ix.usage)) errors.push("ISA15 must say T (test) or P (production)");
  let g: ParsedGroup | null = null, st: ParsedSet | null = null, iea: Segment | null = null, setIndex = 0;
  for (let k = 1; k < segs.length; k++) {
    const s = segs[k], id = s[0].trim();
    s[0] = id;
    if (iea) { errors.push(`there is a ${id} segment after the IEA`); break; }
    if (id === "GS") {
      if (g) errors.push(`group ${g.control} has no GE before the next GS`);
      if (st) errors.push(`transaction set ${st.control} has no SE`);
      st = null;
      g = { functionalId: s[1] ?? "", sender: (s[2] ?? "").trim(), receiver: (s[3] ?? "").trim(), date: x12Date(s[4]), control: (s[6] ?? "").trim(), version: (s[8] ?? "").trim(), sets: [], errors: [] };
      ix.groups.push(g);
    } else if (id === "GE") {
      if (!g) { errors.push("a GE has no GS before it"); continue; }
      if (st) { g.errors.push(`transaction set ${st.control} has no SE`); st = null; }
      if (Number(s[1]) !== g.sets.length) g.errors.push(`GE01 says ${s[1]} transaction sets, but the group holds ${g.sets.length}`);
      if ((s[2] ?? "").trim() !== g.control) g.errors.push(`GE02 (${s[2]}) does not match GS06 (${g.control})`);
      g = null;
    } else if (id === "IEA") {
      if (g) errors.push(`group ${g.control} has no GE`);
      if (Number(s[1]) !== ix.groups.length) errors.push(`IEA01 says ${s[1]} groups, but the interchange holds ${ix.groups.length}`);
      if ((s[2] ?? "").trim() !== ix.control) errors.push(`IEA02 (${s[2]}) does not match ISA13 (${ix.control})`);
      iea = s;
    } else if (id === "ST") {
      if (!g) { errors.push("an ST has no GS before it"); continue; }
      if (st) g.errors.push(`transaction set ${st.control} has no SE`);
      st = { type: (s[1] ?? "").trim(), control: (s[2] ?? "").trim(), index: setIndex++, segments: [], errors: [] };
      g.sets.push(st);
    } else if (id === "SE") {
      if (!st) { (g?.errors ?? errors).push("an SE has no ST before it"); continue; }
      const count = st.segments.length + 2;
      if (Number(s[1]) !== count) st.errors.push(`SE01 says ${s[1]} segments, but the set has ${count}`);
      if ((s[2] ?? "").trim() !== st.control) st.errors.push(`SE02 (${s[2]}) does not match ST02 (${st.control})`);
      st = null;
    } else if (st) {
      if (!/^[A-Z0-9]{2,3}$/.test(id)) st.errors.push(`${id.slice(0, 10) || "a blank"} is not a segment name`);
      st.segments.push(s);
    } else {
      errors.push(`a ${id.slice(0, 10)} segment sits outside any transaction set`);
    }
  }
  if (!iea) errors.push("the file has no IEA, so it may be cut short");
  if (!ix.groups.length) errors.push("the interchange holds no functional groups");
  return ix;
}

/** Convenience: every set in an interchange with its group. */
export const setsOf = (ix: Interchange) => ix.groups.flatMap((g) => g.sets.map((s) => ({ group: g, set: s })));

// ------------------------------------------------------------- readers --

const find = (segs: Segment[], id: string) => segs.find((s) => s[0] === id);
const all = (segs: Segment[], id: string) => segs.filter((s) => s[0] === id);
const el = (s: Segment | undefined, n: number) => (s?.[n] ?? "").trim();

/** Product ids carried as qualifier/value pairs (PO1, LIN, IT1): VN vendor's item, BP our item, UP/UK UPC/GTIN. */
function itemIds(s: Segment, from: number): { vendorSku?: string; ourSku?: string; upc?: string } {
  const out: { vendorSku?: string; ourSku?: string; upc?: string } = {};
  for (let i = from; i + 1 < s.length; i += 2) {
    const qual = s[i].trim(), val = s[i + 1].trim();
    if (!val) continue;
    if ((qual === "VN" || qual === "VP" || qual === "MG" || qual === "VA") && !out.vendorSku) out.vendorSku = val.toUpperCase();
    else if ((qual === "BP" || qual === "IN" || qual === "SK") && !out.ourSku) out.ourSku = val.toUpperCase();
    else if ((qual === "UP" || qual === "UK" || qual === "EN" || qual === "UA") && !out.upc) out.upc = val;
  }
  return out;
}
const ids = (x: { vendorSku?: string; ourSku?: string; upc?: string }): string[] =>
  [...(x.vendorSku ? ["VN", x.vendorSku] : []), ...(x.ourSku ? ["BP", x.ourSku] : []), ...(x.upc ? ["UP", x.upc] : [])];

// ---------------------------------------------------------------- 850 --

export type PoLine850 = { line: number; qty: number; uom?: string; unitMinor: bigint; vendorSku?: string; ourSku?: string; upc?: string; description?: string; options?: string[]; customerOrder?: string | null };
export type Po850 = {
  poNumber: string; date: string; purpose?: "00" | "05"; orderType?: "SA" | "OS" | "SP";
  vendorAccount?: string | null; requestedOn?: string | null; note?: string | null;
  shipTo: { code: string; name: string; address1?: string; city?: string; state?: string; postal?: string };
  lines: PoLine850[];
};

export function build850(p: Po850): Segment[] {
  if (!p.lines.length) throw new X12Error("an 850 needs at least one line");
  const segs: Segment[] = [["BEG", p.purpose ?? "00", p.orderType ?? "SA", p.poNumber, "", dateOut(p.date)]];
  if (p.vendorAccount) segs.push(["REF", "IA", p.vendorAccount]);
  if (p.requestedOn) segs.push(["DTM", "002", dateOut(p.requestedOn)]);
  if (p.note) segs.push(["MSG", p.note]);
  segs.push(["N1", "ST", p.shipTo.name, "92", p.shipTo.code]);
  if (p.shipTo.address1) segs.push(["N3", p.shipTo.address1]);
  if (p.shipTo.city || p.shipTo.state || p.shipTo.postal) segs.push(["N4", p.shipTo.city ?? "", p.shipTo.state ?? "", p.shipTo.postal ?? ""]);
  let hash = 0;
  for (const l of p.lines) {
    segs.push(["PO1", String(l.line), qtyOut(l.qty), l.uom ?? "EA", fromMinor(l.unitMinor), "PE", ...ids(l)]);
    if (l.description) segs.push(["PID", "F", "08", "", "", l.description]);
    for (const o of l.options ?? []) segs.push(["PID", "F", "73", "", "", o]);
    if (l.customerOrder) segs.push(["REF", "CO", l.customerOrder]);
    hash += l.qty;
  }
  segs.push(["CTT", String(p.lines.length), qtyOut(hash)]);
  return segs;
}

export function parse850(segs: Segment[]): Po850 & { errors: string[] } {
  const errors: string[] = [];
  const beg = find(segs, "BEG");
  if (!beg) errors.push("the 850 has no BEG segment");
  const n1 = segs.findIndex((s) => s[0] === "N1" && el(s, 1) === "ST");
  const lines: PoLine850[] = [];
  let cur: PoLine850 | null = null;
  for (const s of segs) {
    if (s[0] === "PO1") {
      const unit = toMinor(el(s, 4));
      cur = { line: Number(el(s, 1)), qty: num(el(s, 2)) ?? NaN, uom: el(s, 3), unitMinor: unit ?? 0n, ...itemIds(s, 6), options: [] };
      if (!Number.isFinite(cur.qty) || cur.qty <= 0) errors.push(`line ${el(s, 1)} has no quantity`);
      if (unit == null) errors.push(`line ${el(s, 1)} has no price`);
      lines.push(cur);
    } else if (s[0] === "PID" && cur) {
      if (el(s, 2) === "73") cur.options!.push(el(s, 5)); else cur.description = el(s, 5);
    } else if (s[0] === "REF" && el(s, 1) === "CO" && cur) cur.customerOrder = el(s, 2);
  }
  const ctt = find(segs, "CTT");
  if (ctt && Number(el(ctt, 1)) !== lines.length) errors.push(`CTT says ${el(ctt, 1)} lines, but the order has ${lines.length}`);
  if (!lines.length) errors.push("the 850 has no PO1 lines");
  const n4 = n1 >= 0 ? segs.slice(n1).find((s) => s[0] === "N4") : undefined;
  return {
    poNumber: el(beg, 3), date: x12Date(el(beg, 5)) ?? "", purpose: el(beg, 1) as "00", orderType: el(beg, 2) as "SA",
    vendorAccount: el(segs.find((s) => s[0] === "REF" && el(s, 1) === "IA"), 2) || null,
    requestedOn: x12Date(el(segs.find((s) => s[0] === "DTM" && el(s, 1) === "002"), 2)),
    note: el(find(segs, "MSG"), 1) || null,
    shipTo: { code: n1 >= 0 ? el(segs[n1], 4) : "", name: n1 >= 0 ? el(segs[n1], 2) : "", address1: el(n1 >= 0 ? segs.slice(n1).find((s) => s[0] === "N3") : undefined, 1) || undefined,
      city: el(n4, 1) || undefined, state: el(n4, 2) || undefined, postal: el(n4, 3) || undefined },
    lines, errors,
  };
}

// ---------------------------------------------------------------- 855 --

export type AckLine855 = { line?: number; vendorSku?: string; status: string; qty?: number | null; date?: string | null };
export type Ack855 = { poNumber: string; ackType: string; date: string | null; vendorRef?: string | null; shipDate?: string | null; lines: AckLine855[] };
export const ACK_LINE_CODES: Record<string, string> = {
  IA: "accept", AC: "accept", IB: "backorder", BP: "backorder", IC: "change", IQ: "change", IP: "change", IS: "change", DR: "change", IR: "reject", ID: "reject", R1: "reject", R2: "reject",
};

export function build855(a: Ack855): Segment[] {
  const segs: Segment[] = [["BAK", "00", a.ackType, a.poNumber, dateOut(a.date ?? undefined), "", "", "", a.vendorRef ?? ""]];
  if (a.shipDate) segs.push(["DTM", "068", dateOut(a.shipDate)]);
  for (const l of a.lines) {
    segs.push(["PO1", l.line != null ? String(l.line) : "", l.qty != null ? qtyOut(l.qty) : "", "EA", "", "", ...(l.vendorSku ? ["VN", l.vendorSku] : [])]);
    segs.push(["ACK", l.status, l.qty != null ? qtyOut(l.qty) : "", "EA", l.date ? "068" : "", dateOut(l.date ?? undefined)]);
  }
  segs.push(["CTT", String(a.lines.length)]);
  return segs;
}

export function parse855(segs: Segment[]): Ack855 & { errors: string[] } {
  const errors: string[] = [];
  const bak = find(segs, "BAK");
  if (!bak) errors.push("the 855 has no BAK segment, so it names no purchase order");
  else if (!el(bak, 3)) errors.push("the 855's BAK names no purchase order number");
  const ackType = el(bak, 2);
  if (bak && !["AC", "AD", "AE", "AK", "AP", "AT", "NA", "RD", "RF", "RJ", "RO", "ZZ"].includes(ackType)) errors.push(`${ackType || "a blank"} is not an 855 acknowledgment type`);
  const hdrShip = x12Date(el(segs.find((s) => s[0] === "DTM" && ["068", "067", "011", "002"].includes(el(s, 1))), 2));
  const lines: AckLine855[] = [];
  let po1: Segment | null = null;
  for (const s of segs) {
    if (s[0] === "PO1") po1 = s;
    else if (s[0] === "ACK") {
      const code = el(s, 1);
      if (!ACK_LINE_CODES[code]) errors.push(`${code || "a blank"} is not a line acknowledgment code this system reads`);
      const idsHere = po1 ? itemIds(po1, 6) : {};
      const lineNo = po1 && el(po1, 1) ? Number(el(po1, 1)) : undefined;
      const date = x12Date(el(s, 5)) ?? null;
      if (el(s, 5) && !date) errors.push(`line ${lineNo ?? "?"} has a date that is not a date`);
      lines.push({ line: lineNo, vendorSku: idsHere.vendorSku, status: ACK_LINE_CODES[code] ?? code, qty: num(el(s, 2)), date: date ?? hdrShip });
      if (lineNo == null && !idsHere.vendorSku) errors.push("an acknowledged line names neither our line number nor the vendor's item");
    }
  }
  if (!lines.length && ackType === "RJ") { /* the whole order rejected: the caller rejects every line */ }
  return { poNumber: el(bak, 3), ackType, date: x12Date(el(bak, 4)), vendorRef: el(bak, 8) || null, shipDate: hdrShip, lines, errors };
}

// ---------------------------------------------------------------- 856 --

export type AsnLine = { line?: number; vendorSku?: string; upc?: string; qty: number };
export type Asn856 = {
  shipmentId: string; date: string | null; shippedOn?: string | null; deliveryOn?: string | null;
  carrier?: string | null; carrierName?: string | null; tracking?: string | null; bol?: string | null;
  orders: { poNumber: string; lines: AsnLine[] }[];
};

export function build856(a: Asn856): Segment[] {
  const segs: Segment[] = [["BSN", "00", a.shipmentId, dateOut(a.date ?? a.shippedOn ?? undefined), "0000"]];
  let hl = 1;
  segs.push(["HL", String(hl), "", "S"]);
  if (a.carrier || a.carrierName) segs.push(["TD5", "", "2", a.carrier ?? "", "M", a.carrierName ?? ""]);
  if (a.bol) segs.push(["REF", "BM", a.bol]);
  if (a.tracking) segs.push(["REF", "CN", a.tracking]);
  if (a.shippedOn) segs.push(["DTM", "011", dateOut(a.shippedOn)]);
  if (a.deliveryOn) segs.push(["DTM", "017", dateOut(a.deliveryOn)]);
  const ship = hl;
  for (const o of a.orders) {
    const ord = ++hl;
    segs.push(["HL", String(ord), String(ship), "O"], ["PRF", o.poNumber]);
    for (const l of o.lines) {
      segs.push(["HL", String(++hl), String(ord), "I"], ["LIN", l.line != null ? String(l.line) : "", ...ids(l)], ["SN1", "", qtyOut(l.qty), "EA"]);
    }
  }
  segs.push(["CTT", String(hl)]);
  return segs;
}

export function parse856(segs: Segment[]): Asn856 & { errors: string[] } {
  const errors: string[] = [];
  const bsn = find(segs, "BSN");
  if (!bsn || !el(bsn, 2)) errors.push("the 856 has no BSN shipment number");
  const out: Asn856 = { shipmentId: el(bsn, 2), date: x12Date(el(bsn, 3)), orders: [] };
  let level = "", order: Asn856["orders"][number] | null = null, item: AsnLine | null = null;
  for (const s of segs) {
    const id = s[0];
    if (id === "HL") {
      level = el(s, 3);
      if (!["S", "O", "P", "T", "I"].includes(level)) errors.push(`HL ${el(s, 1)} has level ${level || "blank"}, which is not shipment, order, pack or item`);
      if (level === "O") { order = { poNumber: "", lines: [] }; out.orders.push(order); }
      if (level === "I") item = null;
      continue;
    }
    if (id === "TD5") { out.carrier = el(s, 3) || out.carrier || null; out.carrierName = el(s, 5) || out.carrierName || null; }
    else if (id === "REF" && (level === "S" || !level)) {
      const q = el(s, 1);
      if (q === "BM") out.bol = el(s, 2);
      if (q === "CN" || q === "2I" || q === "PK") out.tracking = out.tracking || el(s, 2);
    } else if (id === "DTM") {
      const d = x12Date(el(s, 2));
      if (el(s, 2) && !d) errors.push(`DTM ${el(s, 1)} carries ${el(s, 2)}, which is not a date`);
      if (el(s, 1) === "011") out.shippedOn = d;
      if (["017", "067", "002"].includes(el(s, 1))) out.deliveryOn = d;
    } else if (id === "PRF") {
      if (!order) { order = { poNumber: "", lines: [] }; out.orders.push(order); }
      order.poNumber = el(s, 1);
    } else if (id === "LIN") {
      if (!order) { errors.push("an item in the 856 sits under no order (no HL O with a PRF)"); continue; }
      const x = itemIds(s, 2);
      item = { line: el(s, 1) && /^\d+$/.test(el(s, 1)) ? Number(el(s, 1)) : undefined, vendorSku: x.vendorSku, upc: x.upc, qty: 0 };
      order.lines.push(item);
    } else if (id === "SN1") {
      if (!item) { errors.push("an SN1 quantity has no LIN item before it"); continue; }
      const q = num(el(s, 2));
      if (q == null || q <= 0) errors.push(`item ${item.line ?? item.vendorSku ?? "?"} ships no quantity`);
      item.qty = q ?? 0;
    }
  }
  if (!out.orders.length) errors.push("the 856 names no purchase order");
  for (const o of out.orders) {
    if (!o.poNumber) errors.push("an order level in the 856 has no PRF purchase order number");
    if (!o.lines.length) errors.push(`the 856 ships no items on ${o.poNumber || "an order"}`);
    for (const l of o.lines) if (l.line == null && !l.vendorSku) errors.push(`an item on ${o.poNumber} names neither our line nor the vendor's item`);
  }
  return { ...out, errors };
}

// ---------------------------------------------------------------- 810 --

export type InvLine = { line?: number; qty: number; unitMinor: bigint; vendorSku?: string; description?: string };
export type Invoice810 = {
  invoiceNumber: string; invoiceDate: string | null; poNumber: string; poDate?: string | null;
  lines: InvLine[]; charges: { code: string; description: string; amountMinor: bigint }[]; totalMinor: bigint; termsDays?: number | null;
};

export function build810(v: Invoice810): Segment[] {
  const segs: Segment[] = [["BIG", dateOut(v.invoiceDate ?? undefined), v.invoiceNumber, dateOut(v.poDate ?? undefined), v.poNumber]];
  if (v.termsDays != null) segs.push(["ITD", "01", "3", "", "", "", "", String(v.termsDays)]);
  for (const l of v.lines) {
    segs.push(["IT1", l.line != null ? String(l.line) : "", qtyOut(l.qty), "EA", fromMinor(l.unitMinor), "", ...(l.vendorSku ? ["VN", l.vendorSku] : [])]);
    if (l.description) segs.push(["PID", "F", "08", "", "", l.description]);
  }
  segs.push(["TDS", String(v.totalMinor)]);
  for (const ch of v.charges) segs.push(["SAC", "C", ch.code, "", "", String(ch.amountMinor), "", "", "", "", "", "", "", "", "", ch.description]);
  segs.push(["CTT", String(v.lines.length)]);
  return segs;
}

export function parse810(segs: Segment[]): Invoice810 & { errors: string[] } {
  const errors: string[] = [];
  const big = find(segs, "BIG");
  if (!big) errors.push("the 810 has no BIG segment");
  const invoiceNumber = el(big, 2), poNumber = el(big, 4);
  if (big && !invoiceNumber) errors.push("the 810 has no invoice number (BIG02)");
  if (big && !poNumber) errors.push("the 810 names no purchase order (BIG04)");
  const invoiceDate = x12Date(el(big, 1));
  if (big && !invoiceDate) errors.push("the 810's invoice date is missing or not a date");
  const lines: InvLine[] = [];
  let cur: InvLine | null = null;
  for (const s of segs) {
    if (s[0] === "IT1") {
      const q = num(el(s, 2)), u = toMinor(el(s, 4));
      if (q == null || q <= 0) errors.push(`invoice line ${el(s, 1) || "?"} has no quantity`);
      if (u == null) errors.push(`invoice line ${el(s, 1) || "?"} has no price`);
      const x = itemIds(s, 6);
      cur = { line: el(s, 1) && /^\d+$/.test(el(s, 1)) ? Number(el(s, 1)) : undefined, qty: q ?? 0, unitMinor: u ?? 0n, vendorSku: x.vendorSku };
      if (cur.line == null && !cur.vendorSku) errors.push("an invoice line names neither our PO line nor the vendor's item");
      lines.push(cur);
    } else if (s[0] === "PID" && cur) cur.description = el(s, 5);
  }
  const charges = all(segs, "SAC").filter((s) => el(s, 1) === "C").map((s) => {
    const amt = /^-?\d+$/.test(el(s, 5)) ? BigInt(el(s, 5)) : null;        // SAC05 is N2: cents
    if (amt == null) errors.push(`the ${el(s, 2) || "charge"} charge has no amount`);
    return { code: el(s, 2), description: el(s, 15) || (el(s, 2) === "D240" ? "Freight" : `Charge ${el(s, 2)}`), amountMinor: amt ?? 0n };
  });
  const tds = find(segs, "TDS");
  const total = tds && /^-?\d+$/.test(el(tds, 1)) ? BigInt(el(tds, 1)) : null;     // TDS01 is N2: cents
  if (total == null) errors.push("the 810 has no total (TDS)");
  const sum = lines.reduce((a, l) => a + BigInt(Math.round(l.qty * Number(l.unitMinor))), 0n) + charges.reduce((a, ch) => a + ch.amountMinor, 0n);
  if (total != null && total !== sum) errors.push(`the invoice total ${fromMinor(total)} is not the sum of its lines and charges, ${fromMinor(sum)}`);
  if (!lines.length) errors.push("the 810 has no IT1 lines");
  const itd = find(segs, "ITD");
  return { invoiceNumber, invoiceDate, poNumber, poDate: x12Date(el(big, 3)), lines, charges, totalMinor: total ?? 0n,
    termsDays: itd && /^\d+$/.test(el(itd, 7)) ? Number(el(itd, 7)) : null, errors };
}

// ---------------------------------------------------------------- 832 --

export type CatalogItem = {
  vendorSku: string; upc?: string; description?: string; costMinor?: bigint | null; msrpMinor?: bigint | null; mapMinor?: bigint | null;
  effectiveOn?: string | null; heightIn?: number | null; widthIn?: number | null; depthIn?: number | null; weightLb?: number | null; cubicFt?: number | null;
};
export type Catalog832 = { catalogId: string; date: string | null; items: CatalogItem[] };

export function build832(cat: Catalog832): Segment[] {
  const segs: Segment[] = [["BCT", "PC", cat.catalogId], ...(cat.date ? [["DTM", "009", dateOut(cat.date)]] : [])];
  for (const it of cat.items) {
    segs.push(["LIN", "", "VN", it.vendorSku, ...(it.upc ? ["UP", it.upc] : [])]);
    if (it.description) segs.push(["PID", "F", "08", "", "", it.description]);
    for (const [code, v, unit] of [["HT", it.heightIn, "IN"], ["WD", it.widthIn, "IN"], ["LN", it.depthIn, "IN"], ["WT", it.weightLb, "LB"], ["VOL", it.cubicFt, "CF"]] as const) {
      if (v != null) segs.push(["MEA", "PD", code, String(v), unit]);
    }
    if (it.costMinor != null) segs.push(["CTP", "", "UCP", fromMinor(it.costMinor)]);
    if (it.msrpMinor != null) segs.push(["CTP", "", "MSR", fromMinor(it.msrpMinor)]);
    if (it.mapMinor != null) segs.push(["CTP", "", "MAP", fromMinor(it.mapMinor)]);
    if (it.effectiveOn) segs.push(["DTM", "007", dateOut(it.effectiveOn)]);
  }
  segs.push(["CTT", String(cat.items.length)]);
  return segs;
}

export function parse832(segs: Segment[]): Catalog832 & { errors: string[] } {
  const errors: string[] = [];
  const bct = find(segs, "BCT");
  if (!bct) errors.push("the 832 has no BCT segment");
  const out: Catalog832 = { catalogId: el(bct, 2), date: null, items: [] };
  let cur: CatalogItem | null = null;
  for (const s of segs) {
    if (s[0] === "LIN") {
      const x = itemIds(s, 2);
      if (!x.vendorSku) { errors.push("a catalog item has no vendor item number (LIN VN)"); cur = null; continue; }
      cur = { vendorSku: x.vendorSku, upc: x.upc };
      out.items.push(cur);
    } else if (s[0] === "DTM" && !cur) out.date = x12Date(el(s, 2));
    else if (!cur) continue;
    else if (s[0] === "PID") cur.description = el(s, 5) || cur.description;
    else if (s[0] === "MEA") {
      const v = num(el(s, 3));
      if (v == null || v < 0) { errors.push(`${cur.vendorSku}: measurement ${el(s, 2)} is not a number`); continue; }
      const unit = el(s, 4).toUpperCase();
      const inches = unit === "FT" ? v * 12 : unit === "CM" ? v / 2.54 : v;
      const code = el(s, 2);
      if (code === "HT") cur.heightIn = inches; else if (code === "WD") cur.widthIn = inches; else if (code === "LN" || code === "DP") cur.depthIn = inches;
      else if (code === "WT" || code === "G") cur.weightLb = unit === "KG" ? Math.round(v * 2.20462 * 100) / 100 : v;
      else if (code === "VOL") cur.cubicFt = unit === "CI" ? Math.round((v / 1728) * 100) / 100 : v;
    } else if (s[0] === "CTP") {
      const m = toMinor(el(s, 3));
      if (m == null || m < 0n) { errors.push(`${cur.vendorSku}: price ${el(s, 3) || "(blank)"} is not a money amount`); continue; }
      const code = el(s, 2);
      if (code === "UCP" || code === "NET" || code === "CON" || code === "DPR") cur.costMinor = m;
      else if (code === "MSR" || code === "RES" || code === "SLP") cur.msrpMinor = m;
      else if (code === "MAP" || code === "MAX") cur.mapMinor = m;
    } else if (s[0] === "DTM" && el(s, 1) === "007") cur.effectiveOn = x12Date(el(s, 2));
  }
  if (!out.items.length) errors.push("the 832 has no items");
  for (const it of out.items) {
    if (it.heightIn != null && it.widthIn != null && it.depthIn != null && it.cubicFt == null) it.cubicFt = Math.round((it.heightIn * it.widthIn * it.depthIn / 1728) * 100) / 100;
  }
  return { ...out, errors };
}

// ---------------------------------------------------------------- 846 --

export type Inventory846 = { reference: string; date: string | null; items: { vendorSku: string; upc?: string; qty: number; availableOn?: string | null }[] };

export function build846(v: Inventory846): Segment[] {
  const segs: Segment[] = [["BIA", "00", "MM", v.reference, dateOut(v.date ?? undefined)]];
  for (const it of v.items) {
    segs.push(["LIN", "", "VN", it.vendorSku, ...(it.upc ? ["UP", it.upc] : [])], ["QTY", "33", qtyOut(it.qty), "EA"]);
    if (it.availableOn) segs.push(["DTM", "018", dateOut(it.availableOn)]);
  }
  segs.push(["CTT", String(v.items.length)]);
  return segs;
}

export function parse846(segs: Segment[]): Inventory846 & { errors: string[] } {
  const errors: string[] = [];
  const bia = find(segs, "BIA");
  if (!bia) errors.push("the 846 has no BIA segment");
  const out: Inventory846 = { reference: el(bia, 3), date: x12Date(el(bia, 4)), items: [] };
  let cur: Inventory846["items"][number] | null = null;
  for (const s of segs) {
    if (s[0] === "LIN") {
      const x = itemIds(s, 2);
      if (!x.vendorSku) { errors.push("an inventory item has no vendor item number (LIN VN)"); cur = null; continue; }
      cur = { vendorSku: x.vendorSku, upc: x.upc, qty: NaN };
      out.items.push(cur);
    } else if (s[0] === "QTY" && cur && ["33", "17", "QA", "02"].includes(el(s, 1))) {
      const q = num(el(s, 2));
      if (q == null) errors.push(`${cur.vendorSku}: quantity ${el(s, 2) || "(blank)"} is not a number`);
      cur.qty = q ?? NaN;
    } else if ((s[0] === "DTM" || s[0] === "SCH") && cur) {
      const d = x12Date(s[0] === "DTM" ? el(s, 2) : el(s, 6));
      if (d) cur.availableOn = d;
    }
  }
  if (!out.items.length) errors.push("the 846 has no items");
  for (const it of out.items) if (!Number.isFinite(it.qty)) errors.push(`${it.vendorSku} has no available quantity (QTY 33)`);
  return { ...out, errors };
}

// ---------------------------------------------------------------- 997 --

export type Ack997 = {
  functionalId: string; groupControl: string;
  sets: { type: string; control: string; accepted: boolean; notes?: string[] }[];
  status: "A" | "E" | "P" | "R"; included: number; received: number; accepted: number;
};

export function build997(a: Ack997): Segment[] {
  const segs: Segment[] = [["AK1", a.functionalId, a.groupControl]];
  for (const s of a.sets) {
    segs.push(["AK2", s.type, s.control]);
    for (const n of (s.notes ?? []).slice(0, 5)) segs.push(["AK3", "", "", "", "8"], ["AK4", "", "", "", n.slice(0, 99)]);
    segs.push(["AK5", s.accepted ? "A" : "R", ...(s.accepted ? [] : ["5"])]);
  }
  segs.push(["AK9", a.status, String(a.included), String(a.received), String(a.accepted)]);
  return segs;
}

export function parse997(segs: Segment[]): Ack997 & { errors: string[] } {
  const errors: string[] = [];
  const ak1 = find(segs, "AK1");
  if (!ak1) errors.push("the 997 has no AK1 segment, so it answers no group");
  const sets: Ack997["sets"] = [];
  let cur: Ack997["sets"][number] | null = null;
  for (const s of segs) {
    if (s[0] === "AK2") { cur = { type: el(s, 1), control: el(s, 2), accepted: false, notes: [] }; sets.push(cur); }
    else if (s[0] === "AK4" && cur && el(s, 4)) cur.notes!.push(el(s, 4));
    else if (s[0] === "AK5" && cur) cur.accepted = ["A", "E"].includes(el(s, 1));
  }
  const ak9 = find(segs, "AK9");
  if (!ak9) errors.push("the 997 has no AK9 segment");
  const st = el(ak9, 1) as Ack997["status"];
  if (ak9 && !["A", "E", "P", "R", "M", "W", "X"].includes(st)) errors.push(`${st || "a blank"} is not a 997 group status`);
  return { functionalId: el(ak1, 1), groupControl: el(ak1, 2), sets, status: st, included: Number(el(ak9, 2)) || 0, received: Number(el(ak9, 3)) || 0,
    accepted: Number(el(ak9, 4)) || 0, errors };
}

/** The 997 that answers one inbound group: each set accepted or rejected with its reasons. */
export function ackFor(group: ParsedGroup, verdicts: Map<string, string[]>): Ack997 {
  const sets = group.sets.map((s) => {
    const notes = verdicts.get(s.control) ?? [...s.errors];
    return { type: s.type, control: s.control, accepted: notes.length === 0, notes };
  });
  const ok = sets.filter((s) => s.accepted).length;
  return { functionalId: group.functionalId, groupControl: group.control, sets,
    status: group.errors.length ? "R" : ok === sets.length ? "A" : ok ? "P" : "R", included: sets.length, received: sets.length, accepted: ok };
}

/** Read one set by its type. */
export function readSet(set: ParsedSet) {
  switch (set.type) {
    case "850": return parse850(set.segments);
    case "855": return parse855(set.segments);
    case "856": return parse856(set.segments);
    case "810": return parse810(set.segments);
    case "832": return parse832(set.segments);
    case "846": return parse846(set.segments);
    case "997": return parse997(set.segments);
    default: return { errors: [`transaction set ${set.type || "(blank)"} is not one this system reads`] };
  }
}

/** A JSON-safe copy (bigints as strings) for logging a parsed document. */
export function summaryOf(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
