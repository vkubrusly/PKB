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

export async function createDailyLog(page, { jobId = null, jobName, title, notes, privateLog = false, shareWithSubs = false, shareWithClient = false, notify = [], attachments = [], stopBeforePublish = false }) {
  notify = [...notify];
  if (!title || title.length > 50) throw new Error('title is required and must be ≤ 50 characters');
  if ((notes || '').length > 4000) throw new Error('notes must be ≤ 4000 characters');
  // Open the job's Daily Logs directly by its Buildertrend id (?jobId= selects the job);
  // clicking the picker by name was unreliable. Falls back to the picker without an id.
  if (jobId) await page.goto(`https://buildertrend.net/app/DailyLogs?jobId=${jobId}`, { waitUntil: 'domcontentloaded' });
  else { await selectJob(page, jobName); await page.goto('https://buildertrend.net/app/DailyLogs', { waitUntil: 'domcontentloaded' }); }
  const newBtn = page.getByRole('button', { name: /Create new Daily Log/ }).or(page.locator('button', { hasText: /^\W*Daily Log\s*$/ })).first();
  // Buildertrend is sometimes slow to render the list: reload once before giving up.
  if (!(await newBtn.waitFor({ timeout: 90000 }).then(() => true).catch(() => false))) {
    // (the page rewrites its URL to /app/DailyLogs, so open it again by job id instead of reloading)
    await page.goto(jobId ? `https://buildertrend.net/app/DailyLogs?jobId=${jobId}` : 'https://buildertrend.net/app/DailyLogs', { waitUntil: 'domcontentloaded' });
    await newBtn.waitFor({ timeout: 120000 });
  }
  await newBtn.click();
  const titleBox = page.locator('textarea[name="logTitle"], textarea#logTitle').first();
  await titleBox.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);

  await titleBox.fill(title);
  await page.locator('textarea[name="notes"], textarea#notes').first().fill(notes || '');
  const setBox = async (id, on) => { const c = page.locator(`input#${id}, input[name="${id}"]`).first(); if ((await c.isChecked()) !== on) await (on ? c.check({ force: true }) : c.uncheck({ force: true })); };
  await setBox('isPrivate', privateLog);
  if (!privateLog) { await setBox('canShareSubs', shareWithSubs); await setBox('canShareOwner', shareWithClient); }

  // Photos (local file paths): Attachments → Add → Browse device (multi-file input) → Upload.
  if (attachments.length) {
    await page.locator('button', { hasText: /^\s*Add\s*$/ }).first().click();
    const input = page.locator('.ant-modal-content input[type=file], input[type=file]').first();
    await input.waitFor({ state: 'attached', timeout: 30000 });
    await input.setInputFiles(attachments);
    await page.waitForTimeout(1500);
    await page.locator('.ant-modal-content button', { hasText: /^\s*Upload\s*$/ }).first().click();
    const names = attachments.map((f) => f.split('/').pop());
    const deadline = Date.now() + 180000;
    for (;;) {
      const body = await page.locator('body').innerText();
      const shown = names.filter((n) => body.includes(n.slice(0, 12))).length;
      if (shown === names.length && !(await page.locator('.ant-modal-content button', { hasText: /^\s*Upload\s*$/ }).isVisible().catch(() => false))) break;
      if (Date.now() > deadline) throw new Error(`attachments: ${shown}/${names.length} shown in the form; not publishing`);
      await page.waitForTimeout(2000);
    }
  }

  // Notify list: a tree of checkboxes ("Check All" › "Internal Users" › one node per person),
  // everyone ticked by default. Untick "Check All", then tick the requested people by name.
  // People who are not Buildertrend users on the job are not in the tree: they are skipped.
  const notifySelect = page.locator('input#usersToNotify').locator('xpath=ancestor::div[contains(@class,"ant-select-multiple")][1]');
  const drop = page.locator('[data-testid="usersToNotify-popup"]');
  const container = page.locator('.ant-select-dropdown:has([data-testid="usersToNotify-popup"])');
  // The dropdown often ignores the first click on a slow page: click until it is really open.
  const ensureOpen = async () => {
    for (let k = 0; k < 5; k++) {
      const cls = (await container.getAttribute('class').catch(() => null)) || 'ant-select-dropdown-hidden';
      if (!/dropdown-hidden/.test(cls) && (await drop.locator('.ant-select-tree-title').count())) return;
      await notifySelect.locator('.ant-select-selector').click();
      await page.waitForTimeout(1500);
    }
    throw new Error('notify list did not open; not publishing');
  };
  await ensureOpen();
  await page.waitForTimeout(800); // let the dropdown animation settle
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
  const rx = (name) => new RegExp(`${name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*$`, 'i');
  const node = async (name) => {
    const titles = drop.locator('.ant-select-tree-title');
    for (let i = 0; i < await titles.count(); i++) {
      if (rx(name).test((await titles.nth(i).innerText().catch(() => '')).trim()))
        return titles.nth(i).locator('xpath=ancestor::div[contains(@class,"ant-select-tree-treenode")][1]');
    }
    return null;
  };
  await ensureOpen();
  const checkAll = await node('Check All');
  if (!checkAll) throw new Error('notify list: "Check All" not found; not publishing');
  if (/checkbox-checked|checkbox-indeterminate/.test(await checkAll.getAttribute('class') + await checkAll.locator('.ant-select-tree-checkbox').getAttribute('class'))) {
    await checkAll.locator('.ant-select-tree-checkbox').click({ force: true }); await page.waitForTimeout(400);
  }
  const skipped = [], picked = [];
  for (const name of notify) {
    await ensureOpen();
    const n = await node(name);
    if (!n) { skipped.push(name); continue; }
    if (!/checkbox-checked/.test(await n.getAttribute('class'))) { await n.locator('.ant-select-tree-checkbox').click({ force: true }); await page.waitForTimeout(250); }
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
  return { logId: m ? Number(m[1]) : null, jobId: m ? Number(m[2]) : null, url: page.url(), notified: selectedNames, skipped, attached: attachments.length };
}
