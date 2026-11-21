#!/usr/bin/env node
// =============================================================================
// invoice_links.mjs — an invoice e-mail that came with a link only (Intuit "View invoice", InvoiceSimple…):
// when the answer asks for it ("abre o link para baixar o pdf" → fetch_requested_at), open the link in a browser,
// take the PDF (a download, a PDF answer, a Download/Print button) or, failing that, print the page to PDF; store it
// and send the invoice back to the reader (status 'new'), so it is read, looked up in Buildertrend and billed like
// any other. Runs in ops-bt-post (it has the browser). A clean browser: no Buildertrend or other login.
//   node rules/invoice_links.mjs [--dry-run]
// =============================================================================
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { sql, q, DRY, orgId } from './lib.mjs';
import { serviceKey } from '../scripts/sb.mjs';

const REF = process.env.SUPABASE_PROJECT_REF || 'fvjknahpmihueyeasgbx';
const EXEC = process.env.CHROMIUM_PATH || undefined;
const org = await orgId();
const todo = await sql(`select v.id, v.vendor, v.email_subject, v.inbound_email_id, e.message_id, e.parsed->'links' links, e.body_text
  from ops.vendor_invoices v join ops.inbound_emails e on e.id = v.inbound_email_id
  where v.org_id = ${q(org)} and v.fetch_requested_at is not null and v.file_path = '(no file)' order by v.received_at limit 10`);
if (!todo.length) { console.log('invoice_links: nothing to fetch'); process.exit(0); }

// Links worth opening: the invoice viewer, not logos, images, privacy pages or a bare home page.
const SKIP = /\.(png|jpe?g|gif|svg|ico|css|js)(\?|\]|$)|privacy|security\.intuit|terms|unsubscribe|logo|cdn\.|facebook|twitter|instagram|linkedin|utm_source=invoice-simple&utm_medium=email&utm_campaign=invoice&utm_term/i;
const GOOD = /invoice|inv\d|connect\.intuit|getinvoicesimple|\/v\/|quickbooks|pay|bill|statement|view/i;
const candidates = (links) => {
  const xs = [...new Set((links || []).map((u) => String(u).replace(/[\]\)>.,;]+$/, '')))].filter((u) => /^https?:\/\//.test(u) && !SKIP.test(u));
  return xs.filter((u) => { try { const p = new URL(u); return p.pathname.length > 1 || p.search; } catch { return false; } })
    .sort((a, b) => Number(GOOD.test(b)) - Number(GOOD.test(a))).slice(0, 4);
};

async function upload(path, data) {
  const key = await serviceKey();
  const r = await fetch(`https://${REF}.supabase.co/storage/v1/object/ops-invoices/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: data });
  if (!r.ok) throw new Error(`storage ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox'] });
let fetched = 0;
for (const v of todo) {
  const urls = candidates(v.links);
  let pdf = null, how = '', lastErr = urls.length ? '' : 'nenhum link de invoice no e-mail';
  for (const url of urls) {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1600 } });
    const page = await ctx.newPage();
    let pdfResp = null;
    page.on('response', async (r) => { if (!pdfResp && /application\/pdf/i.test(r.headers()['content-type'] || '')) pdfResp = await r.body().catch(() => null); });
    const dl = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { if (!/download/i.test(e.message)) throw e; });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);
      let d = await Promise.race([dl, new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (!d && !pdfResp) {
        // A Download / PDF / Print button on the viewer.
        const btn = page.locator('a, button, [role="button"]').filter({ hasText: /download|pdf|save|print|baixar/i }).first();
        if (await btn.count()) { const dl2 = page.waitForEvent('download', { timeout: 20000 }).catch(() => null); await btn.click({ timeout: 10000 }).catch(() => {}); d = await dl2; await page.waitForTimeout(2000); }
      }
      if (d) { const p = await d.path().catch(() => null); if (p) { pdf = (await import('node:fs')).readFileSync(p); how = `download (${d.suggestedFilename()})`; } }
      else if (pdfResp && pdfResp.length > 1000) { pdf = pdfResp; how = 'PDF from the link'; }
      else {
        const text = (await page.innerText('body').catch(() => '')).toLowerCase();
        if (/invoice|amount due|balance due|total/.test(text) && text.length > 200) { pdf = await page.pdf({ format: 'Letter', printBackground: true }); how = 'page printed to PDF'; }
        else lastErr = `a página do link não mostrou a invoice (${url.slice(0, 80)})`;
      }
    } catch (e) { lastErr = `${e.message.slice(0, 160)} (${url.slice(0, 80)})`; }
    await ctx.close();
    if (pdf) break;
  }
  const tag = `${v.vendor || v.email_subject}`;
  if (!pdf) {
    console.log(`NOT FETCHED ${tag}: ${lastErr}`);
    if (!DRY) await sql(`update ops.vendor_invoices set fetch_requested_at = null, fetch_error = ${q(lastErr)},
        answer = coalesce(answer, '') || ${q(` · não consegui baixar a invoice pelo link: ${lastErr}`)}, updated_at = now() where id = ${q(v.id)}`);
    continue;
  }
  const folder = String(v.message_id || v.id).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);
  const name = `invoice-from-link-${new Date().toISOString().slice(0, 10)}.pdf`;
  console.log(`FETCHED ${tag}: ${how}, ${pdf.length} bytes`);
  if (DRY) continue;
  await upload(`${folder}/${name}`, pdf);
  // Back to the reader: read, looked up in Buildertrend, asked / billed like any invoice.
  await sql(`update ops.vendor_invoices set file_path = ${q(`${folder}/${name}`)}, file_name = ${q(name)}, status = 'new', is_invoice = null,
      issues = '{}', bt_checked_at = null, question_sent_at = null, fetch_requested_at = null, fetch_error = null,
      answer = coalesce(answer, '') || ${q(` · PDF baixado do link (${how}); lendo de novo`)}, updated_at = now() where id = ${q(v.id)};
    select ops.dispatch_workflow('ops-mail.yml')`);
  fetched++;
}
await browser.close();
console.log(`invoice_links: ${fetched}/${todo.length} fetched${DRY ? ' · DRY RUN' : ''}`);
