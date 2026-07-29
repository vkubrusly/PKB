import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Estimate, EstimateItem, Program, Project, WbsNode } from '../lib/database.types';
import { EMPTY_PROGRAM } from '../lib/estimateEngine';
import {
  money, number, psf, SPEC_LEVEL_LABEL, UNIT_LABEL, WATER_LABEL, SEWER_LABEL,
} from '../lib/format';

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

  useEffect(() => {
    if (!activeEstimate) { setItems([]); return; }
    (async () => {
      const { data, error } = await supabase
        .from('estimate_items').select('*')
        .eq('estimate_id', activeEstimate)
        .order('sort_order');
      if (error) setErr(error.message);
      else setItems(data ?? []);
    })();
  }, [activeEstimate]);

  const categories = useMemo(() => wbs.filter((n) => n.depth === 1), [wbs]);
  const nameByCode = useMemo(
    () => Object.fromEntries(wbs.map((n) => [n.code, n.name])), [wbs],
  );

  const grandTotal = useMemo(() => items.reduce((s, it) => s + Number(it.line_total), 0), [items]);

  const catOf = (it: EstimateItem) => (it.line_code ?? it.wbs_code).split('.')[0];

  if (loading) return <p className="muted">Carregando…</p>;
  if (!project) return <p className="error">Projeto não encontrado. <Link to="/projetos">Voltar</Link></p>;

  const est = estimates.find((e) => e.id === activeEstimate);

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

          <div className="totals-bar">
            <div><span className="muted small">Total</span><strong>{money(grandTotal)}</strong></div>
            <div><span className="muted small">$/sf (total)</span><strong>{psf(grandTotal, project.total_area_sf)}</strong></div>
            <div><span className="muted small">$/sf (living)</span><strong>{psf(grandTotal, project.living_area_sf)}</strong></div>
            <div><span className="muted small">Linhas</span><strong>{items.length}</strong></div>
          </div>

          <table className="table estimate">
            <thead>
              <tr>
                <th>COD</th><th>Item</th><th className="num">Qtd</th><th>Un</th>
                <th className="num">Custo Un.</th><th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => {
                const catItems = items.filter((it) => catOf(it) === cat.code);
                if (catItems.length === 0) return null;
                const sub = catItems.reduce((s, it) => s + Number(it.line_total), 0);
                return (
                  <ItemGroup key={cat.code} code={cat.code} name={cat.name}
                    subtotal={sub} items={catItems} nameByCode={nameByCode} />
                );
              })}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td colSpan={5}>TOTAL {est ? `— ${SPEC_LEVEL_LABEL[est.level]}` : ''}</td>
                <td className="num">{money(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}

function ItemGroup({ code, name, subtotal, items, nameByCode }: {
  code: string; name: string; subtotal: number; items: EstimateItem[];
  nameByCode: Record<string, string>;
}) {
  return (
    <>
      <tr className="cat-row">
        <td>{code}</td>
        <td>{name}</td>
        <td colSpan={2}></td>
        <td className="num muted small">Sub-total {code}</td>
        <td className="num"><strong>{money(subtotal)}</strong></td>
      </tr>
      {items.map((it) => (
        <tr key={it.id} className={it.needs_review ? 'flagged' : undefined}>
          <td className="mono">{it.line_code ?? it.wbs_code}</td>
          <td>
            {it.description ?? nameByCode[it.wbs_code] ?? it.wbs_code}
            {it.is_allowance && <span className="tag">allowance</span>}
            {it.needs_review && <span className="tag warn">⚠ revisar</span>}
          </td>
          <td className="num">{number(it.qty)}</td>
          <td>{UNIT_LABEL[it.unit] ?? it.unit}</td>
          <td className="num">{money(Number(it.unit_cost))}</td>
          <td className="num">{money(Number(it.line_total))}</td>
        </tr>
      ))}
    </>
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
