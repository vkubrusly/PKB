#!/usr/bin/env node
// lead_find.mjs — READ-ONLY: search Buildertrend's Lead Opportunities list and print what it shows (search box
// found or not, the list text after the search, lead links). Used to check that a lead exists and read its id.
//   BT_COOKIES_FILE=… node collectors/buildertrend/lead_find.mjs "<text>" ["<text>"…]
import { openBuildertrend } from './session.mjs';
import { openList } from './lead.mjs';

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
for (const k of process.argv.slice(2)) {
  await openList(page);
  const box = page.locator('#keywordSearch, input[placeholder*="Search" i]').first();
  const visible = await box.isVisible().catch(() => false);
  console.log(`\n===== "${k}" · search box ${visible ? 'found' : 'NOT found'} =====`);
  if (visible) { await box.fill(k); await box.press('Enter'); await page.waitForTimeout(6000); }
  const text = (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
  const i = text.toLowerCase().indexOf(k.toLowerCase().split(' ')[0]);
  console.log(i >= 0 ? text.slice(Math.max(0, i - 300), i + 900) : `(text not on the page) ${text.slice(0, 1500)}`);
  const links = await page.$$eval('a[href]', (els) => els.map((a) => `${(a.innerText || '').trim().slice(0, 60)} -> ${a.getAttribute('href')}`).filter((s) => /lead/i.test(s)).slice(0, 15));
  console.log(links.join('\n'));
}
await browser.close();
