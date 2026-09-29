#!/usr/bin/env node
// probe.mjs — can the Lake County (FL) OPRS permit portal be reached from here?
// The county firewall blocks some cloud networks ("Web Page Blocked!"). Read-only:
// opens the portal, prints what it shows (blocked page or the search form and links).
//   node collectors/lake/probe.mjs [permitNumber]
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'https://mcdplus.lakecountyfl.gov/oprs_PT/';
const permit = process.argv[2] || '2026040997';
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

const res = await fetch(URL).catch((e) => ({ status: 'ERR ' + e.message, text: async () => '' }));
const body = await res.text();
console.log(`HTTP ${res.status} · ${/Web Page Blocked/i.test(body) ? 'BLOCKED by the county firewall' : 'not blocked'} · ${body.length} bytes`);

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => console.log('goto:', e.message));
await page.waitForTimeout(6000);
const text = (await page.innerText('body').catch(() => '')).replace(/\n+/g, ' | ');
console.log('PAGE:', text.slice(0, 1500));
if (!/Web Page Blocked/i.test(text)) {
  const inputs = await page.$$eval('input,select', (els) => els.map((e) => `${e.tagName} id=${e.id} name=${e.name} placeholder=${e.placeholder || ''}`));
  console.log('FORM FIELDS:', inputs.slice(0, 30).join(' ; '));
  const links = await page.$$eval('a', (as) => as.map((a) => (a.innerText || '').trim().slice(0, 50) + ' => ' + a.href).filter((t) => /search|permit|inspect|public|record/i.test(t)));
  console.log('LINKS:', [...new Set(links)].slice(0, 30).join(' ; '));
  console.log(`(permit to look for next: ${permit})`);
}
await browser.close();
