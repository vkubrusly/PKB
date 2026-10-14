#!/usr/bin/env node
// probe.mjs — log into Orange County Fast Track with each contractor account (PKB has two)
// and print what "My Permits" shows (page text, links, form fields). Never prints the
// credentials. Used to design the Fast Track collector. Results also go out as ::notice::
// annotations (step logs cannot be downloaded from a Claude session).
//   ORANGE_PORTAL_USER=... ORANGE_PORTAL_PASS=... [ORANGE_PORTAL_USER_2=... ORANGE_PORTAL_PASS_2=...]
//   node collectors/fasttrack/probe.mjs [permit#]
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const B = 'https://fasttrack.ocfl.net/OnlineServices';
const accounts = [['1', process.env.ORANGE_PORTAL_USER, process.env.ORANGE_PORTAL_PASS], ['2', process.env.ORANGE_PORTAL_USER_2, process.env.ORANGE_PORTAL_PASS_2]]
  .filter(([, u, p]) => u && p);
if (!accounts.length) { console.error('ORANGE_PORTAL_USER / ORANGE_PORTAL_PASS not set'); process.exit(2); }
const secrets = accounts.flatMap(([, u, p]) => [u, p]);
const clean = (s) => secrets.reduce((t, x) => t.replaceAll(x, '<redacted>'), String(s));
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const targets = (process.argv[2] || 'B26013237').split(/[,\s]+/).filter(Boolean);

const section = (t, s) => console.log(`\n===== ${t} =====\n${clean(s)}`);
// GitHub shows at most 10 notices per step: 5 per account.
const notice = (t, s) => console.log(`::notice title=${t}::${clean(s).slice(0, 3500).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
for (const [n, user, pass] of accounts) {
  const tag = `fasttrack login ${n}`;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const text = async () => clean((await page.innerText('body')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n'));
  try {
    await page.goto(`${B}/login.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    const fields = await page.$$eval('input', (els) => els.map((e) => `${e.type}#${e.id}`).filter((s) => !/hidden/.test(s)));
    section(`${tag}: login form fields`, fields.join(' '));
    await page.locator('input[type=email], input[id*="Email" i], input[id*="User" i]').first().fill(user);
    await page.locator('input[type=password]').first().fill(pass);
    await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), page.locator('input[type=submit][value*="Log" i], button:has-text("Log"), a:has-text("Log In"), input[id*="Login" i][type=submit]').first().click()]);
    await page.waitForTimeout(6000);
    const t1 = await text();
    section(`${tag}: after login`, `${page.url()}\n${t1.slice(0, 2500)}`);
    const loggedOut = /login\.aspx/i.test(page.url());
    notice(`${tag}: login`, `${loggedOut ? 'STILL ON LOGIN PAGE' : 'logged in'}${/HUMAN|captcha/i.test(t1) ? ' · CAPTCHA' : ''} · ${page.url()}\n${t1.slice(0, 1500)}`);

    await page.goto(`${B}/MyPermits.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(6000);
    const t2 = await text();
    section(`${tag}: my permits`, `${page.url()}\n${t2.slice(0, 6000)}`);
    notice(`${tag}: my permits`, `${page.url()}\n${t2.slice(0, 3300)}`);
    const links = await page.$$eval('a', (els) => els.map((e) => `${(e.innerText || '').trim()} -> ${e.getAttribute('href')}`).filter((s) => /B\d{8}|BLD|Permit|Detail|View/i.test(s)));
    section(`${tag}: permit links`, links.slice(0, 60).join('\n'));
    notice(`${tag}: permit links`, links.slice(0, 40).join('\n') || '(none)');

    for (const target of targets) {
      await page.goto(`${B}/MyPermits.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(4000);
      const link = page.locator(`a:has-text("${target}")`).first();
      if (!(await link.count())) { notice(`${tag}: permit ${target}`, 'not linked on My Permits'); continue; }
      await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), link.click()]);
      await page.waitForTimeout(6000);
      const detail = page.url();
      section(`${tag}: permit ${target}`, `${detail}\n${(await text()).slice(0, 8000)}`);
      // Processes table structure (for the collector's selectors).
      const tables = await page.$$eval('table', (ts) => ts.map((t) => ({ id: t.id, cls: t.className, rows: t.rows.length, head: (t.rows[0]?.innerText || '').replace(/\s+/g, ' ').slice(0, 120) })).filter((t) => t.rows > 1));
      section(`${tag}: ${target} tables`, JSON.stringify(tables, null, 1));
      const sub = await page.$$eval('a', (els) => els.map((e) => ({ t: (e.innerText || '').trim(), h: e.getAttribute('href'), on: e.getAttribute('onclick'), tg: e.getAttribute('target') })).filter((x) => /view plan review comments|view inspection results|certificate of occupancy holds|sub ?permits|\.pdf/i.test(x.t)));
      section(`${tag}: ${target} sub links`, JSON.stringify(sub, null, 1));
      for (const label of ['View Plan Review Comments', 'View Inspection Results', 'View Certificate of Occupancy Holds']) {
        const a = page.locator(`a:has-text("${label}")`).first();
        if (!(await a.count())) { section(`${tag}: ${target} ${label}`, '(no link)'); continue; }
        const popup = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
        await a.click().catch(() => {});
        const pp = await popup;
        const pg = pp || page;
        await pg.waitForLoadState('domcontentloaded').catch(() => {});
        await pg.waitForTimeout(6000);
        const tx = clean((await pg.innerText('body')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n'));
        section(`${tag}: ${target} ${label}`, `${pg.url()}\n${tx.slice(0, 12000)}`);
        if (pp) await pp.close(); else { await page.goto(detail).catch(() => {}); await page.waitForTimeout(4000); }
      }
    }
  } catch (e) {
    notice(`${tag}: error`, `${e.message} · ${page.url()}`);
  }
  await ctx.close();
}
await browser.close();
