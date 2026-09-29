// =============================================================================
// daily_log.mjs — write a Daily Log to a Buildertrend job (seeded session).
//
//   import { createDailyLog } from './daily_log.mjs';
//   await createDailyLog(page, { jobName: '0001 - OC - Sunny', title, notes,
//                                 privateLog: false, notify: [] });
//
// Validated on 2026-09-25 against job 0001 (log 93270541):
//  - the new-log form defaults to sharing with Internal Users and to notifying
//    every internal user; we clear the notify list unless `notify` names people
//  - weather is filled in automatically by Buildertrend
//  - the bot's role has no Delete on Daily Logs (by design), so logs written by
//    the bot are removed by a person
// Detail URL of a log: https://buildertrend.net/app/DailyLogView/{logId}/{jobId}/none
// List data (JSON): /apix/v2/DailyLogs/grid — used to read logs back and get ids.
// =============================================================================

export async function selectJob(page, jobName) {
  const item = page.getByText(jobName, { exact: false }).first();
  await item.waitFor({ timeout: 90000 });
  await item.click();
  await page.waitForTimeout(2500);
}

export async function createDailyLog(page, { jobId = null, jobName, title, notes, privateLog = false, shareWithSubs = false, shareWithClient = false, notify = [], stopBeforePublish = false }) {
  notify = [...notify];
  if (!title || title.length > 50) throw new Error('title is required and must be ≤ 50 characters');
  if ((notes || '').length > 4000) throw new Error('notes must be ≤ 4000 characters');
  // Open the job's Daily Logs directly by its Buildertrend id (?jobId= selects the job);
  // clicking the picker by name was unreliable. Falls back to the picker without an id.
  if (jobId) await page.goto(`https://buildertrend.net/app/DailyLogs?jobId=${jobId}`, { waitUntil: 'domcontentloaded' });
  else { await selectJob(page, jobName); await page.goto('https://buildertrend.net/app/DailyLogs', { waitUntil: 'domcontentloaded' }); }
  const newBtn = page.getByRole('button', { name: /Create new Daily Log|^Daily Log$/ }).first();
  await newBtn.waitFor({ timeout: 90000 });
  await newBtn.click();
  const titleBox = page.locator('textarea[name="logTitle"], textarea#logTitle').first();
  await titleBox.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);

  await titleBox.fill(title);
  await page.locator('textarea[name="notes"], textarea#notes').first().fill(notes || '');
  const setBox = async (id, on) => { const c = page.locator(`input#${id}, input[name="${id}"]`).first(); if ((await c.isChecked()) !== on) await (on ? c.check({ force: true }) : c.uncheck({ force: true })); };
  await setBox('isPrivate', privateLog);
  if (!privateLog) { await setBox('canShareSubs', shareWithSubs); await setBox('canShareOwner', shareWithClient); }

  // Notify list: a tree of checkboxes ("Check All" › "Internal Users" › one node per person),
  // everyone ticked by default. Untick "Check All", then tick the requested people by name.
  // People who are not Buildertrend users on the job are not in the tree: they are skipped.
  const notifySelect = page.locator('input#usersToNotify').locator('xpath=ancestor::div[contains(@class,"ant-select-multiple")][1]');
  await notifySelect.locator('.ant-select-selector').click();
  const drop = page.locator('[data-testid="usersToNotify-popup"]');
  await drop.locator('.ant-select-tree-title', { hasText: 'Check All' }).waitFor({ timeout: 15000 });
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
  const node = async (name) => {
    const nodes = drop.locator('.ant-select-tree-treenode');
    for (let i = 0; i < await nodes.count(); i++) {
      const t = await nodes.nth(i).locator('.ant-select-tree-title').innerText().catch(() => '');
      if (flat(t).endsWith(flat(name))) return nodes.nth(i);
    }
    return null;
  };
  const checkAll = await node('Check All');
  if (/checkbox-checked|checkbox-indeterminate/.test(await checkAll.getAttribute('class') + await checkAll.locator('.ant-select-tree-checkbox').getAttribute('class'))) {
    await checkAll.locator('.ant-select-tree-checkbox').click(); await page.waitForTimeout(400);
  }
  const skipped = [], picked = [];
  for (const name of notify) {
    const n = await node(name);
    if (!n) { skipped.push(name); continue; }
    if (!/checkbox-checked/.test(await n.getAttribute('class'))) { await n.locator('.ant-select-tree-checkbox').click(); await page.waitForTimeout(250); }
    picked.push(name);
  }
  notify = picked;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const chips = notifySelect.locator('.ant-select-selection-overflow-item:not(.ant-select-selection-overflow-item-suffix):not(.ant-select-selection-overflow-item-rest)');
  const selectedNames = (await chips.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().replace(/^[A-Z]{1,3} /, '')).filter(Boolean);
  const wanted = notify.map((n) => n.replace(/\s+/g, ' ').toLowerCase());
  if (selectedNames.length !== notify.length || !wanted.every((w) => selectedNames.some((x) => x.toLowerCase().endsWith(w))))
    throw new Error(`notify list is [${selectedNames.join(', ')}], expected [${notify.join(', ')}]; not publishing`);
  // The form must be on the intended job before anything is published.
  const formJob = (await page.locator('body').innerText()).match(/\b\d{4} - [A-Z]{2} - [^\n]+/)?.[0] || '';
  if (jobName && !formJob.startsWith(jobName.slice(0, 7))) throw new Error(`form is on "${formJob}", expected "${jobName}"; not publishing`);
  if (stopBeforePublish) return { stopped: true, formJob, notify: selectedNames, skipped };

  await page.locator('button#publish, button[name="publish"]').first().click();
  await page.getByText(title, { exact: true }).first().waitFor({ timeout: 60000 });
  const m = page.url().match(/DailyLogView\/(\d+)\/(\d+)/);
  return { logId: m ? Number(m[1]) : null, jobId: m ? Number(m[2]) : null, url: page.url(), notified: selectedNames, skipped };
}
