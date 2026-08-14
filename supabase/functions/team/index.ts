// =============================================================================
// team — manage org membership (share the workspace with teammates).
//   action "list": return the org's members (email + role).
//   action "add":  add a teammate by email to the caller's org. If the email
//                  already has an account, they're linked immediately; if not,
//                  they're invited by email. Caller must be owner/admin.
//
// Body: { action: 'list' | 'add', org_id, email?, role?, redirect? }
// Env:  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy team
// =============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const svcKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Identify the caller from their JWT.
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json({ error: 'Não autenticado.' }, 401);

    const { action, org_id, email, role, redirect } = await req.json();
    if (!org_id) return json({ error: 'org_id é obrigatório.' }, 400);

    const svc = createClient(url, svcKey);

    // Caller must belong to the org (any role to list; owner/admin to add).
    const { data: mem } = await svc.from('org_members')
      .select('role').eq('org_id', org_id).eq('user_id', user.id).maybeSingle();
    if (!mem) return json({ error: 'Você não pertence a esta organização.' }, 403);

    // Helper: map user_ids → emails via the admin API (small teams: a page or two).
    async function emailsById(ids: string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (let page = 1; page <= 10 && ids.some((id) => !out[id]); page++) {
        const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
        if (error || !data?.users?.length) break;
        for (const u of data.users) if (u.id && u.email) out[u.id] = u.email;
        if (data.users.length < 200) break;
      }
      return out;
    }

    if (action === 'list') {
      const { data: members } = await svc.from('org_members')
        .select('user_id, role, created_at').eq('org_id', org_id).order('created_at');
      const map = await emailsById((members ?? []).map((m) => m.user_id));
      return json({
        members: (members ?? []).map((m) => ({
          user_id: m.user_id, role: m.role, email: map[m.user_id] ?? '(sem e-mail)',
          is_you: m.user_id === user.id,
        })),
      });
    }

    if (action === 'add') {
      if (!['owner', 'admin'].includes(mem.role)) return json({ error: 'Apenas owner/admin pode adicionar membros.' }, 403);
      const target = String(email ?? '').trim().toLowerCase();
      if (!target || !target.includes('@')) return json({ error: 'E-mail inválido.' }, 400);
      const newRole = role === 'admin' ? 'admin' : 'member';

      // Find an existing account for this email.
      let targetId: string | null = null;
      for (let page = 1; page <= 10 && !targetId; page++) {
        const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
        if (error || !data?.users?.length) break;
        const hit = data.users.find((u) => u.email?.toLowerCase() === target);
        if (hit) targetId = hit.id;
        if (data.users.length < 200) break;
      }

      let invited = false;
      if (!targetId) {
        // No account yet → send an invite email (creates the user).
        const { data: inv, error: iErr } = await svc.auth.admin.inviteUserByEmail(
          target, redirect ? { redirectTo: String(redirect) } : undefined,
        );
        if (iErr || !inv?.user) return json({ error: `Não foi possível convidar: ${iErr?.message ?? 'erro'}` }, 400);
        targetId = inv.user.id;
        invited = true;
      }

      const { error: insErr } = await svc.from('org_members')
        .upsert({ org_id, user_id: targetId, role: newRole }, { onConflict: 'org_id,user_id' });
      if (insErr) return json({ error: insErr.message }, 400);

      return json({ ok: true, invited, role: newRole, email: target });
    }

    return json({ error: 'action inválida (use "list" ou "add").' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
