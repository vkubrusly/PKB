import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import type { Supplier } from '../lib/database.types';

const empty = { name: '', contact_name: '', email: '', phone: '', website: '', is_preferred: false };
type Draft = typeof empty;

export function SuppliersPage() {
  const { activeOrg } = useAuth();
  const [rows, setRows] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);

  async function load() {
    if (!activeOrg) return;
    setLoading(true);
    const { data, error } = await supabase.from('suppliers')
      .select('*').eq('org_id', activeOrg.id).order('name');
    if (error) setErr(error.message); else setRows(data ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeOrg?.id]);

  function startNew() { setDraft(empty); setEditing('new'); }
  function startEdit(s: Supplier) {
    setDraft({
      name: s.name, contact_name: s.contact_name ?? '', email: s.email ?? '',
      phone: s.phone ?? '', website: s.website ?? '', is_preferred: s.is_preferred,
    });
    setEditing(s.id);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const payload = {
      org_id: activeOrg!.id,
      name: draft.name,
      contact_name: draft.contact_name || null,
      email: draft.email || null,
      phone: draft.phone || null,
      website: draft.website || null,
      is_preferred: draft.is_preferred,
    };
    const res = editing === 'new'
      ? await supabase.from('suppliers').insert(payload)
      : await supabase.from('suppliers').update(payload).eq('id', editing!);
    if (res.error) setErr(res.error.message);
    else { setEditing(null); load(); }
  }

  async function remove(id: string) {
    if (!confirm('Excluir este fornecedor?')) return;
    const { error } = await supabase.from('suppliers').delete().eq('id', id);
    if (error) setErr(error.message); else load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>Fornecedores</h1>
        <button className="btn primary" onClick={startNew}>Novo fornecedor</button>
      </header>

      {editing && (
        <form className="card form-grid" onSubmit={save}>
          <label>Nome<input value={draft.name} required
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Contato<input value={draft.contact_name}
            onChange={(e) => setDraft({ ...draft, contact_name: e.target.value })} /></label>
          <label>E-mail<input type="email" value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></label>
          <label>Telefone<input value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></label>
          <label>Website<input value={draft.website}
            onChange={(e) => setDraft({ ...draft, website: e.target.value })} /></label>
          <label className="checkbox"><input type="checkbox" checked={draft.is_preferred}
            onChange={(e) => setDraft({ ...draft, is_preferred: e.target.checked })} /> Preferencial</label>
          {err && <p className="error span-all">{err}</p>}
          <div className="span-all row-actions">
            <button className="btn primary" type="submit">Salvar</button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {loading ? <p className="muted">Carregando…</p> : (
        <table className="table">
          <thead><tr><th>Nome</th><th>Contato</th><th>E-mail</th><th>Telefone</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="muted center">Nenhum fornecedor.</td></tr>}
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.name} {s.is_preferred && <span className="tag">preferencial</span>}</td>
                <td>{s.contact_name ?? '—'}</td>
                <td>{s.email ?? '—'}</td>
                <td>{s.phone ?? '—'}</td>
                <td className="row-actions">
                  <button className="link" onClick={() => startEdit(s)}>Editar</button>
                  <button className="link danger" onClick={() => remove(s.id)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
