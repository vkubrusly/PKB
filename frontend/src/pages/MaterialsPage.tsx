import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Material, SpecLevel, Supplier, Unit, WbsNode } from '../lib/database.types';
import { SPEC_LEVEL_LABEL, UNIT_LABEL } from '../lib/format';
import { ImportDialog, type ImportResult } from '../components/ImportDialog';
import { MATERIAL_FIELDS, normalizeUnit, coerceWbsCode } from '../lib/importMap';

const UNITS: Unit[] = ['ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo'];
const LEVELS: SpecLevel[] = ['essential', 'signature', 'luxury', 'any'];

const empty = {
  name: '', wbs_code: '', spec_level: 'any' as SpecLevel, brand: '', model: '',
  unit: 'ea' as Unit, fl_approval: '', specs: '', preferred_supplier_id: '',
};
type Draft = typeof empty;

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
          <button className="btn" onClick={() => setImporting(true)}>⬆ Importar</button>
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
