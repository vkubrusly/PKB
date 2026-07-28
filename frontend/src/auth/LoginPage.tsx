import { useState } from 'react';
import { supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup';

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg('Conta criada. Se a confirmação por e-mail estiver ligada, verifique sua caixa.');
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Erro ao autenticar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">PKB</span>
          <div>
            <h1>Orçamentos</h1>
            <p className="muted">Prime Kubrusly Basso Homes</p>
          </div>
        </div>

        <label>
          E-mail
          <input type="email" value={email} required autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Senha
          <input type="password" value={password} required minLength={6}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)} />
        </label>

        {err && <p className="error">{err}</p>}
        {msg && <p className="success">{msg}</p>}

        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Aguarde…' : mode === 'signin' ? 'Entrar' : 'Criar conta'}
        </button>

        <p className="muted center">
          {mode === 'signin' ? 'Não tem conta?' : 'Já tem conta?'}{' '}
          <button type="button" className="link"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setErr(null); setMsg(null); }}>
            {mode === 'signin' ? 'Criar conta' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
  );
}
