#!/usr/bin/env node
// jobpage_probe.mjs — read-only: open one job's details in Buildertrend and print the form fields
// (label → input id/value) and the requests the page makes, to automate "Permit #". Saves nothing.
//   BT_COOKIES_FILE=... node collectors/buildertrend/jobpage_probe.mjs <jobId>
import { openBuildertrend } from './session.mjs';

const jobId = process.argv[2];
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); process.exit(1); }
const apis = new Set();
page.on('request', (r) => { if (/\/api\//i.test(r.url()) && !/telemetry|log/i.test(r.url())) apis.add(`${r.method()} ${r.url().replace(/\?.*/, '')}`); });
for (const url of [`https://buildertrend.net/app/JobPage/${jobId}/1`, `https://buildertrend.net/app/Jobs/List`]) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto', url, e.message));
  await page.waitForTimeout(12000);
  await page.evaluate(() => document.getElementById('chmln-dom')?.remove()).catch(() => {});
  console.log('\n== ', url, '→', page.url());
  const fields = await page.$$eval('input, textarea, select', (els) => els.filter((e) => e.offsetParent).map((e) => {
    const lab = e.id && document.querySelector(`label[for="${e.id}"]`);
    return `${(lab?.innerText || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 40)} | #${e.id} | ${e.type} | ${String(e.value || '').slice(0, 40)}`;
  }));
  console.log(fields.slice(0, 80).join('\n'));
  const permitish = await page.$$eval('*', (els) => els.filter((e) => e.children.length === 0 && /permit/i.test(e.textContent || '')).slice(0, 15).map((e) => `${e.tagName}#${e.id}.${String(e.className).slice(0, 40)}: ${e.textContent.trim().slice(0, 60)}`));
  console.log('permit texts:', permitish.join(' || '));
  if (/JobPage/.test(page.url())) break;
}
console.log('\nAPIs:', [...apis].slice(0, 60).join('\n'));
await browser.close();
