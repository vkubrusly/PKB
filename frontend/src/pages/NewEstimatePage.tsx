import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Program, SpecLevel, Unit } from '../lib/database.types';
import {
  generateFromProgram, toRefLines, EMPTY_PROGRAM, type GeneratedLine,
} from '../lib/estimateEngine';
import { money, number, psf, UNIT_LABEL } from '../lib/format';

interface RefOption {
  estimate_id: string; project_id: string | null; label: string;
  living: number | null; total: number | null;
}

type Method = 'model' | 'ai' | 'market';

export function NewEstimatePage() {
  const { activeOrg } = useAuth();
  const nav = useNavigate();

  const [step, setStep] = useState(1);
  // step 1 — project fields
  const [f, setF] = useState({
    name: '', base_model: '', county: '', market: '',
    living: '', total: '', water: '', sewer: '', flood_zone: '', wind: '',
    level: 'affordable' as Exclude<SpecLevel, 'any'>,
  });
  // Program (deep analysis) — counts that drive multi-factor scaling.
  const [prog, setProg] = useState<Program>({ ...EMPTY_PROGRAM, garage_bays: 2 });
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [planPath, setPlanPath] = useState<string | null>(null); // uploaded once, reused
  const [extracting, setExtracting] = useState(false);
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set());
  const [aiNote, setAiNote] = useState<string | null>(null);

  // step 2 — method
  const [method, setMethod] = useState<Method>('model');
  const [refs, setRefs] = useState<RefOption[]>([]);
  const [refId, setRefId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // step 3 — generated lines (editable)
  const [lines, setLines] = useState<GeneratedLine[]>([]);
  const [catName, setCatName] = useState<Record<string, string>>({});

  const target = { living_sf: Number(f.living) || 0, total_sf: Number(f.total) || 0 };

  useEffect(() => {
    if (!activeOrg) return;
    (async () => {
      // NB: don't join projects.program here — a DB without the 0011 migration
      // would 400 the whole query and hide every reference model. Program is
      // fetched lazily (best-effort) when a model is actually selected.
      const [{ data: es }, { data: w }] = await Promise.all([
        supabase.from('estimates').select('id, level, project_id, projects(name, living_area_sf, total_area_sf)')
          .eq('org_id', activeOrg.id),
        supabase.from('wbs_nodes').select('code, name').eq('depth', 1),
      ]);
      type Row = { id: string; level: string; project_id: string | null; projects: { name: string; living_area_sf: number | null; total_area_sf: number | null } | null };
      const opts = ((es ?? []) as unknown as Row[]).map((e) => ({
        estimate_id: e.id,
        project_id: e.project_id,
        label: `${e.projects?.name ?? 'Projeto'} · ${e.level}`,
        living: e.projects?.living_area_sf ?? null,
        total: e.projects?.total_area_sf ?? null,
      }));
      setRefs(opts);
      setRefId(opts[0]?.estimate_id ?? '');
      setCatName(Object.fromEntries((w ?? []).map((n: { code: string; name: string }) => [n.code, n.name])));
    })();
  }, [activeOrg?.id]);

  async function generateFromModel() {
    setBusy(true); setErr(null);
    try {
      const ref = refs.find((r) => r.estimate_id === refId);
      if (!ref) throw new Error('Escolha um modelo de referência.');
      if (!ref.living || !ref.total) throw new Error('O modelo de referência não tem áreas cadastradas.');
      const { data, error } = await supabase.from('estimate_items').select('*').eq('estimate_id', refId);
      if (error) throw error;
      // Best-effort: the reference model's program (counts) enables count-driver
      // scaling. If the column/data is absent, the engine falls back to area.
      let refProgram: Program | null = null;
      if (ref.project_id) {
        const { data: pj } = await supabase.from('projects').select('program').eq('id', ref.project_id).maybeSingle();
        refProgram = (pj?.program as Program | undefined) ?? null;
      }
      const out = generateFromProgram(
        toRefLines(data ?? []),
        { living_sf: ref.living, total_sf: ref.total }, refProgram,
        target, prog,
      );
      setLines(out.lines);
      setStep(3);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Upload the plans once; reuse the path for both extraction and take-off.
  async function ensurePlanUploaded(): Promise<string> {
    if (planPath) return planPath;
    if (!planFile) throw new Error('Escolha o PDF das plantas primeiro.');
    // Supabase Storage object keys reject spaces/accents/special chars — sanitize the filename.
    const safeName = planFile.name
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
      .replace(/[^\w.\-]+/g, '_')                         // spaces & symbols → _
      .replace(/_+/g, '_').replace(/^_|_$/g, '');
    const path = `${activeOrg!.id}/${Date.now()}-${safeName || 'plantas.pdf'}`;
    const up = await supabase.storage.from('plantas').upload(path, planFile);
    if (up.error) throw new Error(`Falha ao subir plantas: ${up.error.message}`);
    setPlanPath(path);
    return path;
  }

  // supabase-js returns a generic "non-2xx" message; the real cause is in the
  // Response carried on error.context. Surface it so failures are diagnosable.
  async function funcError(error: unknown): Promise<string> {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { const b = await ctx.json(); if (b?.error) return String(b.error); } catch { /* not JSON */ }
    }
    return error instanceof Error ? error.message : String(error);
  }

  // Document-first: read the plans and pre-fill the project fields.
  async function extractFromPlan() {
    setExtracting(true); setErr(null); setAiNote(null);
    try {
      const path = await ensurePlanUploaded();
      const { data, error } = await supabase.functions.invoke('project-extract', { body: { plan_path: path } });
      if (error) throw new Error(await funcError(error));
      if (data?.error) throw new Error(data.error);
      const r = data.result as Record<string, unknown>;
      const filled = new Set<string>();
      setF((prev) => {
        const next = { ...prev };
        const put = (k: keyof typeof prev, v: unknown) => {
          if (v !== null && v !== undefined && v !== '') {
            (next as Record<string, string>)[k as string] = String(v);
            filled.add(k as string);
          }
        };
        put('name', r.name); put('base_model', r.base_model); put('county', r.county); put('market', r.market);
        put('living', r.living_area_sf); put('total', r.total_area_sf);
        put('wind', r.wind_speed_mph); put('flood_zone', r.flood_zone);
        return next;
      });
      // Program counts drive the multi-factor scaling — fill what the AI read.
      setProg((prev) => {
        const np = { ...prev };
        const putN = (k: keyof Program, v: unknown) => {
          if (typeof v === 'number' && Number.isFinite(v)) { (np as Record<string, number | boolean>)[k] = v; filled.add(k); }
        };
        putN('bedrooms', r.bedrooms); putN('full_baths', r.full_baths); putN('half_baths', r.half_baths);
        putN('kitchens', r.kitchens); putN('laundries', r.laundries); putN('garage_bays', r.garage_bays);
        putN('stories', r.stories); putN('doors', r.doors); putN('windows', r.windows);
        if (typeof r.has_inlaw === 'boolean') { np.has_inlaw = r.has_inlaw; filled.add('has_inlaw'); }
        return np;
      });
      setAiFilled(filled);
      const extra = [r.kitchens && `${r.kitchens} cozinha(s)`, r.full_baths && `${r.full_baths} banheiro(s)`,
        r.bedrooms && `${r.bedrooms} quarto(s)`, r.has_inlaw && 'suíte in-law', r.notes]
        .filter(Boolean).join(' · ');
      setAiNote(`IA analisou as plantas${extra ? ` — ${extra}` : ''}. Confirme o programa e os campos abaixo antes de orçar.`);
    } catch (e) {
      setErr(
        (e instanceof Error ? e.message : String(e)) +
        ' — Exige a Edge Function "project-extract" com a chave da Claude API, e a policy do bucket (storage_policies.sql).',
      );
    } finally { setExtracting(false); }
  }

  async function generateFromAI() {
    setBusy(true); setErr(null);
    try {
      if (!planFile && !planPath) throw new Error('Anexe o PDF das plantas no passo 1 para o take-off por IA.');
      const path = await ensurePlanUploaded();
      const { data, error } = await supabase.functions.invoke('takeoff', {
        body: { plan_path: path, target, level: f.level },
      });
      if (error) throw error;
      const got = (data?.lines ?? []) as GeneratedLine[];
      if (!got.length) throw new Error('A IA não retornou linhas. Revise as plantas.');
      setLines(got);
      setStep(3);
    } catch (e) {
      setErr(
        (e instanceof Error ? e.message : String(e)) +
        ' — O take-off por IA exige a Edge Function "takeoff" implantada com a chave da Claude API (ver supabase/functions/takeoff).',
      );
    } finally { setBusy(false); }
  }

  // No reference model: ask the AI to build an estimate from internal price
  // history + Florida market knowledge, scaled to this project's level & program.
  async function generateFromMarket() {
    setBusy(true); setErr(null);
    try {
      if (!target.total_sf) throw new Error('Informe a área total (sf) no passo 1.');
      const { data, error } = await supabase.functions.invoke('estimate-market', {
        body: { org_id: activeOrg!.id, project: {
          county: f.county, market: f.market, level: f.level,
          living_sf: target.living_sf, total_sf: target.total_sf, program: prog,
        } },
      });
      if (error) throw new Error(await funcError(error));
      if (data?.error) throw new Error(data.error);
      const r = data.result as { lines: Record<string, unknown>[]; notes?: string; confidence?: string };
      const got: GeneratedLine[] = (r.lines ?? []).map((l) => {
        const qty = Number(l.qty) || 0;
        const unit_cost = Number(l.unit_cost) || 0;
        return {
          line_code: (l.line_code as string) ?? null,
          wbs_code: String(l.wbs_code ?? l.line_code ?? ''),
          description: String(l.description ?? ''),
          qty, unit: (l.unit as Unit) ?? 'ea', unit_cost,
          basis: (l.origin as GeneratedLine['basis']) ?? 'estimated', // shown in Driver col
          factor: 1, line_total: Math.round(qty * unit_cost * 100) / 100,
          needs_review: true, price_source: 'estimated' as const,
        };
      }).filter((l) => l.wbs_code);
      if (!got.length) throw new Error('A IA não retornou linhas.');
      setLines(got);
      const internal = typeof data.internal_lines === 'number' ? data.internal_lines : 0;
      setAiNote(`Estimativa por IA (${data.model ?? 'modelo'}) — ${got.length} linhas, ${internal} com histórico interno`
        + `${r.confidence ? ` · confiança ${r.confidence}` : ''}. Revise cada custo antes de salvar.`);
      setStep(3);
    } catch (e) {
      setErr((e instanceof Error ? e.message : String(e))
        + ' — Exige a Edge Function "estimate-market" com a chave da Claude API.');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const { data: proj, error: pe } = await supabase.from('projects').insert({
        org_id: activeOrg!.id, name: f.name, base_model: f.base_model || null,
        county: f.county || null, market: f.market || null,
        living_area_sf: target.living_sf || null, total_area_sf: target.total_sf || null,
        flood_zone: f.flood_zone || null, wind_speed_mph: f.wind ? Number(f.wind) : null,
        water: f.water || null, sewer: f.sewer || null, initial_level: f.level,
        program: prog,
      }).select('id').single();
      if (pe) throw pe;

      const { data: est, error: ee } = await supabase.from('estimates').insert({
        org_id: activeOrg!.id, project_id: proj!.id, level: f.level, status: 'draft',
        notes: method === 'model' ? 'Gerado por estimativa paramétrica (modelo-base).'
          : method === 'market' ? 'Gerado por IA (histórico interno + mercado FL).'
          : 'Gerado por take-off IA das plantas.',
      }).select('id').single();
      if (ee) throw ee;

      const rows = lines.map((l, i) => ({
        org_id: activeOrg!.id, estimate_id: est!.id, wbs_code: l.wbs_code,
        line_code: l.line_code, description: l.description, qty: l.qty,
        unit: l.unit as Unit, unit_cost: l.unit_cost,
        price_source: 'estimated' as const, needs_review: true, sort_order: i + 1,
      }));
      const { error: ie } = await supabase.from('estimate_items').insert(rows);
      if (ie) throw ie;
      nav(`/projetos/${proj!.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  const total = useMemo(() => lines.reduce((s, l) => s + l.line_total, 0), [lines]);
  const cats = useMemo(() => [...new Set(lines.map((l) => (l.line_code ?? l.wbs_code).split('.')[0]))]
    .sort((a, b) => Number(a) - Number(b)), [lines]);

  function editCost(idx: number, val: string) {
    setLines((prev) => prev.map((l, i) =>
      i === idx ? { ...l, unit_cost: Number(val) || 0, line_total: Math.round(l.qty * (Number(val) || 0) * 100) / 100 } : l));
  }

  return (
    <div>
      <header className="page-head">
        <h1>Novo orçamento</h1>
        <div className="steps">
          {['Projeto', 'Método', 'Revisão'].map((s, i) => (
            <span key={s} className={`step ${step === i + 1 ? 'on' : ''} ${step > i + 1 ? 'done' : ''}`}>{i + 1}. {s}</span>
          ))}
        </div>
      </header>

      {err && <p className="error">{err}</p>}

      {step === 1 && (
        <>
          <div className="card upload-hero">
            <div className="uh-text">
              <h2>Subir plantas → preencher com IA</h2>
              <p className="muted small">Anexe o PDF das plantas e a IA preenche o que estiver nelas (modelo, áreas, condado,
                wind speed, flood zone). Você revisa e ajusta os campos abaixo.</p>
            </div>
            <div className="uh-actions">
              <input type="file" accept="application/pdf"
                onChange={(e) => { setPlanFile(e.target.files?.[0] ?? null); setPlanPath(null); setAiFilled(new Set()); }} />
              <button className="btn primary" disabled={!planFile || extracting} onClick={extractFromPlan}>
                {extracting ? 'Lendo plantas…' : '✨ Preencher com IA'}
              </button>
            </div>
          </div>
          {aiNote && <p className="success">{aiNote}</p>}

          <div className="card form-grid">
            <label>Nome do projeto {aiFilled.has('name') && <span className="ai-tag">IA</span>}
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label>Modelo-base {aiFilled.has('base_model') && <span className="ai-tag">IA</span>}
              <input value={f.base_model} onChange={(e) => setF({ ...f, base_model: e.target.value })} /></label>
            <label>Condado {aiFilled.has('county') && <span className="ai-tag">IA</span>}
              <input value={f.county} onChange={(e) => setF({ ...f, county: e.target.value })} /></label>
            <label>Mercado {aiFilled.has('market') && <span className="ai-tag">IA</span>}
              <input value={f.market} onChange={(e) => setF({ ...f, market: e.target.value })} /></label>
            <label>Living Area (sf) {aiFilled.has('living') && <span className="ai-tag">IA</span>}
              <input type="number" value={f.living} onChange={(e) => setF({ ...f, living: e.target.value })} /></label>
            <label>Total Area (sf) {aiFilled.has('total') && <span className="ai-tag">IA</span>}
              <input type="number" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} /></label>
            <label>Água
              <select value={f.water} onChange={(e) => setF({ ...f, water: e.target.value })}>
                <option value="">—</option><option value="municipal">Municipal</option><option value="well">Poço</option>
              </select></label>
            <label>Esgoto
              <select value={f.sewer} onChange={(e) => setF({ ...f, sewer: e.target.value })}>
                <option value="">—</option><option value="municipal">Municipal</option>
                <option value="septic">Séptico</option><option value="septic_nitrogen">Séptico (redução N)</option>
              </select></label>
            <label>Flood zone {aiFilled.has('flood_zone') && <span className="ai-tag">IA</span>}
              <input value={f.flood_zone} onChange={(e) => setF({ ...f, flood_zone: e.target.value })} /></label>
            <label>Wind speed (mph) {aiFilled.has('wind') && <span className="ai-tag">IA</span>}
              <input type="number" value={f.wind} onChange={(e) => setF({ ...f, wind: e.target.value })} /></label>
            <label>Nível
              <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Exclude<SpecLevel, 'any'> })}>
                <option value="affordable">Affordable</option><option value="essential">Essential</option><option value="signature">Signature</option><option value="luxury">Luxury</option>
              </select></label>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Programa do projeto
              <span className="muted small" style={{ fontWeight: 400 }}> — o que faz o custo variar além da área</span></h2>
            <p className="muted small">Cozinhas, banheiros e aberturas são custo <strong>por contagem</strong> (não por sf). O motor
              escala cada categoria pelo driver certo — por isso uma 2ª cozinha ou um banheiro a mais entram no orçamento
              de verdade. Confira os números que a IA leu.</p>
            <div className="form-grid prog-grid">
              <ProgNum label="Quartos" k="bedrooms" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Banheiros (full)" k="full_baths" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Lavabos (½)" k="half_baths" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Cozinhas" k="kitchens" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Lavanderias" k="laundries" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Vagas de garagem" k="garage_bays" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Pavimentos" k="stories" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Portas (total)" k="doors" prog={prog} setProg={setProg} ai={aiFilled} />
              <ProgNum label="Janelas (total)" k="windows" prog={prog} setProg={setProg} ai={aiFilled} />
              <label className="checkbox">
                <input type="checkbox" checked={prog.has_inlaw}
                  onChange={(e) => setProg({ ...prog, has_inlaw: e.target.checked })} />
                Suíte in-law {aiFilled.has('has_inlaw') && <span className="ai-tag">IA</span>}
              </label>
            </div>
          </div>

          <div className="row-actions">
            <button className="btn primary" disabled={!f.name || !f.living || !f.total} onClick={() => setStep(2)}>
              Continuar
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="method-cards">
            <button className={`card method ${method === 'model' ? 'sel' : ''}`} onClick={() => setMethod('model')}>
              <h2>A partir de modelo-base</h2>
              <p className="muted small">Escala os custos de um modelo de referência pela área. Rápido, funciona agora. Cada linha sai marcada para revisão.</p>
            </button>
            <button className={`card method ${method === 'ai' ? 'sel' : ''}`} onClick={() => setMethod('ai')}>
              <h2>Take-off por IA (plantas)</h2>
              <p className="muted small">A IA lê o PDF das plantas e extrai quantidades por categoria do WBS. Exige a Edge Function com a chave da Claude API.</p>
            </button>
            <button className={`card method ${method === 'market' ? 'sel' : ''}`} onClick={() => setMethod('market')}>
              <h2>Estimar por IA (mercado + histórico)</h2>
              <p className="muted small">Sem modelo de referência: a IA usa seu histórico interno de preços + o mercado da Flórida
                e monta o orçamento completo, ajustado ao nível e ao programa. Cada linha marcada pela origem.</p>
            </button>
          </div>

          {method === 'model' && (
            <div className="card form-grid">
              <label className="span-all">Modelo de referência
                <select value={refId} onChange={(e) => setRefId(e.target.value)}>
                  {refs.length === 0 && <option value="">Nenhum orçamento de referência ainda</option>}
                  {refs.map((r) => <option key={r.estimate_id} value={r.estimate_id}>
                    {r.label} {r.living ? `(${number(r.living)} sf living)` : ''}
                  </option>)}
                </select>
              </label>
            </div>
          )}

          <div className="row-actions">
            <button className="btn" onClick={() => setStep(1)}>Voltar</button>
            {method === 'model' && (
              <button className="btn primary" disabled={busy || !refId} onClick={generateFromModel}>{busy ? 'Gerando…' : 'Gerar estimativa'}</button>
            )}
            {method === 'ai' && (
              <button className="btn primary" disabled={busy} onClick={generateFromAI}>{busy ? 'Processando plantas…' : 'Rodar take-off por IA'}</button>
            )}
            {method === 'market' && (
              <button className="btn primary" disabled={busy} onClick={generateFromMarket}>{busy ? 'Estimando…' : 'Estimar por IA'}</button>
            )}
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="totals">
            <div><div className="k muted small">Total estimado</div><div className="v accent">{money(total)}</div></div>
            <div><div className="k muted small">$/sf (total)</div><div className="v">{psf(total, target.total_sf)}</div></div>
            <div><div className="k muted small">$/sf (living)</div><div className="v">{psf(total, target.living_sf)}</div></div>
            <div><div className="k muted small">Linhas</div><div className="v">{lines.length}</div></div>
          </div>
          <p className="muted small">Todas as linhas estão marcadas ⚠️ para revisão. Ajuste o custo unitário onde precisar antes de salvar.</p>

          <div className="tablewrap">
            <table className="table estimate">
              <thead><tr><th>COD</th><th>Item</th><th className="num">Qtd</th><th>Un</th><th>Driver</th><th className="num">Custo Un.</th><th className="num">Total</th></tr></thead>
              <tbody>
                {cats.map((cat) => {
                  const its = lines.map((l, i) => ({ l, i })).filter(({ l }) => (l.line_code ?? l.wbs_code).split('.')[0] === cat);
                  const sub = its.reduce((s, { l }) => s + l.line_total, 0);
                  return (
                    <Fragment key={`c${cat}`}>
                      <tr className="cat-row">
                        <td>{cat}</td><td>{catName[cat] ?? ''}</td><td colSpan={3}></td>
                        <td className="num muted small">Sub-total {cat}</td><td className="num"><strong>{money(sub)}</strong></td>
                      </tr>
                      {its.map(({ l, i }) => (
                        <tr key={l.line_code ?? `${l.wbs_code}-${i}`}>
                          <td className="mono">{l.line_code ?? l.wbs_code}</td>
                          <td>{l.description}<span className="tag warn">⚠ revisar</span></td>
                          <td className="num">{number(l.qty)}</td>
                          <td>{UNIT_LABEL[l.unit] ?? l.unit}</td>
                          <td><span className={`basis ${l.basis}`}>{l.basis}</span></td>
                          <td className="num"><input className="cost-input" type="number" step="0.01" value={l.unit_cost}
                            onChange={(e) => editCost(i, e.target.value)} /></td>
                          <td className="num">{money(l.line_total)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="row-actions" style={{ marginTop: '1rem' }}>
            <button className="btn" onClick={() => setStep(2)}>Voltar</button>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar orçamento'}</button>
          </div>
        </>
      )}
    </div>
  );
}

type ProgNumKey = Exclude<keyof Program, 'has_inlaw'>;
function ProgNum(
  { label, k, prog, setProg, ai }:
  { label: string; k: ProgNumKey; prog: Program; setProg: (p: Program) => void; ai: Set<string> },
) {
  return (
    <label>{label} {ai.has(k) && <span className="ai-tag">IA</span>}
      <input type="number" min={0} value={prog[k]}
        onChange={(e) => setProg({ ...prog, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
    </label>
  );
}
