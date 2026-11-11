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
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export const isXlsx = (b: Buffer) => isZip(b) && b.includes(Buffer.from("xl/workbook.xml"));

/** A worksheet of an .xlsx as rows of text (numbers as written in the file): the one named like `prefer` (Catalog), else the first. */
export function xlsxRows(buf: Buffer, label = "the workbook", prefer = /^(catalog|products?|data)$/i): string[][] {
  const files = new Map<string, Buffer>();
  for (const e of readZip(buf, label, MAX_ENTRIES * 5)) files.set(e.path, e.bytes);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  need(wb, `${label} is not an Excel workbook`);
  let sheetPath = "xl/worksheets/sheet1.xml";
  const sheets = [...wb!.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ""), rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "" }));
  const pick = sheets.find((x) => prefer.test(x.name.trim())) ?? sheets[0];
  const first = pick?.rid ? [pick.rid, pick.rid] : null;
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (first && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(rels) ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${first[1]}"`).exec(rels);
    if (rel) sheetPath = rel[1].startsWith("/") ? rel[1].slice(1) : `xl/${rel[1].replace(/^\.\//, "")}`;
  }
  const sheet = files.get(sheetPath)?.toString("utf8");
  need(sheet, `${label} has no first worksheet`);
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows: string[][] = [];
  for (const rm of sheet!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = textOf(body);
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else val = v != null ? unxml(v) : "";
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push("");
      row[i] = val;
    }
    rows.push(row);
  }
  return rows;
}

