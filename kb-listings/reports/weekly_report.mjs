#!/usr/bin/env node
// =============================================================================
// Weekly report per listing — what happened last week (Mon–Sun, Florida time):
//   showings (done, requested, cancelled; vs. the week before and to date), buyers' feedback
//   (interest, price, possible offers), price/status changes, days on market, and the nearby
//   market: what went pending and what sold that week, inventory and $/sf vs. similar homes.
//
// Output per listing: kb.listing_reports (HTML e-mail + WhatsApp text), data/reports/<week>/*.html,
// and one internal digest (KB_REPORT_PREVIEW_TO) with every report and its WhatsApp text, so the
// agent can review and forward. Sellers only receive it with --send AND KB_SEND_ENABLED=true.
//
//   node reports/weekly_report.mjs [--week-start 2026-09-21] [--listing <mls|id>] [--send] [--dry-run]
// =============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { q, sql } from '../lib/db.mjs';
import { sendEmail, sendingEnabled } from '../lib/mail.mjs';
import { addDays, buildMetrics, esc, fmtDay, lastWeek, render } from '../lib/report.mjs';
import { weeklyNarrative } from '../lib/ai.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DRY = process.argv.includes('--dry-run');
const SEND = process.argv.includes('--send');
const AGENT = process.env.KB_AGENT_NAME || 'Victor Kubrusly';
const BRAND = process.env.KB_BRAND || 'Kubrusly Basso Team';
const BROKERAGE = process.env.KB_BROKERAGE ?? 'WRA Business & Real Estate';
const LOGO = process.env.KB_LOGO_URL || '';
const PREVIEW_TO = (process.env.KB_REPORT_PREVIEW_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

const from = arg('--week-start', lastWeek());
const to = addDays(from, 7);
const prevFrom = addDays(from, -7);

// ---------- run ----------
const sel = arg('--listing');
const listings = await sql(`select * from kb.listings where (status in ('coming_soon', 'active', 'pending')
    or (pending_at >= ${q(from)} and pending_at < ${q(to)}) or (sold_at >= ${q(from)} and sold_at < ${q(to)}))
  ${sel ? `and (mls_number = ${q(sel)} or id::text = ${q(sel)})` : ''} order by address`);
if (!listings.length) { console.log('no listings to report'); process.exit(0); }
const showings = await sql(`select * from kb.showings where listing_id in (${listings.map((l) => q(l.id)).join(',')})`);
const history = await sql(`select * from kb.listing_history where changed_at >= ${q(prevFrom)}::date - 1`);
const comps = await sql(`select * from kb.market_comps where coalesce(sold_at, pending_at, listed_at, imported_at::date) > ${q(from)}::date - 120 or status = 'active'`);

const dir = new URL(`../data/reports/${from}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const digest = [];
for (const l of listings) {
  const m = buildMetrics(l, showings, history, comps, from);
  const narrative = await weeklyNarrative({ week: `${from}..${to}`, ...m }, l.report_lang).catch((e) => { console.error('narrative:', e.message); return null; });
  const { subject, html, wa } = render(l, m, narrative, from, { brand: BRAND, agent: AGENT, brokerage: BROKERAGE, logoUrl: LOGO });
  const slug = l.address.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  writeFileSync(`${dir}${slug}.html`, `<!doctype html><meta charset="utf-8"><title>${esc(subject)}</title>${html}`);
  writeFileSync(`${dir}${slug}.whatsapp.txt`, wa);
  console.log(`${l.address}: ${m.showings_week} showings, ${m.feedback.length} feedback, market ${m.market.pending_week} pending / ${m.market.sold_week} sold`);
  if (DRY) continue;

  let status = 'draft', sentTo = [];
  const to_ = (l.seller_emails || []).filter(Boolean);
  if (SEND && sendingEnabled() && (l.report_channels || []).includes('email') && to_.length) {
    try { await sendEmail({ to: to_, subject, html, text: wa.replace(/\*/g, '') }); status = 'sent'; sentTo = to_; } catch (e) { status = 'failed'; console.error(e.message); }
  }
  await sql(`insert into kb.listing_reports (listing_id, week_start, week_end, metrics, subject, html, whatsapp_text, status, sent_to, sent_at)
    values (${q(l.id)}, ${q(from)}, ${q(to)}, ${q(JSON.stringify(m))}::jsonb, ${q(subject)}, ${q(html)}, ${q(wa)}, ${q(status)}, array[${sentTo.map(q).join(',')}]::text[], ${status === 'sent' ? 'now()' : 'null'})
    on conflict (listing_id, week_start) do update set metrics = excluded.metrics, subject = excluded.subject, html = excluded.html, whatsapp_text = excluded.whatsapp_text,
      status = case when kb.listing_reports.status = 'sent' then 'sent' else excluded.status end,
      sent_to = case when excluded.status = 'sent' then excluded.sent_to else kb.listing_reports.sent_to end,
      sent_at = coalesce(kb.listing_reports.sent_at, excluded.sent_at)`);
  digest.push({ l, subject, html, wa, status, whatsapp: (l.report_channels || []).includes('whatsapp') });
}

if (!DRY && PREVIEW_TO.length && digest.length) {
  const body = digest.map((d) => `<hr style="margin:32px 0"><p style="font-size:12px;color:#6b7280">${esc(d.status.toUpperCase())} · ${esc((d.l.seller_emails || []).join(', ') || 'sem e-mail do cliente')}${d.whatsapp ? ` · WhatsApp ${esc(d.l.seller_whatsapp || '?')}` : ''}</p>${d.html}
    <p style="font-size:12px;color:#6b7280;margin-top:16px">WhatsApp (copiar e colar):</p><pre style="white-space:pre-wrap;background:#f3f4f6;padding:12px;border-radius:8px;font-size:13px">${esc(d.wa)}</pre>`).join('');
  await sendEmail({ to: PREVIEW_TO, subject: `[Listings] Relatórios da semana de ${fmtDay(from, 'pt')} — ${digest.length} imóvel(is)`, html: `<div style="font-family:Arial,sans-serif">${body}</div>` })
    .catch((e) => console.error('preview:', e.message));
}
console.log(`week ${from} → ${to}: ${listings.length} report(s) in ${dir}${SEND ? '' : ' · drafts (use --send to e-mail sellers)'}`);
