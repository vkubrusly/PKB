import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { SpecLevelRow } from '../lib/database.types';
import { SPEC_LEVEL_LABEL, money } from '../lib/format';

const DEFAULTS: { level: 'affordable' | 'essential' | 'signature' | 'luxury'; low: number; high: number; desc: string }[] = [
  { level: 'affordable', low: 105, high: 135, desc: 'Affordable / habitação acessível (ex.: Sunny)' },
  { level: 'essential', low: 165, high: 180, desc: 'Entrada / investidor / aluguel' },
  { level: 'signature', low: 200, high: 225, desc: 'Padrão PKB / cliente final' },
  { level: 'luxury', low: 245, high: 280, desc: 'Alto padrão / custom' },
];

export function SpecLevelsPage() {
  const { activeOrg } = useAuth();
  const [rows, setRows] = useState<SpecLevelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!activeOrg) return;
    setLoading(true);
    const { data, error } = await supabase.from('spec_levels')
      .select('*').eq('org_id', activeOrg.id).is('base_model', null).is('county', null).order('level');
    if (error) setErr(error.message); else setRows(data ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeOrg?.id]);

  async function seedDefaults() {
    setBusy(true); setErr(null);
    const payload = DEFAULTS.map((d) => ({
      org_id: activeOrg!.id, level: d.level,
      target_psf_low: d.low, target_psf_high: d.high, description: d.desc,
    }));
    const { error } = await supabase.from('spec_levels')
      .upsert(payload, { onConflict: 'org_id,level,base_model,county' });
    if (error) setErr(error.message); else load();
    setBusy(false);
  }

  async function updateRow(id: string, patch: Partial<SpecLevelRow>) {
    const { error } = await supabase.from('spec_levels').update(patch).eq('id', id);
    if (error) setErr(error.message); else load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>Níveis de especificação</h1>
        {rows.length === 0 && (
          <button className="btn primary" disabled={busy} onClick={seedDefaults}>
            Criar níveis padrão PKB
          </button>
        )}
      </header>

      <p className="muted">Faixas de $/sf alvo por nível (Tabela §1.2). Calibradas automaticamente na Fase 2.</p>
      {err && <p className="error">{err}</p>}

      {loading ? <p className="muted">Carregando…</p> : (
        <div className="level-cards">
          {rows.length === 0 && <p className="muted">Nenhum nível definido ainda.</p>}
          {rows.map((r) => (
            <div key={r.id} className={`card level-card ${r.level}`}>
              <h2>{SPEC_LEVEL_LABEL[r.level]}</h2>
              <p className="muted small">{r.description}</p>
              <div className="range">
                <label>De $/sf
                  <input type="number" step="0.01" defaultValue={r.target_psf_low ?? ''}
                    onBlur={(e) => updateRow(r.id, { target_psf_low: e.target.value ? Number(e.target.value) : null })} />
                </label>
                <label>Até $/sf
                  <input type="number" step="0.01" defaultValue={r.target_psf_high ?? ''}
                    onBlur={(e) => updateRow(r.id, { target_psf_high: e.target.value ? Number(e.target.value) : null })} />
                </label>
              </div>
              <p className="range-preview">
                {money(r.target_psf_low)} – {money(r.target_psf_high)} <span className="muted small">/sf</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
