import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

interface Member { user_id: string; role: string; email: string; is_you: boolean; }

// Share the workspace: everyone in the same org sees the same projects,
// estimates, materials and suppliers. Owner/admin can add teammates by e-mail.
export function EquipePage() {
  const { activeOrg } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(action: 'list' | 'add', body: Record<string, unknown> = {}) {
    const { data, error } = await supabase.functions.invoke('team', {
      body: { action, org_id: activeOrg!.id, ...body },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      let m = error.message;
      if (ctx && typeof ctx.json === 'function') { try { const b = await ctx.json(); if (b?.error) m = b.error; } catch { /* */ } }
      throw new Error(m);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function load() {
    if (!activeOrg) return;
    setLoading(true); setErr(null);
    try { setMembers((await call('list')).members ?? []); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeOrg?.id]);

  const myRole = members.find((m) => m.is_you)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';

  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await call('add', { email: email.trim(), role, password: password.trim() || undefined, redirect: window.location.origin });
      setMsg(r.password_set
        ? `${r.email} pronto: senha definida. Já pode entrar (e-mail + senha) e vê os mesmos dados.`
        : r.invited
          ? `Convite enviado para ${r.email}. Ele recebe um e-mail para criar a senha e já entra na sua organização.`
          : `${r.email} foi adicionado à organização (${r.role}). Ele já vê os mesmos dados no próximo login.`);
      setEmail(''); setPassword('');
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <header className="page-head"><h1>Equipe — {activeOrg?.name}</h1></header>
      <p className="muted">Todos na mesma organização compartilham os <strong>mesmos projetos, orçamentos, materiais e fornecedores</strong>.</p>

      {canManage && (
        <form className="card form-grid" onSubmit={add}>
          <label className="span-all" style={{ maxWidth: 420 }}>E-mail do convidado
            <input type="email" required placeholder="carlos@pkbhomes.com"
              value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label style={{ maxWidth: 240 }}>Senha (opcional — cria a conta na hora)
            <input type="text" placeholder="deixe vazio p/ enviar convite" autoComplete="off"
              value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label style={{ maxWidth: 220 }}>Papel
            <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
              <option value="member">Member (usa o sistema)</option>
              <option value="admin">Admin (também gerencia a equipe)</option>
            </select></label>
          <div className="span-all row-actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Adicionando…' : 'Adicionar à organização'}</button>
          </div>
          {msg && <p className="success span-all">{msg}</p>}
          {err && <p className="error span-all">{err}</p>}
        </form>
      )}
      {!canManage && err && <p className="error">{err}</p>}

      {loading ? <p className="muted">Carregando…</p> : (
        <table className="table">
          <thead><tr><th>E-mail</th><th>Papel</th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={2} className="muted center">Nenhum membro.</td></tr>}
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.email}{m.is_you && <span className="tag">você</span>}</td>
                <td>{m.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
