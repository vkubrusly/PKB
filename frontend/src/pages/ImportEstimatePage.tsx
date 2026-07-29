import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { SpecLevel, WbsNode } from '../lib/database.types';
import { ImportDialog, type ImportResult } from '../components/ImportDialog';
import { ESTIMATE_FIELDS, prepareEstimateLines } from '../lib/importMap';

// Import an existing budget table (Buildertrend estimate export, or any spreadsheet)
// as a project + estimate + line items. The saved estimate is immediately usable
// as a reference model for the parametric "Novo orçamento" engine.
export function ImportEstimatePage() {
  const { activeOrg } = useAuth();
  const nav = useNavigate();
  const [wbs, setWbs] = useState<WbsNode[]>([]);
  const [f, setF] = useState({
    name: '', level: 'affordable' as Exclude<SpecLevel, 'any'>,
    living: '', total: '', county: '', market: '',
  });
  const [defaultCat, setDefaultCat] = useState('20'); // fallback category for uncoded lines
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    supabase.from('wbs_nodes').select('*').order('sort_order')
      .then(({ data }) => setWbs(data ?? []));
  }, []);

  const validCodes = useMemo(() => new Set(wbs.map((n) => n.code)), [wbs]);
  const categories = wbs.filter((n) => n.depth === 1);
  const ready = f.name.trim() !== '' && Number(f.living) > 0 && Number(f.total) > 0;

  async function importEstimate(mapped: Record<string, string>[]): Promise<ImportResult> {
    const { data: proj, error: pe } = await supabase.from('projects').insert({
      org_id: activeOrg!.id, name: f.name.trim(),
      county: f.county || null, market: f.market || null,
      living_area_sf: Number(f.living) || null, total_area_sf: Number(f.total) || null,
      initial_level: f.level,
    }).select('id').single();
    if (pe) return { inserted: 0, error: pe.message };

    const { data: est, error: ee } = await supabase.from('estimates').insert({
      org_id: activeOrg!.id, project_id: proj!.id, level: f.level, status: 'draft',
      notes: 'Importado de planilha de orçamento existente.',
    }).select('id').single();
    if (ee) return { inserted: 0, error: ee.message };

    // Collapse hierarchical budgets to leaf items and use the Total column as the
    // line amount (see prepareEstimateLines) so category subtotals aren't double-counted.
    const prepared = prepareEstimateLines(mapped, validCodes, defaultCat);
    const rows = prepared.map((l) => ({
      org_id: activeOrg!.id, estimate_id: est!.id,
      wbs_code: l.wbs_code, line_code: l.line_code, description: l.description,
      qty: l.qty, unit: l.unit, unit_cost: l.unit_cost,
      price_source: 'catalog' as const, needs_review: false, sort_order: l.sort_order,
    }));
    if (!rows.length) return { inserted: 0, error: 'Nenhuma linha de item encontrada (só cabeçalhos?).' };

    const { error: ie } = await supabase.from('estimate_items').insert(rows);
    if (ie) return { inserted: 0, error: ie.message };

    nav(`/projetos/${proj!.id}`);
    return { inserted: rows.length };
  }

  return (
    <div>
      <header className="page-head"><h1>Importar orçamento existente</h1></header>
      <p className="muted">Suba uma tabela de orçamento que você já tem (export do Buildertrend ou qualquer
        planilha). Viram projeto + orçamento e passam a servir de <strong>modelo de referência</strong> para
        estimar novas casas por área.</p>

      <div className="card form-grid">
        <label>Nome do projeto / modelo<input value={f.name} required
          onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Nível
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Exclude<SpecLevel, 'any'> })}>
            <option value="affordable">Affordable</option><option value="essential">Essential</option><option value="signature">Signature</option><option value="luxury">Luxury</option>
          </select>
        </label>
        <label>Condado<input value={f.county} onChange={(e) => setF({ ...f, county: e.target.value })} /></label>
        <label>Mercado<input value={f.market} onChange={(e) => setF({ ...f, market: e.target.value })} /></label>
        <label>Living Area (sf)<input type="number" value={f.living}
          onChange={(e) => setF({ ...f, living: e.target.value })} /></label>
        <label>Total Area (sf)<input type="number" value={f.total}
          onChange={(e) => setF({ ...f, total: e.target.value })} /></label>
      </div>

      <div className="row-actions">
        <button className="btn primary" disabled={!ready} onClick={() => setImporting(true)}>
          Escolher planilha do orçamento →
        </button>
        {!ready && <span className="muted small">Preencha nome e áreas (living/total) primeiro.</span>}
      </div>

      {importing && (
        <ImportDialog
          title="Importar linhas do orçamento"
          fields={ESTIMATE_FIELDS}
          onClose={() => setImporting(false)}
          onImport={importEstimate}
          intro={<>Mapeie as colunas. Planilhas hierárquicas (categoria → subcategoria → item) são
            <strong> agrupadas automaticamente</strong>: só os <strong>itens finais</strong> viram linhas e a coluna
            <strong> Total</strong> é a fonte do valor (os subtotais de categoria não são contados duas vezes).
            Códigos como <code>3.1.1</code> caem na categoria WBS correta; <code>$1,234.56</code> e <code>1.234,56</code> são entendidos.</>}
          extra={
            <label className="inline" style={{ margin: '0.5rem 0' }}>Categoria para linhas sem código válido
              <select value={defaultCat} onChange={(e) => setDefaultCat(e.target.value)}>
                {categories.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
            </label>
          }
        />
      )}
    </div>
  );
}
