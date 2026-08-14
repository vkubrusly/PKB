import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Estimate, EstimateItem, EstimateItemFile, Program, Project, WbsNode } from '../lib/database.types';
import { EMPTY_PROGRAM } from '../lib/estimateEngine';
import { downloadCSV, printEstimate, type ExpLine } from '../lib/exportEstimate';
import {
  money, number, psf, SPEC_LEVEL_LABEL, UNIT_LABEL, WATER_LABEL, SEWER_LABEL,
} from '../lib/format';

type Item = EstimateItem;
const UNITS = ['ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo'] as const;
const eff = (it: Item) => Number(it.qty || 0) * (1 + Number(it.waste_factor || 0));
const baseTot = (it: Item) => eff(it) * Number(it.unit_cost || 0);
const realTot = (it: Item) => eff(it) * Number(it.actual_unit_cost ?? it.unit_cost ?? 0);

// Δ vs base: red when over base, green when under (savings).
function deltaCell(d: number) {
  if (Math.abs(d) < 0.005) return <span className="muted">—</span>;
  return <span className={d > 0 ? 'delta-up' : 'delta-down'}>{d > 0 ? '+' : '−'}{money(Math.abs(d))}</span>;
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [prog, setProg] = useState<Program | null>(null);
  const [progSaved, setProgSaved] = useState(false);
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [activeEstimate, setActiveEstimate] = useState<string | null>(null);
  const [items, setItems] = useState<EstimateItem[]>([]);
  const [wbs, setWbs] = useState<WbsNode[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // edit mode (reopen estimate)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EstimateItem[]>([]);
  const [savingEst, setSavingEst] = useState(false);
  const [files, setFiles] = useState<Record<string, EstimateItemFile[]>>({});
  const [removed, setRemoved] = useState<string[]>([]); // ids to delete on save

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: p, error: pe }, { data: es, error: ee }, { data: w }] = await Promise.all([
        supabase.from('projects').select('*').eq('id', id).single(),
        supabase.from('estimates').select('*').eq('project_id', id).order('level'),
        supabase.from('wbs_nodes').select('*').order('sort_order'),
      ]);
      if (pe) setErr(pe.message);
      if (ee) setErr(ee.message);
      setProject(p ?? null);
      setProg(p ? { ...EMPTY_PROGRAM, ...(p.program ?? {}) } : null);
      setEstimates(es ?? []);
      setWbs(w ?? []);
      setActiveEstimate((es ?? [])[0]?.id ?? null);
      setLoading(false);
    })();
  }, [id]);

  async function loadItems() {
    if (!activeEstimate) { setItems([]); setFiles({}); return; }
    const { data, error } = await supabase
      .from('estimate_items').select('*')
      .eq('estimate_id', activeEstimate)
      .order('sort_order');
    if (error) { setErr(error.message); return; }
    setItems(data ?? []);
    const ids = (data ?? []).map((it) => it.id);
    if (ids.length) {
      const { data: fs } = await supabase.from('estimate_item_files').select('*').in('estimate_item_id', ids);
      const map: Record<string, EstimateItemFile[]> = {};
      for (const f of fs ?? []) (map[f.estimate_item_id] ??= []).push(f);
      setFiles(map);
    } else setFiles({});
  }
  useEffect(() => { loadItems(); setEditing(false); /* eslint-disable-next-line */ }, [activeEstimate]);

  const categories = useMemo(() => wbs.filter((n) => n.depth === 1), [wbs]);
  const nameByCode = useMemo(
    () => Object.fromEntries(wbs.map((n) => [n.code, n.name])), [wbs],
  );

  const catOf = (it: EstimateItem) => (it.line_code ?? it.wbs_code).split('.')[0];

  if (loading) return <p className="muted">Carregando…</p>;
  if (!project) return <p className="error">Projeto não encontrado. <Link to="/projetos">Voltar</Link></p>;

  const est = estimates.find((e) => e.id === activeEstimate);
  const displayed = editing ? draft : items;
  const grandTotal = displayed.reduce((s, it) => s + realTot(it), 0);
  const baseGrand = displayed.reduce((s, it) => s + baseTot(it), 0);
  const origIds = new Set(items.map((i) => i.id));

  function exportData() {
    // Export the REAL cost where set, else the base estimate.
    const expLines: ExpLine[] = items.map((it) => ({
      line_code: it.line_code, wbs_code: it.wbs_code, description: it.description ?? it.wbs_code,
      qty: Number(it.qty), unit: it.unit,
      unit_cost: Number(it.actual_unit_cost ?? it.unit_cost), line_total: realTot(it),
    }));
    const catNameMap = Object.fromEntries(categories.map((c) => [c.code, c.name]));
    const meta = {
      projectName: project!.name, levelLabel: est ? SPEC_LEVEL_LABEL[est.level] : undefined,
      county: project!.county, address: project!.address,
      totalSf: project!.total_area_sf, livingSf: project!.living_area_sf, grandTotal,
    };
    return { expLines, catNameMap, meta };
  }

  function startEdit() { setDraft(items.map((it) => ({ ...it }))); setRemoved([]); setEditing(true); }
  function cancelEdit() { setEditing(false); setDraft([]); setRemoved([]); }
  function patch(id: string, p: Partial<Item>) { setDraft((d) => d.map((it) => (it.id === id ? { ...it, ...p } : it))); }
  function addLine(cat: string) {
    const nu = {
      id: crypto.randomUUID(), org_id: project!.org_id, estimate_id: activeEstimate!,
      wbs_code: cat, line_code: null, material_id: null, supplier_id: null, description: '',
      qty: 1, unit: 'ls', unit_cost: 0, actual_unit_cost: null, waste_factor: 0,
      price_source: 'estimated', needs_review: true, is_allowance: false,
      sort_order: draft.length + 1, qty_effective: 1, line_total: 0,
    } as unknown as Item;
    setDraft((d) => [...d, nu]);
  }
  function removeLine(id: string) {
    if (origIds.has(id)) setRemoved((r) => [...r, id]);
    setDraft((d) => d.filter((it) => it.id !== id));
  }

  async function saveEstimate() {
    setSavingEst(true); setErr(null);
    try {
      const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
      // Base (unit_cost) is FROZEN: never send it on update, so the AI-suggested
      // base is preserved. Only the real price and editable fields change.
      const toUpdate = draft.filter((it) => origIds.has(it.id)).map((it, i) => ({
        id: it.id, wbs_code: it.wbs_code, line_code: it.line_code, description: it.description,
        qty: Number(it.qty) || 0, unit: it.unit,
        actual_unit_cost: num(it.actual_unit_cost), sort_order: i + 1,
      }));
      // New manual lines have no AI base → base = the real price entered (Δ = 0).
      const toInsert = draft.filter((it) => !origIds.has(it.id)).map((it, i) => ({
        org_id: project!.org_id, estimate_id: activeEstimate, wbs_code: it.wbs_code,
        line_code: it.line_code, description: it.description || null, qty: Number(it.qty) || 0,
        unit: it.unit, unit_cost: num(it.actual_unit_cost) ?? (Number(it.unit_cost) || 0),
        actual_unit_cost: num(it.actual_unit_cost),
        price_source: 'estimated', needs_review: true, sort_order: draft.length + i,
      }));
      if (toUpdate.length) { const { error } = await supabase.from('estimate_items').upsert(toUpdate); if (error) throw error; }
      if (toInsert.length) { const { error } = await supabase.from('estimate_items').insert(toInsert); if (error) throw error; }
      if (removed.length) { const { error } = await supabase.from('estimate_items').delete().in('id', removed); if (error) throw error; }
      // Accumulate price knowledge from the REAL prices entered.
      const obs = draft.filter((it) => num(it.actual_unit_cost) && Number(it.actual_unit_cost) > 0).map((it) => ({
        org_id: project!.org_id, wbs_code: it.wbs_code, line_code: it.line_code, description: it.description,
        unit: it.unit, unit_price: Number(it.actual_unit_cost), county: project!.county,
        source: 'real_quote', estimate_item_id: origIds.has(it.id) ? it.id : null,
      }));
      if (obs.length) await supabase.from('price_observations').insert(obs);
      setEditing(false); setRemoved([]);
      await loadItems();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSavingEst(false); }
  }

  async function uploadFiles(itemId: string, list: FileList | null) {
    if (!list?.length) return;
    setErr(null);
    for (const file of Array.from(list)) {
      const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_');
      const path = `${project!.org_id}/quotes/${itemId}/${Date.now()}-${safe}`;
      const up = await supabase.storage.from('plantas').upload(path, file);
      if (up.error) { setErr(`Falha ao subir o arquivo: ${up.error.message}`); continue; }
      const { data, error } = await supabase.from('estimate_item_files')
        .insert({ org_id: project!.org_id, estimate_item_id: itemId, file_path: path, file_name: file.name })
        .select('*').single();
      if (error) {
        // roll back the orphaned upload so we don't leave dangling files
        await supabase.storage.from('plantas').remove([path]).catch(() => {});
        setErr(`Anexo não registrado: ${error.message}. Rode a migration 0012/0013 (tabela estimate_item_files).`);
      } else if (data) {
        setFiles((f) => ({ ...f, [itemId]: [...(f[itemId] || []), data] }));
      }
    }
  }
  async function openFile(f: EstimateItemFile) {
    const { data } = await supabase.storage.from('plantas').createSignedUrl(f.file_path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }
  // Mark one quote as the chosen one for its line (unmarks the siblings).
  async function chooseFile(itemId: string, fileId: string) {
    const cur = files[itemId] ?? [];
    const already = cur.find((f) => f.id === fileId)?.is_chosen;
    const next = cur.map((f) => ({ ...f, is_chosen: f.id === fileId ? !already : false }));
    setFiles((fm) => ({ ...fm, [itemId]: next }));
    await supabase.from('estimate_item_files').update({ is_chosen: false }).eq('estimate_item_id', itemId);
    if (!already) await supabase.from('estimate_item_files').update({ is_chosen: true }).eq('id', fileId);
  }
  async function setSupplier(itemId: string, fileId: string, supplier: string) {
    setFiles((fm) => ({ ...fm, [itemId]: (fm[itemId] || []).map((f) => (f.id === fileId ? { ...f, supplier } : f)) }));
    await supabase.from('estimate_item_files').update({ supplier: supplier || null }).eq('id', fileId);
  }
  // 3-state line status:
  //  🟢 green  — decided: a quote is chosen, OR (no quotes) the real price is set.
  //  🔴 red    — quotes attached but none chosen yet (decision pending).
  //  🟡 yellow — no quotes and no real price yet (waiting for you to enter it).
  const lineStatus = (it: Item): 'green' | 'red' | 'yellow' => {
    const fs = files[it.id] ?? [];
    if (fs.length > 0) return fs.some((f) => f.is_chosen) ? 'green' : 'red';
    return it.actual_unit_cost != null ? 'green' : 'yellow';
  };
  async function deleteFile(f: EstimateItemFile) {
    await supabase.storage.from('plantas').remove([f.file_path]);
    await supabase.from('estimate_item_files').delete().eq('id', f.id);
    setFiles((fm) => ({ ...fm, [f.estimate_item_id]: (fm[f.estimate_item_id] || []).filter((x) => x.id !== f.id) }));
  }

  async function saveProgram() {
    if (!project || !prog) return;
    setProgSaved(false); setErr(null);
    const { error } = await supabase.from('projects').update({ program: prog }).eq('id', project.id);
    if (error) setErr(error.message);
    else { setProject({ ...project, program: prog }); setProgSaved(true); }
  }

  async function removeProject() {
    if (!project) return;
    if (!confirm(`Excluir o projeto "${project.name}"? Isso apaga também todos os orçamentos e itens ligados a ele. Esta ação não pode ser desfeita.`)) return;
    setDeleting(true); setErr(null);
    const { error } = await supabase.from('projects').delete().eq('id', project.id);
    if (error) { setErr(error.message); setDeleting(false); }
    else nav('/projetos');
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <Link to="/projetos" className="muted small">← Projetos</Link>
          <h1>{project.name}</h1>
        </div>
        <button className="btn danger-outline" disabled={deleting} onClick={removeProject}>
          {deleting ? 'Excluindo…' : '🗑 Excluir projeto'}
        </button>
      </header>

      {err && <p className="error">{err}</p>}

      <section className="fact-grid">
        <Fact label="Modelo" value={project.base_model} />
        <Fact label="Condado" value={project.county} />
        <Fact label="Mercado" value={project.market} />
        <Fact label="Nível" value={project.initial_level ? SPEC_LEVEL_LABEL[project.initial_level] : null} />
        <Fact label="Living (sf)" value={number(project.living_area_sf)} />
        <Fact label="Total (sf)" value={number(project.total_area_sf)} />
        <Fact label="Água" value={project.water ? WATER_LABEL[project.water] : null} />
        <Fact label="Esgoto" value={project.sewer ? SEWER_LABEL[project.sewer] : null} />
        <Fact label="Flood zone" value={project.flood_zone} />
        <Fact label="Wind speed" value={project.wind_speed_mph ? `${project.wind_speed_mph} mph` : null} />
      </section>

      {prog && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Programa
            <span className="muted small" style={{ fontWeight: 400 }}> — contagens que dirigem a escala de custo por driver</span></h2>
          <div className="form-grid prog-grid">
            {([
              ['bedrooms', 'Quartos'], ['full_baths', 'Banheiros (full)'], ['half_baths', 'Lavabos (½)'],
              ['kitchens', 'Cozinhas'], ['laundries', 'Lavanderias'], ['garage_bays', 'Vagas garagem'],
              ['stories', 'Pavimentos'], ['doors', 'Portas'], ['windows', 'Janelas'],
            ] as [Exclude<keyof Program, 'has_inlaw'>, string][]).map(([k, label]) => (
              <label key={k}>{label}
                <input type="number" min={0} value={prog[k]}
                  onChange={(e) => { setProg({ ...prog, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }); setProgSaved(false); }} />
              </label>
            ))}
            <label className="checkbox">
              <input type="checkbox" checked={prog.has_inlaw}
                onChange={(e) => { setProg({ ...prog, has_inlaw: e.target.checked }); setProgSaved(false); }} />
              Suíte in-law
            </label>
          </div>
          <div className="row-actions" style={{ marginTop: '.5rem' }}>
            <button className="btn primary" onClick={saveProgram}>Salvar programa</button>
            {progSaved && <span className="success small">Programa salvo ✓</span>}
          </div>
        </section>
      )}

      {estimates.length === 0 ? (
        <p className="muted">Nenhum orçamento para este projeto ainda.</p>
      ) : (
        <>
          <div className="estimate-tabs">
            {estimates.map((e) => (
              <button key={e.id}
                className={e.id === activeEstimate ? 'chip active' : 'chip'}
                onClick={() => setActiveEstimate(e.id)}>
                {SPEC_LEVEL_LABEL[e.level]} · v{e.version} · {e.status}
              </button>
            ))}
          </div>

          <div className="row-actions" style={{ margin: '0 0 .75rem', flexWrap: 'wrap' }}>
            {!editing ? (
              <>
                <button className="btn primary" onClick={startEdit} disabled={!activeEstimate}>✎ Reabrir / editar</button>
                <button className="btn" disabled={items.length === 0}
                  onClick={() => { const d = exportData(); printEstimate(d.expLines, d.meta, d.catNameMap); }}>🖨 Imprimir / PDF</button>
                <button className="btn" disabled={items.length === 0}
                  onClick={() => { const d = exportData(); downloadCSV(d.expLines, d.meta, d.catNameMap); }}>⬇ Exportar Excel</button>
              </>
            ) : (
              <>
                <button className="btn primary" onClick={saveEstimate} disabled={savingEst}>{savingEst ? 'Salvando…' : 'Salvar alterações'}</button>
                <button className="btn" onClick={cancelEdit} disabled={savingEst}>Cancelar</button>
                <span className="muted small">Base = estimativa inicial (não muda). Real orçado = preço negociado. Anexe cotações por linha — os preços reais alimentam a memória.</span>
              </>
            )}
          </div>

          <div className="totals-bar">
            <div><span className="muted small">Total base</span><strong>{money(baseGrand)}</strong></div>
            <div><span className="muted small">Total real</span><strong>{money(grandTotal)}</strong></div>
            <div><span className="muted small">Diferença</span><strong>{deltaCell(grandTotal - baseGrand)}</strong></div>
            <div><span className="muted small">$/sf (real)</span><strong>{psf(grandTotal, project.total_area_sf)}</strong></div>
            <div><span className="muted small">Linhas</span><strong>{displayed.length}</strong></div>
          </div>

          <div className="tablewrap">
          <table className="table estimate">
            <thead>
              <tr>
                <th></th><th>COD</th><th>Item</th><th className="num">Qtd</th><th>Un</th>
                <th className="num">Base (un)</th><th className="num">Real orçado (un)</th>
                <th className="num">Total</th><th className="num">Δ</th>
                {editing && <th></th>}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => {
                const catItems = displayed.filter((it) => catOf(it) === cat.code);
                if (catItems.length === 0 && !editing) return null;
                const sub = catItems.reduce((s, it) => s + realTot(it), 0);
                const subBase = catItems.reduce((s, it) => s + baseTot(it), 0);
                return (
                  <Fragment key={cat.code}>
                    <tr className="cat-row">
                      <td></td><td>{cat.code}</td><td>{cat.name}</td><td colSpan={4}></td>
                      <td className="num"><strong>{money(sub)}</strong></td>
                      <td className="num">{deltaCell(sub - subBase)}</td>
                      {editing && <td></td>}
                    </tr>
                    {catItems.map((it) => (editing ? (
                      <tr key={it.id}>
                        <td className="center"><StatusDot status={lineStatus(it)} /></td>
                        <td className="mono">{it.line_code ?? it.wbs_code}</td>
                        <td>
                          <input value={it.description ?? ''} placeholder={nameByCode[it.wbs_code] ?? it.wbs_code}
                            onChange={(e) => patch(it.id, { description: e.target.value })} style={{ minWidth: 170 }} />
                          <LineFiles files={files[it.id] ?? []} isNew={!origIds.has(it.id)} editing
                            onUpload={(l) => uploadFiles(it.id, l)} onOpen={openFile} onDelete={deleteFile}
                            onChoose={(fid) => chooseFile(it.id, fid)} onSupplier={(fid, v) => setSupplier(it.id, fid, v)} />
                        </td>
                        <td className="num"><input className="cost-input" type="number" value={it.qty}
                          onChange={(e) => patch(it.id, { qty: Number(e.target.value) })} /></td>
                        <td>
                          <select value={it.unit} onChange={(e) => patch(it.id, { unit: e.target.value as EstimateItem['unit'] })}>
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </td>
                        <td className="num" title="Preço base sugerido — congelado">{money(Number(it.unit_cost))}</td>
                        <td className="num"><input className="cost-input" type="number" step="0.01" autoFocus={false}
                          value={it.actual_unit_cost ?? ''} placeholder="—"
                          onChange={(e) => patch(it.id, { actual_unit_cost: e.target.value === '' ? null : Number(e.target.value) } as Partial<Item>)} /></td>
                        <td className="num">{money(realTot(it))}</td>
                        <td className="num">{deltaCell(realTot(it) - baseTot(it))}</td>
                        <td><button className="link danger" title="Remover" onClick={() => removeLine(it.id)}>×</button></td>
                      </tr>
                    ) : (
                      <tr key={it.id} className={it.needs_review ? 'flagged' : undefined}>
                        <td className="center"><StatusDot status={lineStatus(it)} /></td>
                        <td className="mono">{it.line_code ?? it.wbs_code}</td>
                        <td>
                          {it.description ?? nameByCode[it.wbs_code] ?? it.wbs_code}
                          {it.needs_review && <span className="tag warn">⚠ revisar</span>}
                          {(files[it.id]?.length ?? 0) > 0 && (
                            <span className="attach-chips">
                              {files[it.id].map((f) => (
                                <button key={f.id} type="button" className={f.is_chosen ? 'chip-file chosen' : 'chip-file'}
                                  onClick={() => openFile(f)} title={f.is_chosen ? 'orçamento escolhido' : undefined}>
                                  {f.is_chosen ? '✓ ' : '📎 '}{f.supplier ? `${f.supplier}: ` : ''}{f.file_name ?? 'anexo'}
                                </button>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="num">{number(it.qty)}</td>
                        <td>{UNIT_LABEL[it.unit] ?? it.unit}</td>
                        <td className="num">{money(Number(it.unit_cost))}</td>
                        <td className="num">{it.actual_unit_cost != null ? money(Number(it.actual_unit_cost)) : <span className="muted">—</span>}</td>
                        <td className="num">{money(realTot(it))}</td>
                        <td className="num">{deltaCell(realTot(it) - baseTot(it))}</td>
                      </tr>
                    )))}
                    {editing && (
                      <tr><td colSpan={10}>
                        <button className="link" onClick={() => addLine(cat.code)}>＋ linha em {cat.code} · {cat.name}</button>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td colSpan={5}>TOTAL {est ? `— ${SPEC_LEVEL_LABEL[est.level]}` : ''}</td>
                <td className="num" title="Somatório base"><strong>{money(baseGrand)}</strong></td>
                <td></td>
                <td className="num" title="Somatório real"><strong>{money(grandTotal)}</strong></td>
                <td className="num" title="Soma da diferença"><strong>{deltaCell(grandTotal - baseGrand)}</strong></td>
                {editing && <td></td>}
              </tr>
            </tfoot>
          </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: 'green' | 'red' | 'yellow' }) {
  const title = status === 'green' ? 'Definido'
    : status === 'red' ? 'Pendente: escolha qual cotação usar'
    : 'Pendente: informe o valor real orçado';
  return <span className={`dot ${status}`} title={title} />;
}

// Per-line supplier quotes. Multiple files from different suppliers; mark the
// chosen one and label its supplier. New lines must be saved before attaching.
function LineFiles({ files, isNew, editing, onUpload, onOpen, onDelete, onChoose, onSupplier }: {
  files: EstimateItemFile[]; isNew: boolean; editing?: boolean;
  onUpload: (l: FileList | null) => void;
  onOpen: (f: EstimateItemFile) => void;
  onDelete: (f: EstimateItemFile) => void;
  onChoose: (fileId: string) => void;
  onSupplier: (fileId: string, v: string) => void;
}) {
  return (
    <div className="quote-list">
      {files.map((f) => (
        <div key={f.id} className={f.is_chosen ? 'quote-row chosen' : 'quote-row'}>
          {editing && (
            <button type="button" className="star" title={f.is_chosen ? 'Escolhido — clique para desmarcar' : 'Usar este orçamento'}
              onClick={() => onChoose(f.id)}>{f.is_chosen ? '★' : '☆'}</button>
          )}
          {editing ? (
            <input className="sup" placeholder="fornecedor" defaultValue={f.supplier ?? ''}
              onBlur={(e) => { if ((e.target.value || '') !== (f.supplier ?? '')) onSupplier(f.id, e.target.value); }} />
          ) : (f.supplier && <span className="sup-name">{f.supplier}</span>)}
          <button type="button" className="fname" onClick={() => onOpen(f)}>📎 {f.file_name ?? 'anexo'}</button>
          {editing && <button type="button" className="x" title="Remover anexo" onClick={() => onDelete(f)}>×</button>}
        </div>
      ))}
      {editing && (isNew ? (
        <span className="muted small">salve a linha para anexar cotações</span>
      ) : (
        <label className="chip-file" style={{ cursor: 'pointer' }}>
          ＋ cotação de fornecedor
          <input type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { onUpload(e.target.files); e.currentTarget.value = ''; }} />
        </label>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="fact">
      <span className="muted small">{label}</span>
      <span>{value === null || value === '' ? '—' : value}</span>
    </div>
  );
}
