import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Fail loud in dev: the app cannot talk to any data without these.
  console.error(
    'Faltam VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copie frontend/.env.example para .env.local.',
  );
}

export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-anon-key');

export const DEMO_ORG_ID =
  (import.meta.env.VITE_DEMO_ORG_ID as string | undefined) ??
  '11111111-1111-1111-1111-111111111111';
