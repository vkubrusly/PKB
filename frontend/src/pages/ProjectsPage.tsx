import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Project } from '../lib/database.types';
import { SPEC_LEVEL_LABEL, number } from '../lib/format';

export function ProjectsPage() {
  const { activeOrg } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrg) return;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('projects').select('*').eq('org_id', activeOrg.id)
        .order('created_at', { ascending: false });
      if (error) setErr(error.message); else setProjects(data ?? []);
      setLoading(false);
    })();
  }, [activeOrg?.id]);

  return (
    <div>
      <header className="page-head">
        <h1>Projetos</h1>
        <Link className="btn primary" to="/novo">＋ Novo orçamento</Link>
      </header>

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
              <tr><td colSpan={6} className="muted center">Nenhum projeto ainda. Comece por “Novo orçamento”.</td></tr>
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
