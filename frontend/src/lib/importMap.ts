// =============================================================================
// importMap — field definitions, header auto-mapping and value normalizers for
// the CSV/XLSX importers (suppliers, materials, existing budget tables).
//
// Auto-mapping matches export headers (e.g. Buildertrend's) to our fields by a
// normalized alias comparison; the user can always override in the dialog.
// =============================================================================

import type { Unit } from './database.types';

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Best header for each field: exact normalized alias, else substring either way.
export function autoMap(headers: string[], fields: ImportField[]): Record<string, string> {
  const nh = headers.map((h) => ({ h, n: norm(h) }));
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const f of fields) {
    const aliases = [f.key, ...f.aliases].map(norm);
    let hit = nh.find(({ h, n }) => !used.has(h) && aliases.includes(n));
    if (!hit) hit = nh.find(({ h, n }) => !used.has(h) && aliases.some((a) => a.length >= 3 && (n.includes(a) || a.includes(n))));
    if (hit) { out[f.key] = hit.h; used.add(hit.h); }
  }
  return out;
}

// ---- Field sets -------------------------------------------------------------
export const SUPPLIER_FIELDS: ImportField[] = [
  { key: 'name', label: 'Nome / Empresa', required: true, aliases: ['company', 'company name', 'business name', 'business', 'vendor', 'sub/vendor', 'subvendor', 'supplier', 'vendor name', 'name'] },
  { key: 'contact_name', label: 'Contato', aliases: ['contact', 'contact name', 'first name', 'primary contact', 'attention'] },
  { key: 'email', label: 'E-mail', aliases: ['email', 'e-mail', 'email address'] },
  { key: 'phone', label: 'Telefone', aliases: ['phone', 'phone number', 'cell phone', 'cell', 'work phone', 'mobile', 'telephone'] },
  { key: 'website', label: 'Website', aliases: ['website', 'web site', 'url', 'site', 'web'] },
  { key: 'notes', label: 'Notas / Trade', aliases: ['notes', 'trade', 'category', 'type', 'description'] },
];

export const MATERIAL_FIELDS: ImportField[] = [
  { key: 'name', label: 'Nome do material', required: true, aliases: ['title', 'item', 'item name', 'product', 'cost item', 'description', 'name'] },
  { key: 'wbs_code', label: 'Categoria WBS (código)', aliases: ['cost code', 'code', 'wbs', 'category'] },
  { key: 'brand', label: 'Marca', aliases: ['brand', 'manufacturer', 'make', 'mfg', 'mfr'] },
  { key: 'model', label: 'Modelo / SKU', aliases: ['model', 'model number', 'model #', 'sku', 'part number', 'part #', 'item number', 'item #'] },
  { key: 'unit', label: 'Unidade', aliases: ['unit', 'unit type', 'uom', 'unit of measure'] },
  { key: 'fl_approval', label: 'FL Approval (FL#)', aliases: ['fl#', 'fl approval', 'florida approval', 'fl', 'approval'] },
  { key: 'specs', label: 'Specs / descrição', aliases: ['description', 'specs', 'spec', 'notes', 'memo'] },
];

export const ESTIMATE_FIELDS: ImportField[] = [
  { key: 'wbs_code', label: 'Categoria WBS (código)', required: true, aliases: ['wbs', 'cost code', 'code', 'category', 'cod', 'group', 'grupo'] },
  { key: 'line_code', label: 'Código da linha', aliases: ['line code', 'line', 'item #', 'item number', 'ref', 'código', 'codigo'] },
  { key: 'description', label: 'Descrição', required: true, aliases: ['description', 'title', 'item', 'name', 'scope', 'descrição', 'descricao'] },
  { key: 'qty', label: 'Quantidade', aliases: ['quantity', 'qty', 'qtd', 'quantidade'] },
  { key: 'unit', label: 'Unidade', aliases: ['unit', 'uom', 'un', 'unit type', 'unidade'] },
  { key: 'unit_cost', label: 'Custo unitário', aliases: ['unit cost', 'unit price', 'cost', 'price', 'rate', 'custo unitário', 'custo unitario', 'custo', 'preço', 'preco'] },
];

// ---- Value normalizers ------------------------------------------------------
const UNIT_MAP: Record<string, Unit> = {
  each: 'ea', ea: 'ea', unit: 'ea', un: 'ea', unidade: 'ea', unids: 'ea', pc: 'ea', pcs: 'ea', item: 'ea',
  sf: 'sf', sqft: 'sf', squarefeet: 'sf', squarefoot: 'sf', ft2: 'sf', sqf: 'sf',
  lf: 'lf', linearfeet: 'lf', linearfoot: 'lf', linft: 'lf', lnft: 'lf',
  cy: 'cy', cubicyard: 'cy', cuyd: 'cy', cyd: 'cy',
  ls: 'ls', lumpsum: 'ls', lump: 'ls', global: 'ls', verba: 'ls', allowance: 'ls',
  hr: 'hr', hour: 'hr', hours: 'hr', hora: 'hr', horas: 'hr',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  sq: 'sq', square: 'sq', squares: 'sq',
  ton: 'ton', tons: 'ton', tonelada: 'ton',
  bid: 'bid', biditem: 'bid', bidout: 'bid',
  mo: 'mo', month: 'mo', months: 'mo', monthly: 'mo', mes: 'mo', meses: 'mo',
};

export function normalizeUnit(raw: string | undefined): Unit {
  if (!raw) return 'ea';
  const n = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  return UNIT_MAP[n] ?? 'ea';
}

// Parse "$1,234.56", "1.234,56", "(500)" (negative) → number. Returns 0 on junk.
export function parseNumber(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim();
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()]/g, '').replace(/[^0-9.,-]/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the right-most is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // Only comma: decimal if it looks like ",dd" at the end, else thousands.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  }
  const v = Math.abs(Number(s.replace(/-/g, '')) || 0);
  return neg ? -v : v;
}

// Reduce an imported code to a valid WBS node: exact match, then strip trailing
// ".n" segments ("3.1.1" → "3.1" → "3"); fall back to `fallback` if nothing fits.
export function coerceWbsCode(raw: string | undefined, valid: Set<string>, fallback: string): string {
  if (!raw) return fallback;
  const m = raw.trim().match(/\d+(?:\.\d+)*/);
  let code = m ? m[0] : '';
  while (code) {
    if (valid.has(code)) return code;
    const cut = code.lastIndexOf('.');
    if (cut === -1) break;
    code = code.slice(0, cut);
  }
  return valid.has(code) ? code : fallback;
}
