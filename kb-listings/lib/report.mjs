// Weekly listing report: metrics for one listing and one week, rendered as an HTML e-mail and a
// WhatsApp text (PT or EN). Pure functions — the runner is reports/weekly_report.mjs.
import { weekMarket } from './market.mjs';

const TZ = 'America/New_York';
export const nyDate = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }) : null);
export const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function lastWeek() {
  const today = nyDate(new Date());
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -((dow + 6) % 7) - 7);
}

const T = {
  pt: {
    subject: (a, f) => `Relatório semanal — ${a} (semana de ${f})`, week: 'Semana', showings: 'Visitas (showings)', requests: 'Pedidos de visita',
    cancelled: 'Canceladas', vsPrev: 'semana anterior', toDate: 'desde o início', dom: 'Dias no mercado', price: 'Preço atual',
    feedback: 'Feedback dos compradores', noFeedback: 'Nenhum feedback recebido nesta semana.', interest: { high: 'alto interesse', medium: 'interesse médio', low: 'pouco interesse', none: 'sem interesse' },
    priceView: { high: 'achou o preço alto', fair: 'achou o preço justo', below: 'achou o preço bom' }, offers: 'Possíveis ofertas',
    market: 'Mercado na região', pendingWeek: 'Entraram em contrato (pending)', soldWeek: 'Vendidas', active: 'À venda agora', moi: 'Meses de estoque',
    ppsf: 'Preço/sf', yours: 'Seu imóvel', similar: 'Vendidas semelhantes (90 dias)', changes: 'Mudanças no anúncio', none: '—',
    status: { coming_soon: 'Em breve', active: 'Ativo', pending: 'Em contrato', sold: 'Vendido', withdrawn: 'Retirado', expired: 'Expirado' },
    note: 'Comentário', hello: (n) => `Olá${n ? `, ${n}` : ''}!`, bye: 'Qualquer dúvida, estou à disposição.', noData: 'Sem dados do MLS para esta área nesta semana.',
  },
  en: {
    subject: (a, f) => `Weekly report — ${a} (week of ${f})`, week: 'Week', showings: 'Showings', requests: 'Showing requests',
    cancelled: 'Cancelled', vsPrev: 'previous week', toDate: 'to date', dom: 'Days on market', price: 'Current price',
    feedback: 'Buyer feedback', noFeedback: 'No feedback received this week.', interest: { high: 'high interest', medium: 'some interest', low: 'low interest', none: 'not interested' },
    priceView: { high: 'felt the price is high', fair: 'felt the price is fair', below: 'felt the price is good' }, offers: 'Possible offers',
    market: 'Local market', pendingWeek: 'Went pending', soldWeek: 'Sold', active: 'For sale now', moi: 'Months of inventory',
    ppsf: 'Price/sf', yours: 'Your home', similar: 'Similar homes sold (90 days)', changes: 'Listing changes', none: '—',
    status: { coming_soon: 'Coming soon', active: 'Active', pending: 'Pending', sold: 'Sold', withdrawn: 'Withdrawn', expired: 'Expired' },
    note: 'Comment', hello: (n) => `Hi${n ? ` ${n}` : ''}!`, bye: 'Let me know if you have any questions.', noData: 'No MLS data for this area this week.',
  },
};
const money = (n) => (n == null ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtDay = (s, lang) => new Date(`${s}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-US' : 'pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export function buildMetrics(l, showings, history, comps, from) {
  const to = addDays(from, 7), prevFrom = addDays(from, -7);
  const inWeek = (d, a = from, b = to) => { const x = nyDate(d); return !!x && x >= a && x < b; };
  const mine = showings.filter((s) => s.listing_id === l.id);
  const done = (a, b) => mine.filter((s) => inWeek(s.starts_at, a, b) && !['cancelled', 'declined'].includes(s.status));
  const fb = mine.filter((s) => inWeek(s.feedback_received_at) && s.feedback_text);
  const ppsf = l.list_price && l.sqft ? Math.round(l.list_price / l.sqft) : null;
  const market = weekMarket(l, comps, from, to);
  return {
    address: l.address, status: l.status, list_price: l.list_price, list_ppsf: ppsf,
    dom: l.listed_at ? Math.max(0, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${String(l.listed_at).slice(0, 10)}T00:00:00Z`)) / 864e5)) : null,
    showings_week: done(from, to).length, showings_prev_week: done(prevFrom, from).length,
    showings_to_date: mine.filter((s) => !['cancelled', 'declined'].includes(s.status) && s.starts_at && nyDate(s.starts_at) < to).length,
    requests_week: mine.filter((s) => inWeek(s.requested_at || s.created_at)).length,
    cancelled_week: mine.filter((s) => ['cancelled', 'declined'].includes(s.status) && inWeek(s.updated_at)).length,
    feedback: fb.map((s) => ({ interest: s.feedback_interest, price_view: s.feedback_price_view, offer_expected: s.offer_expected,
      summary: (() => { try { return JSON.parse(s.feedback_summary || '{}'); } catch { return {}; } })() })),
    offers_expected: fb.filter((s) => s.offer_expected).length,
    changes: history.filter((h) => h.listing_id === l.id && inWeek(h.changed_at)).map((h) => ({ status: h.status, list_price: h.list_price, at: nyDate(h.changed_at) })),
    market, vs_similar_pct: ppsf && market.similar_median_ppsf ? Math.round((ppsf / market.similar_median_ppsf - 1) * 100) : null,
  };
}

// Brand (Kubrusly Basso Team): gold of the KB mark, graphite text. E-mail clients only show a
// logo from a public URL, so the header uses logoUrl when given and a text wordmark otherwise.
export const GOLD = '#E9BE4A', INK = '#3F3F41', MUTED = '#7A7A7E', LINE = '#ECE6D6';
function header(brand, logoUrl) {
  if (logoUrl) return `<img src="${esc(logoUrl)}" alt="${esc(brand)}" style="max-width:280px;height:auto;display:block;margin:0 0 4px">`;
  const [a, ...b] = String(brand).replace(/\s+team$/i, '').split(/\s+/);
  return `<div style="font-size:20px;letter-spacing:3px;color:${INK};font-weight:300">${esc(a.toUpperCase())} <span style="color:${GOLD};font-weight:700;letter-spacing:0">KB</span> ${esc(b.join(' ').toUpperCase())}${/team$/i.test(brand) ? `<span style="display:block;font-size:10px;letter-spacing:10px;font-weight:700;text-align:center;max-width:300px">TEAM</span>` : ''}</div>`;
}

export function render(l, m, narrative, from, { brand = 'Kubrusly Basso Team', agent = '', brokerage = '', logoUrl = '' } = {}) {
  const to = addDays(from, 7);
  const t = T[l.report_lang] || T.pt;
  const lang = l.report_lang;
  const subject = t.subject(l.address.split(',')[0], fmtDay(from, lang));
  const delta = m.showings_week - m.showings_prev_week;
  const kpi = (label, value, sub = '') => `<td style="padding:12px;border:1px solid ${LINE};border-top:3px solid ${GOLD};border-radius:8px;text-align:center;width:25%"><div style="font-size:24px;font-weight:700;color:${INK}">${esc(value)}</div><div style="font-size:12px;color:${MUTED}">${esc(label)}</div>${sub ? `<div style="font-size:11px;color:${MUTED}">${esc(sub)}</div>` : ''}</td>`;
  const fbLines = m.feedback.map((f) => `${[t.interest[f.interest], t.priceView[f.price_view]].filter(Boolean).join(' · ')}${f.summary?.[lang] ? ` — “${f.summary[lang]}”` : ''}`);
  const compRows = (rows) => rows.map((c) => `<tr><td style="padding:4px 8px">${esc(c.address)}</td><td style="padding:4px 8px">${c.beds ?? ''}/${c.baths ?? ''}</td><td style="padding:4px 8px">${c.sqft ? Math.round(c.sqft).toLocaleString('en-US') : ''}</td><td style="padding:4px 8px">${money(c.price)}</td><td style="padding:4px 8px">${c.ppsf ? `$${c.ppsf}` : ''}</td><td style="padding:4px 8px">${c.dom ?? ''}</td></tr>`).join('');
  const compTable = (title, rows) => (rows.length ? `<p style="margin:12px 0 4px;font-weight:600">${esc(title)} (${rows.length})</p><table style="border-collapse:collapse;font-size:13px;width:100%"><tr style="color:${MUTED};text-align:left"><th style="padding:4px 8px">${lang === 'en' ? 'Address' : 'Endereço'}</th><th style="padding:4px 8px">${lang === 'en' ? 'Bd/Ba' : 'Q/B'}</th><th style="padding:4px 8px">sf</th><th style="padding:4px 8px">$</th><th style="padding:4px 8px">$/sf</th><th style="padding:4px 8px">DOM</th></tr>${compRows(rows)}</table>` : '');
  const mk = m.market;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:${INK}">
${header(brand, logoUrl)}
<div style="height:2px;background:${GOLD};margin:8px 0 12px"></div>
<p style="font-size:12px;color:${MUTED};margin:0">${esc(t.week)} ${esc(fmtDay(from, lang))} – ${esc(fmtDay(addDays(to, -1), lang))}</p>
<h2 style="margin:4px 0 2px">${esc(l.address)}</h2>
<p style="margin:0 0 16px;color:#374151">${esc(t.status[m.status] || m.status)} · ${esc(t.price)} ${money(m.list_price)}${m.list_ppsf ? ` ($${m.list_ppsf}/sf)` : ''}${m.dom != null ? ` · ${esc(t.dom)}: ${m.dom}` : ''}</p>
<p>${esc(t.hello(l.seller_name?.split(' ')[0]))}</p>
${narrative ? `<p style="line-height:1.5">${esc(narrative)}</p>` : ''}
<table style="border-collapse:separate;border-spacing:6px;width:100%"><tr>
${kpi(t.showings, m.showings_week, `${delta >= 0 ? '+' : ''}${delta} vs ${t.vsPrev}`)}${kpi(t.requests, m.requests_week, `${m.cancelled_week} ${t.cancelled.toLowerCase()}`)}${kpi(t.toDate, m.showings_to_date, t.showings)}${kpi(t.offers, m.offers_expected)}
</tr></table>
<h3 style="margin:20px 0 6px;color:${INK};border-left:3px solid ${GOLD};padding-left:8px">${esc(t.feedback)}</h3>
${fbLines.length ? `<ul style="margin:0;padding-left:18px;line-height:1.5">${fbLines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p style="color:${MUTED}">${esc(t.noFeedback)}</p>`}
${m.changes.length ? `<h3 style="margin:20px 0 6px;color:${INK};border-left:3px solid ${GOLD};padding-left:8px">${esc(t.changes)}</h3><ul style="margin:0;padding-left:18px">${m.changes.map((c) => `<li>${esc(c.at)}: ${esc(t.status[c.status] || c.status)} · ${money(c.list_price)}</li>`).join('')}</ul>` : ''}
<h3 style="margin:20px 0 6px;color:${INK};border-left:3px solid ${GOLD};padding-left:8px">${esc(t.market)} — ${esc(mk.area)}</h3>
${mk.pending_week + mk.sold_week + mk.active_now === 0 ? `<p style="color:${MUTED}">${esc(t.noData)}</p>` : `
<table style="border-collapse:separate;border-spacing:6px;width:100%"><tr>
${kpi(t.pendingWeek, mk.pending_week)}${kpi(t.soldWeek, mk.sold_week)}${kpi(t.active, mk.active_now)}${kpi(t.moi, mk.months_of_inventory ?? '—')}
</tr></table>
<p style="font-size:14px">${esc(t.yours)}: ${m.list_ppsf ? `$${m.list_ppsf}/sf` : '—'} · ${esc(t.similar)}: ${mk.similar_median_ppsf ? `$${mk.similar_median_ppsf}/sf` : '—'} (${mk.similar_sold90})${m.vs_similar_pct != null ? ` → ${m.vs_similar_pct >= 0 ? '+' : ''}${m.vs_similar_pct}%` : ''}</p>
${compTable(t.pendingWeek, mk.pending_list)}${compTable(t.soldWeek, mk.sold_list)}`}
<p style="margin-top:20px">${esc(t.bye)}<br><strong>${esc(agent)}</strong> · ${esc(brand)}</p>
<div style="height:1px;background:${LINE};margin:16px 0 6px"></div>
<p style="font-size:11px;color:${MUTED};margin:0">${esc(brand)}${brokerage ? ` · <span style="color:${GOLD};font-weight:600">${esc(brokerage)}</span>` : ''}</p></div>`;

  const wa = [
    `*${l.address.split(',')[0]}* — ${t.week.toLowerCase()} ${fmtDay(from, lang)}–${fmtDay(addDays(to, -1), lang)}`,
    `${t.showings}: *${m.showings_week}* (${t.vsPrev}: ${m.showings_prev_week}; ${t.toDate}: ${m.showings_to_date})`,
    m.offers_expected ? `${t.offers}: *${m.offers_expected}*` : null,
    fbLines.length ? `${t.feedback}:\n${fbLines.map((x) => `• ${x}`).join('\n')}` : t.noFeedback,
    `${t.market} (${mk.area}): ${mk.pending_week} ${t.pendingWeek.toLowerCase()}, ${mk.sold_week} ${t.soldWeek.toLowerCase()}, ${mk.active_now} ${t.active.toLowerCase()}`,
    m.list_ppsf && mk.similar_median_ppsf ? `${t.yours} $${m.list_ppsf}/sf · ${t.similar} $${mk.similar_median_ppsf}/sf` : null,
    narrative,
  ].filter(Boolean).join('\n\n');
  return { subject, html, wa };
}

