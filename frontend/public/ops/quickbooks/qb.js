// Shared by /ops/quickbooks/ and /ops/quickbooks/disconnected/: sign-in, the owner check, and calls to
// the ops-qbo Edge Function (owners only — the Finance permission is checked in the database too).
(function () {
  const SB_URL = 'https://fvjknahpmihueyeasgbx.supabase.co', SB_KEY = 'sb_publishable_wr3657pmQAxZy2FEmLQ-RQ_pAPxEm7J';
  const sb = window.supabase.createClient(SB_URL, SB_KEY);
  const $ = (id) => document.getElementById(id);
  const QB = {
    sb, $,
    esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    msg(t, err) { $('msg').textContent = t; $('msg').className = err ? 'err' : ''; },
    async fn(body) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error('signed out');
      const r = await fetch(SB_URL + '/functions/v1/ops-qbo', { method: 'POST', headers: { 'content-type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      return j;
    },
    // Resolves with the owner (ops_me) once signed in; shows the sign-in form until then.
    async owner() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        QB.msg('Sign in with your PKB account.'); $('login').hidden = false;
        await new Promise((res) => { $('login').onsubmit = async (e) => {
          e.preventDefault(); $('lbtn').disabled = true; QB.msg('Signing in…');
          const { error } = await sb.auth.signInWithPassword({ email: $('lemail').value.trim(), password: $('lpass').value });
          $('lbtn').disabled = false;
          if (error) QB.msg(error.message, true); else { $('login').hidden = true; res(); }
        }; });
      }
      const { data: me } = await sb.rpc('ops_me');
      if (!me) { QB.msg('This account has no access to PKB Ops.', true); return null; }
      if (!me.finance) { QB.msg(`QuickBooks is limited to the owners (signed in as ${me.email}).`, true); return null; }
      return me;
    },
  };
  window.QB = QB;
})();
