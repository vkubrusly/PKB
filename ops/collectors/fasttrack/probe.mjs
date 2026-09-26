#!/usr/bin/env node
// probe.mjs — log into Orange County Fast Track with the contractor account and
// print what "My Permits" shows (page text, links, form fields). Never prints the
// credentials. Used once to design the Fast Track collector.
//   ORANGE_PORTAL_USER=... ORANGE_PORTAL_PASS=... node collectors/fasttrack/probe.mjs [permit#]
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const B = 'https://fasttrack.ocfl.net/OnlineServices';
const user = process.env.ORANGE_PORTAL_USER, pass = process.env.ORANGE_PORTAL_PASS;
if (!user || !pass) { console.error('ORANGE_PORTAL_USER / ORANGE_PORTAL_PASS not set'); process.exit(2); }
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true })).newPage();
const text = async () => (await page.innerText('body')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').replaceAll(user, '<user>');
const section = (t, s) => console.log(`\n===== ${t} =====\n${s}`);

await page.goto(`${B}/login.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
const fields = await page.$$eval('input', els => els.map(e => `${e.type}#${e.id}`).filter(s => !/hidden/.test(s)));
section('login form fields', fields.join(' '));
await page.locator('input[type=email], input[id*="Email" i], input[id*="User" i]').first().fill(user);
await page.locator('input[type=password]').first().fill(pass);
await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), page.locator('input[type=submit][value*="Log" i], button:has-text("Log"), a:has-text("Log In"), input[id*="Login" i][type=submit]').first().click()]);
await page.waitForTimeout(6000);
section('after login url', page.url());
const t1 = await text();
section('after login text', t1.slice(0, 2500));
if (/HUMAN|captcha/i.test(t1)) console.log('NOTE: captcha on login');

await page.goto(`${B}/MyPermits.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(6000);
section('my permits url', page.url());
section('my permits text', (await text()).slice(0, 6000));
const links = await page.$$eval('a', els => els.map(e => `${(e.innerText || '').trim()} -> ${e.getAttribute('href')}`).filter(s => /B\d{8}|Permit|Detail|View/i.test(s)));
section('permit links', links.slice(0, 60).join('\n'));

const target = process.argv[2] || 'B26013237';
const link = page.locator(`a:has-text("${target}")`).first();
if (await link.count()) {
  await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), link.click()]);
  await page.waitForTimeout(6000);
  section(`permit ${target} url`, page.url());
  section(`permit ${target} text`, (await text()).slice(0, 8000));
  const tabs = await page.$$eval('a', els => els.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 40 && /review|inspection|hold|fee|status|comment|condition|plan/i.test(t)));
  section('tabs', JSON.stringify([...new Set(tabs)]));
} else console.log(`\n(permit ${target} not linked on My Permits)`);
await browser.close();
