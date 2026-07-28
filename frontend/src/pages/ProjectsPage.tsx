import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Project, SpecLevel } from '../lib/database.types';
import { SPEC_LEVEL_LABEL, number } from '../lib/format';

export function ProjectsPage() {
  const { activeOrg } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    if (!activeOrg) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('org_id', activeOrg.id)
      .order('created_at', { ascending: false });
    if (error) setErr(error.message);
    else setProjects(data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeOrg?.id]);

  return (
    <div>
      <header className="page-head">
        <h1>Projetos</h1>
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancelar' : 'Novo projeto'}
        </button>
      </header>

      {creating && <NewProjectForm orgId={activeOrg!.id} onDone={() => { setCreating(false); load(); }} />}

      {err && <p className="error">{err}</p>}
      {loading ? <p className="muted">Carregando…</p> : (
        <table className="table">
          <thead>
            <tr>
              <th>Projeto</th><th>Modelo</th><th>Condado</th><th>Nível</th>
              <th className="num">Living (sf)</th><th className="num">Total (sf)</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr><td colSpan={6} className="muted center">Nenhum projeto ainda.</td></tr>
            )}
            {projects.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/projetos/${p.id}`}>{p.name}</Link></td>
                <td>{p.base_model ?? '—'}</td>
                <td>{p.county ?? '—'}</td>
                <td>{p.initial_level ? SPEC_LEVEL_LABEL[p.initial_level] : '—'}</td>
                <td className="num">{number(p.living_area_sf)}</td>
                <td className="num">{number(p.total_area_sf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewProjectForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [county, setCounty] = useState('');
  const [living, setLiving] = useState('');
  const [total, setTotal] = useState('');
  const [level, setLevel] = useState<SpecLevel>('essential');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase.from('projects').insert({
      org_id: orgId,
      name,
      base_model: model || null,
      county: county || null,
      living_area_sf: living ? Number(living) : null,
      total_area_sf: total ? Number(total) : null,
      initial_level: level,
    });
    if (error) { setErr(error.message); setBusy(false); }
    else onDone();
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label>Nome<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Modelo-base<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <label>Condado<input value={county} onChange={(e) => setCounty(e.target.value)} /></label>
      <label>Living Area (sf)<input type="number" step="0.01" value={living} onChange={(e) => setLiving(e.target.value)} /></label>
      <label>Total Area (sf)<input type="number" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} /></label>
      <label>Nível inicial
        <select value={level} onChange={(e) => setLevel(e.target.value as SpecLevel)}>
          <option value="essential">Essential</option>
          <option value="signature">Signature</option>
          <option value="luxury">Luxury</option>
        </select>
      </label>
      {err && <p className="error span-all">{err}</p>}
      <div className="span-all"><button className="btn primary" disabled={busy}>Salvar projeto</button></div>
    </form>
  );
}
