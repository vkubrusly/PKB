// Export a finished estimate as a printable PDF (via the browser print dialog)
// or as an Excel-openable CSV. Shared by the review step and the saved estimate.

import { UNIT_LABEL } from './format';

export interface ExpLine {
  line_code: string | null;
  wbs_code: string;
  description: string;
  qty: number;
  unit: string;
  unit_cost: number;
  line_total: number;
}
export interface ExpMeta {
  projectName: string;
  levelLabel?: string;
  county?: string | null;
  address?: string | null;
  totalSf?: number | null;
  livingSf?: number | null;
  grandTotal: number;
}

const catOf = (l: ExpLine) => (l.line_code ?? l.wbs_code).split('.')[0];
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Group { code: string; name: string; items: ExpLine[]; subtotal: number; }

function group(lines: ExpLine[], catName: Record<string, string>): Group[] {
  const codes = [...new Set(lines.map(catOf))].sort((a, b) => Number(a) - Number(b));
  return codes.map((code) => {
    const items = lines.filter((l) => catOf(l) === code);
    return { code, name: catName[code] ?? '', items, subtotal: items.reduce((s, l) => s + l.line_total, 0) };
  });
}

function safeName(s: string) {
  return (s || 'orcamento').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_|_$/g, '') || 'orcamento';
}

// ---------- Excel-openable CSV (pt-BR: sep=; , decimal comma, UTF-8 BOM) ----------
export function downloadCSV(lines: ExpLine[], meta: ExpMeta, catName: Record<string, string>) {
  const groups = group(lines, catName);
  const num = (n: number) => n.toFixed(2).replace('.', ','); // pt-BR decimal
  const cell = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (arr: (string | number)[]) => arr.map(cell).join(';');
  const out: string[] = ['sep=;'];
  out.push(row([`Orçamento — ${meta.projectName}`]));
  if (meta.levelLabel) out.push(row([`Nível: ${meta.levelLabel}`]));
  if (meta.county) out.push(row([`Condado: ${meta.county}`]));
  if (meta.address) out.push(row([`Endereço: ${meta.address}`]));
  if (meta.totalSf) out.push(row([`Área total (sf): ${meta.totalSf}`, `$/sf total: ${num(meta.grandTotal / meta.totalSf)}`]));
  if (meta.livingSf) out.push(row([`Área living (sf): ${meta.livingSf}`, `$/sf living: ${num(meta.grandTotal / meta.livingSf)}`]));
  out.push('');
  out.push(row(['COD', 'Item', 'Qtd', 'Unidade', 'Custo Unit. (USD)', 'Total (USD)']));
  for (const g of groups) {
    out.push(row([g.code, g.name.toUpperCase(), '', '', '', num(g.subtotal)]));
    for (const l of g.items) {
      out.push(row([l.line_code ?? l.wbs_code, l.description, num(l.qty), UNIT_LABEL[l.unit] ?? l.unit, num(l.unit_cost), num(l.line_total)]));
    }
  }
  out.push('');
  out.push(row(['', 'TOTAL', '', '', '', num(meta.grandTotal)]));
  const csv = '﻿' + out.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Orcamento_${safeName(meta.projectName)}${meta.levelLabel ? '_' + safeName(meta.levelLabel) : ''}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Print / PDF (opens a clean document and calls the print dialog) ----------
export function printEstimate(lines: ExpLine[], meta: ExpMeta, catName: Record<string, string>) {
  const groups = group(lines, catName);
  const rows = groups.map((g) => `
    <tr class="cat"><td>${g.code}</td><td colspan="4">${esc(g.name.toUpperCase())}</td><td class="num">${usd(g.subtotal)}</td></tr>
    ${g.items.map((l) => `
      <tr>
        <td class="mono">${esc(l.line_code ?? l.wbs_code)}</td>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty.toLocaleString('pt-BR')}</td>
        <td>${esc(UNIT_LABEL[l.unit] ?? l.unit)}</td>
        <td class="num">${usd(l.unit_cost)}</td>
        <td class="num">${usd(l.line_total)}</td>
      </tr>`).join('')}
  `).join('');
  const psfTotal = meta.totalSf ? usd(meta.grandTotal / meta.totalSf) : '—';
  const psfLiving = meta.livingSf ? usd(meta.grandTotal / meta.livingSf) : '—';
  const today = new Date().toLocaleDateString('pt-BR');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Orçamento — ${esc(meta.projectName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1c1a15; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #6b6355; margin: 0 0 16px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0 0 18px; font-size: 12px; }
  .meta b { color: #000; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 5px 8px; border-bottom: 1px solid #e6e2d8; text-align: left; }
  th { background: #f2f0ea; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #6b6355; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  tr.cat td { background: #faf8f2; font-weight: 700; border-top: 1.5px solid #d8d2c4; }
  tfoot td { font-weight: 800; font-size: 14px; border-top: 2px solid #1c1a15; background: #1c1a15; color: #fff; }
  .note { margin-top: 14px; color: #6b6355; font-size: 10.5px; }
  @media print { body { margin: 12mm; } @page { size: A4; margin: 12mm; } }
</style></head><body>
  <h1>PKB Homes — Orçamento</h1>
  <p class="sub">${esc(meta.projectName)}${meta.levelLabel ? ` · ${esc(meta.levelLabel)}` : ''} · ${today}</p>
  <div class="meta">
    ${meta.county ? `<span><b>Condado:</b> ${esc(meta.county)}</span>` : ''}
    ${meta.address ? `<span><b>Endereço:</b> ${esc(meta.address)}</span>` : ''}
    ${meta.totalSf ? `<span><b>Área total:</b> ${meta.totalSf.toLocaleString('pt-BR')} sf</span>` : ''}
    ${meta.livingSf ? `<span><b>Living:</b> ${meta.livingSf.toLocaleString('pt-BR')} sf</span>` : ''}
    <span><b>Total:</b> ${usd(meta.grandTotal)}</span>
    <span><b>$/sf total:</b> ${psfTotal}</span>
    <span><b>$/sf living:</b> ${psfLiving}</span>
  </div>
  <table>
    <thead><tr><th>COD</th><th>Item</th><th class="num">Qtd</th><th>Un</th><th class="num">Custo Un.</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="5">TOTAL${meta.levelLabel ? ` — ${esc(meta.levelLabel)}` : ''}</td><td class="num">${usd(meta.grandTotal)}</td></tr></tfoot>
  </table>
  <p class="note">Estimativa — valores sujeitos a revisão. Impact fees, taxas de concessionária e permits podem ser itens do owner (Change Order sem fee). Gerado em ${today}.</p>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Permita pop-ups para gerar o PDF (Imprimir).'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  // give the new document a tick to render before invoking print
  setTimeout(() => w.print(), 350);
}
