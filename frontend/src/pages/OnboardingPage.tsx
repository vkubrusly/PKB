import { useState } from 'react';
import { supabase, DEMO_ORG_ID } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

// Shown when the logged-in user belongs to no org yet. Two paths:
//  - create a brand new org (becomes owner)
//  - join the seeded demo org (Sunny) to explore real data
export function OnboardingPage() {
  const { reloadOrgs, signOut } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc('create_org', { p_name: name });
    if (error) setErr(error.message);
    else await reloadOrgs();
    setBusy(false);
  }

  async function joinDemo() {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc('join_org', { p_org_id: DEMO_ORG_ID });
    if (error) setErr(error.message);
    else await reloadOrgs();
    setBusy(false);
  }

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <h1>Bem-vindo</h1>
        <p className="muted">Você ainda não faz parte de uma organização.</p>

        <form onSubmit={createOrg}>
          <label>
            Nome da organização
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="PKB Homes" required />
          </label>
          <button className="btn primary" disabled={busy} type="submit">Criar organização</button>
        </form>

        <div className="divider"><span>ou</span></div>

        <button className="btn" disabled={busy} onClick={joinDemo}>
          Entrar na organização demo (Sunny)
        </button>

        {err && <p className="error">{err}</p>}
        <p className="muted center">
          <button className="link" onClick={() => signOut()}>Sair</button>
        </p>
      </div>
    </div>
  );
}
