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
