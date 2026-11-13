#!/usr/bin/env node
// probe_reports.mjs — how Fast Track serves its PDF reports (plan review comments) and the
// documents list (links of each row), for one permit. Never prints credentials.
//   ORANGE_PORTAL_USER/_PASS [.._2] node collectors/fasttrack/probe_reports.mjs B26013237
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const B = 'https://fasttrack.ocfl.net/OnlineServices';
const target = process.argv[2] || 'B26013237';
const accounts = [[process.env.ORANGE_PORTAL_USER, process.env.ORANGE_PORTAL_PASS], [process.env.ORANGE_PORTAL_USER_2, process.env.ORANGE_PORTAL_PASS_2]].filter(([u, p]) => u && p);
const secrets = accounts.flat();
const clean = (s) => secrets.reduce((t, x) => t.replaceAll(x, '<redacted>'), String(s));
const section = (t, s) => console.log(`\n===== ${t} =====\n${clean(s)}`);
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'] });

for (const [user, pass] of accounts) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const seen = [];
  ctx.on('response', async (r) => { const ct = r.headers()['content-type'] || ''; if (!/text\/html|javascript|css|image|font/.test(ct)) seen.push(`${r.status()} ${ct} ${r.request().method()} ${r.url().slice(0, 300)}`); });
  await page.goto(`${B}/login.aspx`, { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill(user); await page.locator('#password').fill(pass);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('#btnLogin').click()]);
  await page.waitForTimeout(4000);
  await page.goto(`${B}/MyPermits.aspx`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href*="lnkPermit"]', { timeout: 30000 }).catch(() => {});
  const link = page.locator('a[href*="lnkPermit"]', { hasText: target }).first();
  if (!(await link.count())) { section('account', `${target} not on this login`); await ctx.close(); continue; }
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), link.click()]);
  await page.waitForSelector('#permitDetails2', { timeout: 60000 });
  await page.waitForTimeout(2000);
  section('f_ViewPDFReport source', await page.evaluate(() => (typeof f_ViewPDFReport === 'function' ? f_ViewPDFReport.toString() : 'not defined')));
  const docs = await page.$$eval('a', (els) => els.filter((e) => /\.pdf|report|document/i.test((e.innerText || '') + (e.getAttribute('href') || '') + (e.getAttribute('onclick') || ''))).map((e) => ({ t: (e.innerText || '').trim().slice(0, 80), h: (e.getAttribute('href') || '').slice(0, 300), on: (e.getAttribute('onclick') || '').slice(0, 300), tg: e.getAttribute('target') })));
  section('document/report links', JSON.stringify(docs, null, 1));
  const docTable = await page.$$eval('table', (ts) => { const t = ts.find((x) => /DESCRIPTION/.test(x.rows[0]?.innerText || '') && /DOC TYPE/.test(x.rows[0]?.innerText || '')); return t ? t.outerHTML.slice(0, 4000) : 'no documents table'; });
  section('documents table html (first 4000 chars)', docTable);
  // Open the plan review comments report and see what comes back.
  const a = page.locator('a:has-text("View Plan Review Comments")').first();
  if (await a.count()) {
    const popup = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await a.click().catch((e) => section('click error', e.message));
    const pp = await popup;
    if (pp) {
      await pp.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
      await pp.waitForTimeout(8000);
      section('popup url', pp.url());
      section('popup text', (await pp.innerText('body').catch(() => '(no body)')).slice(0, 3000));
      section('popup embeds', JSON.stringify(await pp.$$eval('embed,iframe,object', (els) => els.map((e) => ({ tag: e.tagName, src: e.getAttribute('src') || e.getAttribute('data'), type: e.getAttribute('type') }))).catch(() => [])));
    } else section('popup', 'none');
    const d = await dl; if (d) section('download', `${d.suggestedFilename()} ${d.url().slice(0, 300)}`);
  } else section('plan review comments', 'no link');
  await page.waitForTimeout(3000);
  section('non-html responses', seen.join('\n'));
  await ctx.close();
  break; // one account that has the permit is enough
}
await browser.close();
