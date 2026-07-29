import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Material, SpecLevel, Supplier, Unit, WbsNode } from '../lib/database.types';
import { SPEC_LEVEL_LABEL, UNIT_LABEL } from '../lib/format';
import { ImportDialog, type ImportResult } from '../components/ImportDialog';
import { MATERIAL_FIELDS, normalizeUnit, coerceWbsCode } from '../lib/importMap';

const UNITS: Unit[] = ['ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo'];
const LEVELS: SpecLevel[] = ['affordable', 'essential', 'signature', 'luxury', 'any'];

const empty = {
  name: '', wbs_code: '', spec_level: 'any' as SpecLevel, brand: '', model: '',
  unit: 'ea' as Unit, fl_approval: '', specs: '', preferred_supplier_id: '',
};
type Draft = typeof empty;

// One parsed row from an AI-read quote PDF, editable before insert.
interface QRow {
  name: string; brand: string; model: string; unit: Unit; wbs_code: string;
  spec_level: SpecLevel; fl_approval: string; specs: string; unit_price: number | null;
}

export function MaterialsPage() {
  const { activeOrg } = useAuth();
  const [rows, setRows] = useState<Material[]>([]);
  const [wbs, setWbs] = useState<WbsNode[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [filterLevel, setFilterLevel] = useState<SpecLevel | ''>('');
  const [aiBusy, setAiBusy] = useState<string | null>(null); // material_id being processed
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // AI quote (PDF) import
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteRows, setQuoteRows] = useState<QRow[] | null>(null);
  const [quoteMeta, setQuoteMeta] = useState<{ supplier: string | null; notes: string; confidence: string } | null>(null);

  // Bulk-insert materials from a mapped CSV/XLSX (Buildertrend Cost Catalog).
  async function importMaterials(mapped: Record<string, string>[]): Promise<ImportResult> {
    const validCodes = new Set(wbs.filter((n) => n.is_leaf).map((n) => n.code));
    const payload = mapped.map((r) => {
      const code = r.wbs_code?.trim() ? coerceWbsCode(r.wbs_code, validCodes, '') : '';
      return {
        org_id: activeOrg!.id,
        name: r.name.trim(),
        wbs_code: code || null,
        spec_level: 'any' as SpecLevel,
        brand: r.brand?.trim() || null,
        model: r.model?.trim() || null,
        unit: normalizeUnit(r.unit),
        fl_approval: r.fl_approval?.trim() || null,
        specs: r.specs?.trim() || null,
      };
    }).filter((r) => r.name);
    if (!payload.length) return { inserted: 0, error: 'Nenhuma linha com "Nome" preenchido.' };
    const { error } = await supabase.from('materials').insert(payload);
    if (error) return { inserted: 0, error: error.message };
    load();
    return { inserted: payload.length };
  }

  // supabase-js gives a generic "non-2xx"; the real cause is on error.context.
  async function funcError(error: unknown): Promise<string> {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { const b = await ctx.json(); if (b?.error) return String(b.error); } catch { /* not JSON */ }
    }
    return error instanceof Error ? error.message : String(error);
  }

  const LEVELSET = new Set<SpecLevel>(LEVELS);

  // Read a supplier quote PDF with the AI: extract materials + inferred level/type.
  async function extractQuote() {
    if (!quoteFile) return;
    setQuoteBusy(true); setErr(null); setAiMsg(null);
    try {
      const safe = quoteFile.name.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const path = `${activeOrg!.id}/cotacoes/${Date.now()}-${safe || 'cotacao.pdf'}`;
      const up = await supabase.storage.from('plantas').upload(path, quoteFile);
      if (up.error) throw new Error(`Falha ao subir o PDF: ${up.error.message}`);
      const { data, error } = await supabase.functions.invoke('materials-extract', { body: { plan_path: path } });
      if (error) throw new Error(await funcError(error));
      if (data?.error) throw new Error(data.error);
      const r = data.result as { supplier: string | null; notes: string; confidence: string; materials: Record<string, unknown>[] };
      const validCodes = new Set(wbs.map((n) => n.code));
      const rows: QRow[] = (r.materials ?? []).map((m) => ({
        name: String(m.name ?? '').trim(),
        brand: m.brand ? String(m.brand) : '',
        model: m.model ? String(m.model) : '',
        unit: normalizeUnit(m.unit ? String(m.unit) : undefined),
        wbs_code: coerceWbsCode(m.wbs_code ? String(m.wbs_code) : '', validCodes, ''),
        spec_level: LEVELSET.has(m.spec_level as SpecLevel) ? (m.spec_level as SpecLevel) : 'any',
        fl_approval: m.fl_approval ? String(m.fl_approval) : '',
        specs: m.specs ? String(m.specs) : '',
        unit_price: typeof m.unit_price === 'number' ? m.unit_price : null,
      })).filter((x) => x.name);
      setQuoteRows(rows);
      setQuoteMeta({ supplier: r.supplier, notes: r.notes ?? '', confidence: r.confidence ?? '' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setQuoteBusy(false);
  }

  async function confirmQuoteImport() {
    if (!quoteRows) return;
    setErr(null);
    const payload = quoteRows.filter((r) => r.name.trim()).map((r) => ({
      org_id: activeOrg!.id, name: r.name.trim(),
      wbs_code: r.wbs_code || null, spec_level: r.spec_level,
      brand: r.brand || null, model: r.model || null, unit: r.unit,
      fl_approval: r.fl_approval || null, specs: r.specs || null,
    }));
    if (!payload.length) { setErr('Nenhum material para importar.'); return; }
    const { error } = await supabase.from('materials').insert(payload);
    if (error) { setErr(error.message); return; }
    setAiMsg(`${payload.length} material(is) importado(s) da cotação.`);
    setQuoteRows(null); setQuoteMeta(null); setQuoteFile(null);
    load();
  }

  function patchRow(i: number, patch: Partial<QRow>) {
    setQuoteRows((rows) => rows && rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  // Call an AI Edge Function (Agente de Preços / Detalhamento) for one material.
  async function runAgent(kind: 'price-search' | 'product-detail', id: string) {
    setAiBusy(id); setAiMsg(null); setErr(null);
    const { data, error } = await supabase.functions.invoke(kind, { body: { material_id: id } });
    if (error) {
      setErr(
        `IA indisponível (${error.message}). Configure a Edge Function "${kind}" + ANTHROPIC_API_KEY ` +
        `(supabase functions deploy ${kind}; supabase secrets set ANTHROPIC_API_KEY=...).`,
      );
    } else if (data?.error) {
      setErr(data.error);
    } else if (kind === 'price-search') {
      const r = data.result;
      setAiMsg(`Preço encontrado: ${r.supplier_name} — $${r.unit_price}/${r.unit} (${r.confidence}). Gravado no histórico.`);
      load();
    } else {
      setAiMsg('Detalhamento gerado e salvo no material.');
      load();
    }
    setAiBusy(null);
  }

  async function load() {
    if (!activeOrg) return;
    setLoading(true);
    const [{ data: m, error }, { data: w }, { data: s }] = await Promise.all([
      supabase.from('materials').select('*').eq('org_id', activeOrg.id).order('name'),
      supabase.from('wbs_nodes').select('*').order('sort_order'),
      supabase.from('suppliers').select('*').eq('org_id', activeOrg.id).order('name'),
    ]);
    if (error) setErr(error.message); else setRows(m ?? []);
    setWbs(w ?? []); setSuppliers(s ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeOrg?.id]);

  const nameByCode = Object.fromEntries(wbs.map((n) => [n.code, n.name]));
  const leafNodes = wbs.filter((n) => n.is_leaf);

  function startNew() { setDraft(empty); setEditing('new'); }
  function startEdit(m: Material) {
    setDraft({
      name: m.name, wbs_code: m.wbs_code ?? '', spec_level: m.spec_level,
      brand: m.brand ?? '', model: m.model ?? '', unit: m.unit,
      fl_approval: m.fl_approval ?? '', specs: m.specs ?? '',
      preferred_supplier_id: m.preferred_supplier_id ?? '',
    });
    setEditing(m.id);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const payload = {
      org_id: activeOrg!.id,
      name: draft.name,
      wbs_code: draft.wbs_code || null,
      spec_level: draft.spec_level,
      brand: draft.brand || null,
      model: draft.model || null,
      unit: draft.unit,
      fl_approval: draft.fl_approval || null,
      specs: draft.specs || null,
      preferred_supplier_id: draft.preferred_supplier_id || null,
    };
    const res = editing === 'new'
      ? await supabase.from('materials').insert(payload)
      : await supabase.from('materials').update(payload).eq('id', editing!);
    if (res.error) setErr(res.error.message);
    else { setEditing(null); load(); }
  }

  async function remove(id: string) {
    if (!confirm('Excluir este material?')) return;
    const { error } = await supabase.from('materials').delete().eq('id', id);
    if (error) setErr(error.message); else load();
  }

  const shown = filterLevel ? rows.filter((r) => r.spec_level === filterLevel) : rows;

  return (
    <div>
      <header className="page-head">
        <h1>Materiais</h1>
        <div className="row-actions">
          <label className="btn" style={{ cursor: 'pointer' }}>✨ Cotação IA (PDF)
            <input type="file" accept="application/pdf" style={{ display: 'none' }}
              onChange={(e) => { setQuoteFile(e.target.files?.[0] ?? null); setQuoteRows(null); setQuoteMeta(null); setErr(null); }} />
          </label>
          <button className="btn" onClick={() => setImporting(true)}>⬆ Importar planilha</button>
          <button className="btn primary" onClick={startNew}>Novo material</button>
        </div>
      </header>

      {importing && (
        <ImportDialog
          title="Importar materiais"
          fields={MATERIAL_FIELDS}
          onClose={() => setImporting(false)}
          onImport={importMaterials}
          intro={<>Suba o export de <strong>Cost Catalog / Cost Items</strong> do Buildertrend (.xlsx ou .csv).
            A unidade é normalizada e o código vira a categoria WBS correspondente (ou fica em branco).</>}
        />
      )}

      {aiMsg && <p className="success">{aiMsg}</p>}
      {err && <p className="error">{err}</p>}

      {quoteFile && !quoteRows && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Ler cotação com IA</h2>
          <p className="muted small">A IA lê o PDF, identifica cada material, sua <strong>categoria</strong> e o
            <strong> nível</strong> que ele representa — ou marca <em>"todos os níveis"</em> quando é commodity
            (concreto, vergalhão, madeira genérica). Você revisa tudo antes de gravar.</p>
          <p><strong>{quoteFile.name}</strong></p>
          <div className="row-actions">
            <button className="btn primary" disabled={quoteBusy} onClick={extractQuote}>
              {quoteBusy ? 'Lendo…' : 'Ler com IA'}</button>
            <button className="btn" disabled={quoteBusy} onClick={() => setQuoteFile(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {quoteRows && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Revisar cotação{quoteMeta?.supplier ? ` — ${quoteMeta.supplier}` : ''}</h2>
          {quoteMeta?.notes && <p className="muted small">{quoteMeta.notes}
            {quoteMeta.confidence && ` · confiança: ${quoteMeta.confidence}`}</p>}
          <table className="table">
            <thead><tr><th>Material</th><th>Categoria</th><th>Nível</th><th>Marca/Modelo</th><th>Unid</th><th className="num">Cotado</th><th></th></tr></thead>
            <tbody>
              {quoteRows.length === 0 && <tr><td colSpan={7} className="muted center">A IA não encontrou itens.</td></tr>}
              {quoteRows.map((r, i) => (
                <tr key={i}>
                  <td><input value={r.name} onChange={(e) => patchRow(i, { name: e.target.value })} /></td>
                  <td><select value={r.wbs_code} onChange={(e) => patchRow(i, { wbs_code: e.target.value })}>
                    <option value="">—</option>
                    {wbs.map((n) => <option key={n.code} value={n.code}>{n.code} · {n.name}</option>)}
                  </select></td>
                  <td><select value={r.spec_level} onChange={(e) => patchRow(i, { spec_level: e.target.value as SpecLevel })}>
                    {LEVELS.map((l) => <option key={l} value={l}>{SPEC_LEVEL_LABEL[l]}</option>)}
                  </select></td>
                  <td className="muted small">{[r.brand, r.model].filter(Boolean).join(' ') || '—'}</td>
                  <td className="muted small">{UNIT_LABEL[r.unit] ?? r.unit}</td>
                  <td className="num muted small">{r.unit_price != null ? `$${r.unit_price}` : '—'}</td>
                  <td><button className="link danger"
                    onClick={() => setQuoteRows((rows) => rows && rows.filter((_, j) => j !== i))}>remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-actions" style={{ marginTop: '.75rem' }}>
            <button className="btn primary" disabled={quoteRows.length === 0} onClick={confirmQuoteImport}>
              Importar {quoteRows.length} material(is)</button>
            <button className="btn" onClick={() => { setQuoteRows(null); setQuoteMeta(null); setQuoteFile(null); }}>Descartar</button>
          </div>
        </div>
      )}

      <div className="filters">
        <label className="inline">Nível
          <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as SpecLevel | '')}>
            <option value="">Todos</option>
            {LEVELS.map((l) => <option key={l} value={l}>{SPEC_LEVEL_LABEL[l]}</option>)}
          </select>
        </label>
      </div>

      {editing && (
        <form className="card form-grid" onSubmit={save}>
          <label>Nome<input value={draft.name} required
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Categoria WBS
            <select value={draft.wbs_code} onChange={(e) => setDraft({ ...draft, wbs_code: e.target.value })}>
              <option value="">—</option>
              {leafNodes.map((n) => <option key={n.code} value={n.code}>{n.code} · {n.name}</option>)}
            </select>
          </label>
          <label>Nível
            <select value={draft.spec_level} onChange={(e) => setDraft({ ...draft, spec_level: e.target.value as SpecLevel })}>
              {LEVELS.map((l) => <option key={l} value={l}>{SPEC_LEVEL_LABEL[l]}</option>)}
            </select>
          </label>
          <label>Marca<input value={draft.brand} onChange={(e) => setDraft({ ...draft, brand: e.target.value })} /></label>
          <label>Modelo<input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
          <label>Unidade
            <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as Unit })}>
              {UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
            </select>
          </label>
          <label>FL Product Approval (FL#)
            <input value={draft.fl_approval} onChange={(e) => setDraft({ ...draft, fl_approval: e.target.value })} /></label>
          <label>Fornecedor preferencial
            <select value={draft.preferred_supplier_id}
              onChange={(e) => setDraft({ ...draft, preferred_supplier_id: e.target.value })}>
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="span-all">Specs / memorial
            <textarea value={draft.specs} rows={2}
              onChange={(e) => setDraft({ ...draft, specs: e.target.value })} /></label>
          {err && <p className="error span-all">{err}</p>}
          <div className="span-all row-actions">
            <button className="btn primary" type="submit">Salvar</button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {loading ? <p className="muted">Carregando…</p> : (
        <table className="table">
          <thead><tr><th>Material</th><th>Categoria</th><th>Nível</th><th>Marca/Modelo</th><th>FL#</th><th></th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={6} className="muted center">Nenhum material.</td></tr>}
            {shown.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted small">{m.wbs_code ? `${m.wbs_code} · ${nameByCode[m.wbs_code] ?? ''}` : '—'}</td>
                <td><span className={`level-badge ${m.spec_level}`}>{SPEC_LEVEL_LABEL[m.spec_level]}</span></td>
                <td>{[m.brand, m.model].filter(Boolean).join(' ') || '—'}</td>
                <td className="mono small">{m.fl_approval ?? '—'}</td>
                <td className="row-actions">
                  <button className="link" onClick={() => startEdit(m)}>Editar</button>
                  <button className="link ai" disabled={aiBusy === m.id}
                    onClick={() => runAgent('price-search', m.id)}>
                    {aiBusy === m.id ? '…' : 'Preço IA'}
                  </button>
                  <button className="link ai" disabled={aiBusy === m.id}
                    onClick={() => runAgent('product-detail', m.id)}>Detalhar IA</button>
                  <button className="link danger" onClick={() => remove(m.id)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
