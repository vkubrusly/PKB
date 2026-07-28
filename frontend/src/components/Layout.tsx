import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Logo } from './Logo';

const NAV = [
  { to: '/novo', label: '＋ Novo orçamento' },
  { to: '/projetos', label: 'Projetos' },
  { to: '/materiais', label: 'Materiais' },
  { to: '/fornecedores', label: 'Fornecedores' },
  { to: '/niveis', label: 'Níveis' },
];

export function Layout() {
  const { session, orgs, activeOrg, setActiveOrg, signOut } = useAuth();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand small">
          <Logo size={30} stacked={false} />
          <strong>Orçamentos</strong>
        </div>

        {orgs.length > 1 ? (
          <select className="org-switch" value={activeOrg?.id ?? ''}
            onChange={(e) => {
              const o = orgs.find((x) => x.id === e.target.value);
              if (o) setActiveOrg(o);
            }}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : (
          <div className="org-name">{activeOrg?.name}</div>
        )}

        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="muted small">{session?.user.email}</span>
          <button className="link" onClick={() => signOut()}>Sair</button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
