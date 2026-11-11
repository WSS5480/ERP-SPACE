// Reading what vendors send: zip archives and .xlsx workbooks, with no
// dependency (node:zlib inflates). Both are bounded: at most 200 entries and
// 50 MB unpacked, so a zip bomb stops at the cap with a sentence.

import { inflateRawSync } from "node:zlib";

export class FileError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new FileError(msg); };

/**
 * A file-name pattern with * and ? only, case-insensitive, matched in linear
 * time. (A pattern turned into a RegExp backtracks: "*a*a*a*a*a*a*a*a*b"
 * against a 60-letter name holds the event loop for minutes.)
 */
export function globTest(name: string, pattern: string): boolean {
  const n = String(name).toLowerCase(), p = String(pattern).trim().toLowerCase();
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < n.length) {
    if (j < p.length && (p[j] === "?" || (p[j] !== "*" && p[j] === n[i]))) { i++; j++; }
    else if (j < p.length && p[j] === "*") { star = j++; mark = i; }
    else if (star >= 0) { j = star + 1; i = ++mark; }
    else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

export const MAX_ENTRIES = 200;
export const MAX_UNPACKED = 50 * 1024 * 1024;

export const isZip = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;

/** Every file in a zip archive, with its path inside the archive (folders left out). */
export function readZip(buf: Buffer, label = "the archive", maxEntries = MAX_ENTRIES): { path: string; bytes: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  need(eocd >= 0, `${label} is not a readable zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  need(count <= maxEntries, `${label} holds more than ${maxEntries} files; send fewer at a time`);
  const out: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    need(p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50, `${label} is damaged (its file list does not read)`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const path = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (path.endsWith("/")) continue;
    need(!(flags & 1), `${path} in ${label} is password-protected; ask the vendor for it without a password`);
    need(local + 30 <= buf.length && buf.readUInt32LE(local) === 0x04034b50, `${label} is damaged at ${path}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    need(start + csize <= buf.length, `${label} is damaged at ${path}`);
    const data = buf.subarray(start, start + csize);
    // Counted by what each entry really unpacks to, not what the archive says: entries may share
    // their bytes (200 stored entries pointing at one 2 MB block would otherwise become 400 MB).
    const room = MAX_UNPACKED - total;
    need(usize <= room, `${label} unpacks to more than ${MAX_UNPACKED / 1048576} MB; send it in parts`);
    let bytes: Buffer;
    if (method === 0) {
      need(csize === usize, `${label} is damaged at ${path} (its stored size does not match)`);
      bytes = Buffer.from(data);
    } else if (method === 8) {
      try { bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(room, usize)) }); }
      catch { throw new FileError(`${path} in ${label} could not be unpacked`); }
    } else throw new FileError(`${path} in ${label} uses a kind of compression this does not read (method ${method})`);
    total += bytes.length;
    need(total <= MAX_UNPACKED, `${label} unpacks to more than ${MAX_UNPACKED / 1048576} MB; send it in parts`);
    out.push({ path, bytes });
  }
  return out;
}

/** The files a vendor zipped up: names without folders, macOS litter and hidden files left out. */
export function unzip(buf: Buffer, label = "the archive"): { name: string; bytes: Buffer }[] {
  return readZip(buf, label)
    .filter((e) => !e.path.startsWith("__MACOSX/") && !/(^|\/)\.[^/]*$/.test(e.path))
    .map((e) => ({ name: e.path.split("/").pop()!, bytes: e.bytes }));
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
/**
 * Each <tag ...>body</tag> (or <tag .../>) in xml, found with indexOf, so the
 * work is linear in the size of the document whatever it holds (a regex with
 * a lazy body rescans to the end for every unclosed element).
 */
export function* elements(xml: string, tag: string): Generator<{ attrs: string; body: string }> {
  const open = `<${tag}`, close = `</${tag}>`;
  let i = 0;
  while (true) {
    const at = xml.indexOf(open, i);
    if (at < 0) return;
    const next = xml.charCodeAt(at + open.length);
    // <row must not match <rowBreaks: the name ends at a space, > or /
    if (!(next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13)) { i = at + open.length; continue; }
    const gt = xml.indexOf(">", at);
    if (gt < 0) return;
    const attrs = xml.slice(at + open.length, gt);
    if (attrs.endsWith("/")) { yield { attrs: attrs.slice(0, -1), body: "" }; i = gt + 1; continue; }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs, body: xml.slice(gt + 1, end) };
    i = end + close.length;
  }
}
const attr = (attrs: string, name: string) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs); return m ? m[1] : null; };
const textOf = (xml: string) => { let out = ""; for (const t of elements(xml, "t")) out += unxml(t.body); return out; };
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "").toUpperCase()) { n = n * 26 + (ch.charCodeAt(0) - 64); if (n > 100000) break; } return n - 1; };

export const MAX_ROWS = 50_000;
const MAX_COLS = 512;
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
/** A number format that shows a date: built-in date ids, or a custom code with d, m or y outside quotes and [colours]. */
const isDateCode = (code: string) => { const c = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "").toLowerCase(); return /[dy]|m(?!.*[s])/.test(c) && !/^(general|@|0+(\.0+)?%?)$/.test(c); };

/** An Excel serial day as YYYY-MM-DD (with HH:MM when it has a time of day). */
export function excelDate(serial: number, date1904 = false): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const day = d.toISOString().slice(0, 10);
  const frac = serial - Math.floor(serial);
  return frac > 1e-9 ? `${day} ${d.toISOString().slice(11, 16)}` : day;
}

export const isXlsx = (b: Buffer) => isZip(b) && b.includes(Buffer.from("xl/workbook.xml"));

/** A worksheet of an .xlsx as rows of text (numbers as written in the file): the one named like `prefer` (Catalog), else the first. */
export function xlsxRows(buf: Buffer, label = "the workbook", prefer = /^(catalog|products?|data)$/i): string[][] {
  const files = new Map<string, Buffer>();
  for (const e of readZip(buf, label, MAX_ENTRIES * 5)) files.set(e.path, e.bytes);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  need(wb, `${label} is not an Excel workbook`);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb!);
  let sheetPath = "xl/worksheets/sheet1.xml";
  const sheets = [...elements(wb!, "sheet")].map((m) => ({ name: unxml(attr(m.attrs, "name") ?? ""), rid: attr(m.attrs, "r:id") ?? "" }));
  const pick = sheets.find((x) => prefer.test(x.name.trim())) ?? sheets[0];
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (pick?.rid && rels) {
    const rel = [...elements(rels, "Relationship")].find((r) => attr(r.attrs, "Id") === pick.rid);
    const target = rel ? attr(rel.attrs, "Target") : null;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = files.get(sheetPath)?.toString("utf8");
  need(sheet, `${label} has no first worksheet`);
  const shared = [...elements(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "", "si")].map((m) => textOf(m.body));
  // Which cell styles show a date: style index -> number format -> a date format.
  const styles = files.get("xl/styles.xml")?.toString("utf8") ?? "";
  const custom = new Map([...elements(styles, "numFmt")].map((f) => [Number(attr(f.attrs, "numFmtId")), unxml(attr(f.attrs, "formatCode") ?? "")]));
  const xfs = [...elements(styles, "cellXfs")][0]?.body ?? "";
  const dateStyle = [...elements(xfs, "xf")].map((x) => { const id = Number(attr(x.attrs, "numFmtId") ?? 0); return DATE_IDS.has(id) || (custom.has(id) && isDateCode(custom.get(id)!)); });
  const rows: string[][] = [];
  for (const rm of elements(sheet!, "row")) {
    need(rows.length <= MAX_ROWS, `${label} has more than ${MAX_ROWS.toLocaleString("en-US")} rows; ask the vendor to split it`);
    const row: string[] = [];
    for (const cm of elements(rm.body, "c")) {
      const ref = attr(cm.attrs, "r");
      const t = attr(cm.attrs, "t") ?? "n";
      const st = Number(attr(cm.attrs, "s") ?? 0);
      const vEl = [...elements(cm.body, "v")][0];
      const v = vEl ? vEl.body : undefined;
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = textOf(cm.body);
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (t === "n" && v != null && dateStyle[st] && /^-?\d+(\.\d+)?$/.test(v)) val = excelDate(Number(v), date1904);
      else val = v != null ? unxml(v) : "";
      const i = ref ? colIndex(ref) : row.length;
      if (i < 0 || i >= MAX_COLS) continue;
      while (row.length < i) row.push("");
      row[i] = val;
    }
    rows.push(row);
  }
  return rows;
}
