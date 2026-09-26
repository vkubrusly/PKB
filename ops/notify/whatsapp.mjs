// =============================================================================
// whatsapp.mjs — WhatsApp channel through Meta's official WhatsApp Cloud API.
//
// Why the official API: no third-party relay, no risk of the number being
// banned (unofficial "WhatsApp Web" bots get numbers blocked), and it is free
// for the first 1,000 service conversations/month.
//
// WhatsApp rule that shapes this module: a business can only start a
// conversation with an APPROVED TEMPLATE. Free text is allowed only inside the
// 24 h window after the person last wrote to the number. So every alert type
// maps to a template registered in Meta Business Manager (see TEMPLATES below);
// sendText() is used only for replies inside that window.
//
// Setup (one time, by PKB):
//   1. business.facebook.com → WhatsApp Manager → add a phone number for PKB Ops
//      (a new number, not someone's personal WhatsApp).
//   2. Create a System User with a permanent token (whatsapp_business_messaging).
//   3. Submit the templates below for approval (category UTILITY, language pt_BR).
//   4. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.
// Until WHATSAPP_TOKEN is set, every call is a dry run that only logs.
// =============================================================================

const GRAPH = 'https://graph.facebook.com/v21.0';

// Template name → the ordered body parameters it expects. Keep these in sync
// with what is approved in WhatsApp Manager.
export const TEMPLATES = {
  // "Inspeção {{1}} REPROVADA na casa {{2}}. Inspetor: {{3}}. Comentário: {{4}}"
  inspection_failed: ['inspection', 'job', 'inspector', 'comment'],
  // "Inspeção {{1}} APROVADA na casa {{2}}. Próximo passo: {{3}}"
  inspection_passed: ['inspection', 'job', 'next_step'],
  // "Permit {{1}} ({{2}}): o condado pediu correções em {{3}}. E-mail enviado à Sovereign."
  permit_corrections: ['permit', 'job', 'departments'],
  // "Permit {{1}} ({{2}}) foi EMITIDO."
  permit_issued: ['permit', 'job'],
  // "Atenção: hold no permit {{1}} ({{2}}): {{3}}"
  permit_hold: ['permit', 'job', 'reason'],
  // "{{1}} item(s) aguardando ação no PKB Ops: {{2}}"
  daily_digest: ['count', 'summary'],
};

const env = () => ({
  token: process.env.WHATSAPP_TOKEN,
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  lang: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
});

// E.164 without '+', as the Cloud API expects ("14073041234").
export function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  const n = digits.length === 10 ? '1' + digits : digits; // US number without country code
  if (n.length < 11 || n.length > 15) throw new Error(`invalid WhatsApp number "${p}"`);
  return n;
}

async function post(body) {
  const { token, phoneId } = env();
  if (!token || !phoneId) {
    console.log('[whatsapp dry-run]', JSON.stringify(body));
    return { dryRun: true };
  }
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  return { id: json?.messages?.[0]?.id, raw: json };
}

export async function sendTemplate(to, template, params) {
  const keys = TEMPLATES[template];
  if (!keys) throw new Error(`unknown WhatsApp template "${template}"`);
  const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || '-';
  return post({
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'template',
    template: {
      name: template,
      language: { code: env().lang },
      components: [{ type: 'body', parameters: keys.map(k => ({ type: 'text', text: text(params[k]) })) }],
    },
  });
}

// Only valid inside the 24 h customer-service window.
export async function sendText(to, body) {
  return post({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: String(body).slice(0, 4096) } });
}
