import { createClient } from '@supabase/supabase-js';

// Production defaults (PUBLIC values — the publishable key is protected by RLS
// and is designed to ship in the client bundle). Env vars override them for
// local dev (copy .env.example → .env.local pointing at a local Supabase).
const PROD_URL = 'https://fvjknahpmihueyeasgbx.supabase.co';
const PROD_ANON_KEY = 'sb_publishable_wr3657pmQAxZy2FEmLQ-RQ_pAPxEm7J';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || PROD_URL;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || PROD_ANON_KEY;

export const supabase = createClient(url, anonKey);

export const DEMO_ORG_ID =
  (import.meta.env.VITE_DEMO_ORG_ID as string | undefined) ??
  '11111111-1111-1111-1111-111111111111';
