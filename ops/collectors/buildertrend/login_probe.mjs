#!/usr/bin/env node
// =============================================================================
// login_probe.mjs — log the bot user into Buildertrend and report what it sees.
//
//   BUILDERTREND_USER=... BUILDERTREND_PASS=... node collectors/buildertrend/login_probe.mjs [verify-url]
//
// First step of the Buildertrend bridge (RPA). It only reads: logs in through
// the Auth0 universal login, optionally follows an e-mail verification link,
// then lists the Jobs the user can access and screenshots the landing page.
// Screenshots/text go to ops/data/buildertrend/probe/.
//
// FINDING (2026-09-25): the Auth0 login page shows a reCAPTCHA, so unattended
// password login is not viable and we do not try to bypass it. The bridge will
// either use the official API (requested from Buildertrend) or reuse a browser
// session seeded by a one-time manual login on the server (storageState).
// =============================================================================
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'data', 'buildertrend', 'probe');
mkdirSync(OUT, { recursive: true });
const user = process.env.BUILDERTREND_USER, pass = process.env.BUILDERTREND_PASS;
if (!user || !pass) { console.error('BUILDERTREND_USER / BUILDERTREND_PASS not set'); process.exit(2); }
const verifyUrl = process.argv[2] || null;

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const text = async () => (await page.innerText('body')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
const shot = (n) => page.screenshot({ path: join(OUT, `${n}.png`), fullPage: true });

try {
  await page.goto(verifyUrl || 'https://buildertrend.net/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2000);
  console.log('landing:', page.url());
  // Auth0 universal login: email + password on one form, or two steps.
  const email = page.locator('input[name="username"], input[type="email"], input[name="email"]').first();
  await email.waitFor({ timeout: 60000 });
  await email.fill(user);
  const pw = page.locator('input[name="password"], input[type="password"]').first();
  if (!(await pw.isVisible().catch(() => false))) { await page.keyboard.press('Enter'); await pw.waitFor({ timeout: 30000 }); }
  await pw.fill(pass);
  await shot('01_login_filled');
  await Promise.all([page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}), page.keyboard.press('Enter')]);
  await page.waitForTimeout(6000);
  console.log('after login:', page.url());
  await shot('02_after_login');
  const t = await text();
  writeFileSync(join(OUT, '02_after_login.txt'), t);
  console.log('PAGE_TEXT_START\n' + t.slice(0, 2500) + '\nPAGE_TEXT_END');
  if (/verification code|verify|two-factor|2fa|code sent/i.test(t) && !/verified/i.test(t)) console.log('NOTE: page mentions verification — may need a code from the bot mailbox.');

  // Try the jobs list.
  for (const url of ['https://buildertrend.net/app/jobs', 'https://buildertrend.net/Jobs/JobsList.aspx']) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const jt = await text();
    if (jt.length > 200 && !/login/i.test(page.url())) {
      await shot('03_jobs');
      writeFileSync(join(OUT, '03_jobs.txt'), jt);
      console.log('JOBS_URL', page.url());
      console.log('JOBS_TEXT_START\n' + jt.slice(0, 4000) + '\nJOBS_TEXT_END');
      break;
    }
  }
} catch (e) {
  console.error('ERR', e.message);
  await shot('99_error').catch(() => {});
  console.log('URL at error:', page.url());
  console.log((await text().catch(() => '')).slice(0, 1500));
} finally {
  await browser.close();
}
