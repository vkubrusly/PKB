import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Org } from '../lib/database.types';

interface AuthState {
  session: Session | null;
  loading: boolean;
  orgs: Org[];
  activeOrg: Org | null;
  setActiveOrg: (org: Org) => void;
  reloadOrgs: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrgState] = useState<Org | null>(null);

  async function loadOrgs(currentSession: Session | null) {
    if (!currentSession) {
      setOrgs([]);
      setActiveOrgState(null);
      return;
    }
    // org_members RLS lets a user read their own memberships; join to orgs.
    const { data, error } = await supabase
      .from('org_members')
      .select('orgs(id, name, created_at)')
      .order('created_at', { referencedTable: 'orgs', ascending: true });
    if (error) {
      console.error('Falha ao carregar orgs:', error.message);
      setOrgs([]);
      return;
    }
    const list = (data ?? [])
      .map((row: { orgs: Org | Org[] | null }) => (Array.isArray(row.orgs) ? row.orgs[0] : row.orgs))
      .filter((o): o is Org => !!o);
    setOrgs(list);
    setActiveOrgState((prev) => list.find((o) => o.id === prev?.id) ?? list[0] ?? null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadOrgs(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      await loadOrgs(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session,
    loading,
    orgs,
    activeOrg,
    setActiveOrg: setActiveOrgState,
    reloadOrgs: () => loadOrgs(session),
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
