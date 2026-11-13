#!/usr/bin/env node
// probe.mjs — City of Orlando ProjectDox (Avolve): log in with PKB's account(s) and print what the
// account sees — the project list, and for the project matching the argument (address or number, default
// "Palm") its page text, tabs/links and the API calls the page makes. Used to design the collector.
// Never prints the credentials. Read-only: no upload, no form submit besides the login.
//   ORLANDO_PROJECTDOX_USER/_PASS [.._2] node collectors/projectdox/probe.mjs [address or project #]
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const START = 'https://orlando-fl-us-projectdoxwebui.avolvecloud.com/';
const target = process.argv[2] || 'Palm';
const accounts = [['1', process.env.ORLANDO_PROJECTDOX_USER, process.env.ORLANDO_PROJECTDOX_PASS], ['2', process.env.ORLANDO_PROJECTDOX_USER_2, process.env.ORLANDO_PROJECTDOX_PASS_2]].filter(([, u, p]) => u && p);
if (!accounts.length) { console.error('ORLANDO_PROJECTDOX_USER / ORLANDO_PROJECTDOX_PASS not set'); process.exit(2); }
const secrets = accounts.flatMap(([, u, p]) => [u, p]);
const clean = (s) => secrets.reduce((t, x) => t.replaceAll(x, '<redacted>'), String(s));
const section = (t, s) => console.log(`\n===== ${t} =====\n${clean(s)}`);
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });

for (const [n, user, pass] of accounts) {
  const tag = `projectdox login ${n}`;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const api = [];
  page.on('response', async (r) => {
    const ct = r.headers()['content-type'] || '';
    if (/json/i.test(ct) && /avolvecloud/i.test(r.url())) api.push(`${r.request().method()} ${r.status()} ${r.url().slice(0, 200)} :: ${(await r.text().catch(() => '')).slice(0, 1200)}`);
  });
  const text = async () => clean((await page.innerText('body').catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n'));
  try {
    await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#Email', { timeout: 60000 });
    await page.fill('#Email', user);
    await page.fill('#Password', pass);
    await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), page.click('#login-button')]);
    await page.waitForTimeout(10000);
    section(`${tag}: after login`, `${page.url()}\n${(await text()).slice(0, 4000)}`);
    const links = await page.$$eval('a', (els) => els.map((e) => `${(e.innerText || '').trim().slice(0, 60)} -> ${(e.getAttribute('href') || '').slice(0, 160)}`).filter((s) => !/^ ->/.test(s)));
    section(`${tag}: links`, links.slice(0, 80).join('\n'));
    // Open the project whose row matches the target (case number or address) through its own link.
    const href = await page.$$eval('a[href*="Project/Index"]', (els, t) => { const re = new RegExp(t, 'i'); const a = els.find((e) => re.test(e.closest('tr')?.innerText || e.innerText || '')); return a ? a.href : null; }, target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (href) {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(10000);
      section(`${tag}: project "${target}"`, `${page.url()}\n${(await text()).slice(0, 8000)}`);
      const tabs = await page.$$eval('a, button, [role="tab"], li', (els) => els.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 40));
      section(`${tag}: project tabs/buttons`, JSON.stringify([...new Set(tabs)].slice(0, 150)));
      // Read-only views: open each tab that shows status, tasks, reports, comments, history, files.
      const names = [...new Set(tabs)].filter((t) => /^(project info|info|tasks?|reports?|workflow|history|comments?|changemarks?|checklists?|files|documents|status|review|corrections?|conditions)$/i.test(t));
      for (const nm of names) {
        const el = page.locator('a, [role="tab"], li', { hasText: new RegExp(`^\\s*${nm}\\s*$`, 'i') }).first();
        if (!(await el.count())) continue;
        await el.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(6000);
        section(`${tag}: tab "${nm}"`, `${page.url()}\n${(await text()).slice(0, 6000)}`);
      }
    } else section(`${tag}: project "${target}"`, 'no project link matches');
    section(`${tag}: JSON API calls`, api.slice(0, 80).join('\n'));
  } catch (e) { section(`${tag}: error`, `${e.message} · ${page.url()}`); }
  await ctx.close();
}
await browser.close();
