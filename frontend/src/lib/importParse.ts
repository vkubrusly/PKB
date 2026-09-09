// =============================================================================
// importParse — dependency-free tabular reader for CSV, TSV and XLSX.
//
// XLSX is a ZIP of OOXML. We read it with the browser-native DecompressionStream
// (deflate-raw) + a minimal central-directory ZIP walk — no SheetJS, no CDN, no
// vulnerable npm package. CSV/TSV use a small quote-aware state machine.
//
// Everything works identically in the browser and in Node 18+ (Blob, Response,
// DecompressionStream are all global there), so the parser is unit-tested.
// =============================================================================

export interface Parsed {
  headers: string[];
  rows: string[][]; // aligned to headers by index (short rows padded)
}

export async function parseTabular(file: File): Promise<Parsed> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseBytes(bytes, name);
}

export async function parseBytes(bytes: Uint8Array, name: string): Promise<Parsed> {
  // Legacy .xls (BIFF8 in an OLE2 compound file) — what BuilderTrend exports.
  // Detected by name or the OLE2 magic (D0 CF 11 E0), before the .xlsx/ZIP path.
  if (name.endsWith('.xls') ||
      (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)) {
    return toParsed(readXls(bytes));
  }
  if (name.endsWith('.xlsx') || (bytes[0] === 0x50 && bytes[1] === 0x4b && name.endsWith('.xls') === false && !name.endsWith('.csv') && !name.endsWith('.tsv'))) {
    return toParsed(await readXlsx(bytes));
  }
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  const delimiter = name.endsWith('.tsv') || (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length) ? '\t' : ',';
  return toParsed(parseDelimited(text, delimiter));
}

// First non-empty row becomes the header; later rows are padded/truncated to it.
function toParsed(matrix: string[][]): Parsed {
  const firstIdx = matrix.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (firstIdx === -1) return { headers: [], rows: [] };
  const headers = matrix[firstIdx].map((h) => h.trim());
  const rows = matrix.slice(firstIdx + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => headers.map((_, i) => (r[i] ?? '').trim()));
  return { headers, rows };
}

// ---- CSV / TSV --------------------------------------------------------------
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- XLSX -------------------------------------------------------------------
async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const shared = files['xl/sharedStrings.xml'] ? parseSharedStrings(utf8(files['xl/sharedStrings.xml'])) : [];
  // Pick the first worksheet (sheet1.xml in a normal single-sheet export).
  const sheetKey = Object.keys(files)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort()[0];
  if (!sheetKey) throw new Error('Planilha vazia ou não reconhecida (.xlsx).');
  return parseSheet(utf8(files[sheetKey]), shared);
}

function utf8(b: Uint8Array): string { return new TextDecoder('utf-8').decode(b); }

// Minimal ZIP reader via the End-Of-Central-Directory record.
async function unzip(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Find EOCD (PK\x05\x06), scanning back from the end (comment is usually empty).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('.xlsx inválido (EOCD não encontrado).');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory offset

  const out: Record<string, Uint8Array> = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const fnLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = utf8(buf.subarray(ptr + 46, ptr + 46 + fnLen));

    // Jump to the local header to find where the data actually starts.
    const lfFnLen = dv.getUint16(localOff + 26, true);
    const lfExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lfFnLen + lfExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? comp : await inflateRaw(comp);

    ptr += 46 + fnLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([part]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// sharedStrings.xml: one entry per <si>; text is the concatenation of its <t> runs.
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner))) text += t[1];
    out.push(xmlDecode(text));
  }
  return out;
}

function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cellRe = /<c\s+([^>]*?)\/?>(?:([\s\S]*?)<\/c>)?/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1]))) {
      const attrs = c[1];
      const body = c[2] ?? '';
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const typeM = /t="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let val = '';
      if (type === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = vM ? (shared[Number(vM[1])] ?? '') : '';
      } else if (type === 'inlineStr') {
        const tM = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        val = tM ? xmlDecode(tM[1]) : '';
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = vM ? xmlDecode(vM[1]) : '';
      }
      cells[idx] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

// ---- Legacy XLS (BIFF8 inside an OLE2 compound file) ------------------------
// BuilderTrend's "Estimate Report" exports as a classic .xls (not .xlsx). We
// read the OLE2 container to fetch the "Workbook" stream, then walk BIFF
// records — SST shared strings + LABELSST / RK / MULRK / NUMBER / LABEL cells.
// Dependency-free, mirroring the .xlsx reader above.

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

function readXls(bytes: Uint8Array): string[][] {
  const wb = oleReadStream(bytes, ['Workbook', 'Book']);
  if (!wb) throw new Error('.xls inválido (stream "Workbook" não encontrado).');
  return biffToMatrix(wb);
}

// Read a named stream out of an OLE2/CFB compound document.
function oleReadStream(buf: Uint8Array, names: string[]): Uint8Array | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0xe011cfd0) return null; // D0 CF 11 E0 (LE)
  const ssz = 1 << dv.getUint16(30, true);          // sector size
  const msz = 1 << dv.getUint16(32, true);          // mini-sector size
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  const difatStart = dv.getUint32(68, true);
  const END = 0xfffffffe, FREE = 0xffffffff;
  const sectorOff = (s: number) => (s + 1) * ssz;   // header occupies sector 0

  // DIFAT: 109 entries in the header, then follow the DIFAT chain if present.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(76 + i * 4, true);
    if (v === FREE || v === END) break;
    fatSectors.push(v);
  }
  let ds = difatStart, guard = 0;
  while (ds !== END && ds !== FREE && guard++ < 100000) {
    const base = sectorOff(ds); const per = ssz / 4;
    for (let i = 0; i < per - 1; i++) { const v = dv.getUint32(base + i * 4, true); if (v !== FREE) fatSectors.push(v); }
    ds = dv.getUint32(base + (per - 1) * 4, true);
  }
  // Build the FAT (sector-allocation table).
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const base = sectorOff(fs);
    for (let i = 0; i < ssz / 4; i++) fat.push(dv.getUint32(base + i * 4, true));
  }
  const readChain = (start: number): Uint8Array => {
    const parts: Uint8Array[] = []; let s = start, g = 0;
    while (s !== END && s >= 0 && s < fat.length && g++ < fat.length + 16) {
      const off = sectorOff(s); parts.push(buf.subarray(off, off + ssz)); s = fat[s];
    }
    return concatBytes(parts);
  };

  // Directory entries (128 bytes each).
  const dir = readChain(dirStart);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let i = 0; i + 128 <= dir.length; i += 128) {
    const nlen = ddv.getUint16(i + 64, true);
    let nm = '';
    for (let j = 0; j + 2 <= Math.max(0, nlen - 2); j += 2) nm += String.fromCharCode(ddv.getUint16(i + j, true));
    entries.push({ name: nm, type: ddv.getUint8(i + 66), start: ddv.getUint32(i + 116, true), size: ddv.getUint32(i + 120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const target = entries.find((e) => names.includes(e.name));
  if (!target) return null;

  if (target.size >= miniCutoff || !root) {
    return readChain(target.start).subarray(0, target.size);
  }
  // Small stream → live in the mini stream, indexed by the mini-FAT.
  const miniFatBytes = readChain(miniFatStart);
  const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  const miniStream = readChain(root.start);
  const parts: Uint8Array[] = []; let s = target.start, g = 0;
  while (s !== END && s >= 0 && s < miniFat.length && g++ < miniFat.length + 16) {
    const off = s * msz; parts.push(miniStream.subarray(off, off + msz)); s = miniFat[s];
  }
  return concatBytes(parts).subarray(0, target.size);
}

function rkNum(rk: number): number {
  const cents = rk & 1, isInt = rk & 2;
  let v: number;
  if (isInt) { v = (rk | 0) >> 2; }
  else {
    const b = new ArrayBuffer(8); const bd = new DataView(b);
    bd.setUint32(4, rk & 0xfffffffc, true);            // top 32 bits of the double
    v = bd.getFloat64(0, true);
  }
  return cents ? v / 100 : v;
}

const numStr = (n: number) => (Number.isFinite(n) ? String(n) : '');

// A single-record (no CONTINUE) BIFF8 unicode string, used by LABEL cells.
function readUnicodeString(d: DataView, off: number): string {
  const cch = d.getUint16(off, true); const grbit = d.getUint8(off + 2);
  const high = grbit & 1; let o = off + 3;
  if (grbit & 8) o += 2;        // cRun
  if (grbit & 4) o += 4;        // cbExtRst
  let s = '';
  for (let i = 0; i < cch; i++) { s += String.fromCharCode(high ? d.getUint16(o, true) : d.getUint8(o)); o += high ? 2 : 1; }
  return s;
}

// Parse the Shared String Table (SST record + its CONTINUE chunks). Character
// data may straddle a CONTINUE boundary, where a fresh compression flag byte is
// emitted for the remaining characters — handled below.
function parseSST(chunks: Uint8Array[], out: string[]): void {
  const first = chunks[0];
  const nUnique = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(4, true);
  let ci = 0, pos = 8; // skip cstTotal(4) + cstUnique(4) in the first chunk
  const dvOf = () => new DataView(chunks[ci].buffer, chunks[ci].byteOffset, chunks[ci].byteLength);
  const ensure = () => { while (ci < chunks.length && pos >= chunks[ci].length) { ci++; pos = 0; } };

  for (let n = 0; n < nUnique; n++) {
    ensure(); if (ci >= chunks.length) break;
    const cch = dvOf().getUint16(pos, true); pos += 2;
    const grbit = chunks[ci][pos++];
    let high = grbit & 0x01;
    let rich = 0, ext = 0;
    if (grbit & 0x08) { rich = dvOf().getUint16(pos, true); pos += 2; }
    if (grbit & 0x04) { ext = dvOf().getUint32(pos, true); pos += 4; }
    let str = '', need = cch;
    while (need > 0) {
      ensure(); if (ci >= chunks.length) break;
      const d = dvOf(); const avail = chunks[ci].length - pos;
      if (high) {
        const take = Math.min(need, Math.floor(avail / 2));
        for (let k = 0; k < take; k++) { str += String.fromCharCode(d.getUint16(pos, true)); pos += 2; }
        need -= take;
      } else {
        const take = Math.min(need, avail);
        for (let k = 0; k < take; k++) { str += String.fromCharCode(d.getUint8(pos)); pos += 1; }
        need -= take;
      }
      if (need > 0) { ci++; pos = 0; if (ci >= chunks.length) break; high = chunks[ci][pos++] & 0x01; }
    }
    let skip = rich * 4 + ext;      // rich-text runs + phonetic ext (no fresh flag)
    while (skip > 0) {
      ensure(); if (ci >= chunks.length) break;
      const take = Math.min(skip, chunks[ci].length - pos); pos += take; skip -= take;
      if (skip > 0) { ci++; pos = 0; }
    }
    out.push(str);
  }
}

function biffToMatrix(wb: Uint8Array): string[][] {
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const recs: { type: number; off: number; len: number }[] = [];
  let p = 0;
  while (p + 4 <= wb.length) {
    const type = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    if (p + 4 + len > wb.length) break;
    recs.push({ type, off: p + 4, len }); p += 4 + len;
  }

  // Shared strings (SST 0x00FC + CONTINUE 0x003C chunks).
  const sst: string[] = [];
  const si = recs.findIndex((r) => r.type === 0x00fc);
  if (si >= 0) {
    const chunks = [wb.subarray(recs[si].off, recs[si].off + recs[si].len)];
    for (let i = si + 1; i < recs.length && recs[i].type === 0x003c; i++) chunks.push(wb.subarray(recs[i].off, recs[i].off + recs[i].len));
    parseSST(chunks, sst);
  }

  const cells: { r: number; c: number; v: string }[] = [];
  for (const rec of recs) {
    const d = new DataView(wb.buffer, wb.byteOffset + rec.off, rec.len);
    switch (rec.type) {
      case 0x00fd: cells.push({ r: d.getUint16(0, true), c: d.getUint16(2, true), v: sst[d.getUint32(6, true)] ?? '' }); break;             // LABELSST
      case 0x027e: cells.push({ r: d.getUint16(0, true), c: d.getUint16(2, true), v: numStr(rkNum(d.getUint32(6, true))) }); break;         // RK
      case 0x0203: cells.push({ r: d.getUint16(0, true), c: d.getUint16(2, true), v: numStr(d.getFloat64(6, true)) }); break;               // NUMBER
      case 0x0204: cells.push({ r: d.getUint16(0, true), c: d.getUint16(2, true), v: readUnicodeString(d, 6) }); break;                     // LABEL
      case 0x00bd: {                                                                                                                        // MULRK
        const r = d.getUint16(0, true), c0 = d.getUint16(2, true), last = d.getUint16(rec.len - 2, true);
        let o = 4; for (let c = c0; c <= last && o + 6 <= rec.len; c++) { cells.push({ r, c, v: numStr(rkNum(d.getUint32(o + 2, true))) }); o += 6; }
        break;
      }
      case 0x0006: {                                                                                                                        // FORMULA (cached numeric result only)
        if (d.getUint16(12, true) !== 0xffff) cells.push({ r: d.getUint16(0, true), c: d.getUint16(2, true), v: numStr(d.getFloat64(6, true)) });
        break;
      }
    }
  }

  let maxR = -1, maxC = -1;
  for (const c of cells) { if (c.r > maxR) maxR = c.r; if (c.c > maxC) maxC = c.c; }
  const m: string[][] = [];
  for (let r = 0; r <= maxR; r++) m.push(new Array(maxC + 1).fill(''));
  for (const c of cells) if (c.r >= 0 && c.c >= 0) m[c.r][c.c] = c.v;
  return m;
}
