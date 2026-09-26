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

export async function createDailyLog(page, { jobName, title, notes, privateLog = false, shareWithSubs = false, shareWithClient = false, notify = [] }) {
  if (!title || title.length > 50) throw new Error('title is required and must be ≤ 50 characters');
  if ((notes || '').length > 4000) throw new Error('notes must be ≤ 4000 characters');
  await selectJob(page, jobName);
  await page.goto('https://buildertrend.net/app/DailyLogs', { waitUntil: 'domcontentloaded' });
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

  // Clear the default notify list, then add the requested people (by display name).
  const notifySelect = page.locator('input#usersToNotify').locator('xpath=ancestor::div[contains(@class,"ant-select-multiple")][1]');
  for (let i = 0; i < 20; i++) {
    const close = notifySelect.locator('.ant-select-selection-item-remove, [aria-label="close"], .anticon-close').first();
    if (!(await close.count())) break;
    await close.click({ force: true }).catch(() => {}); await page.waitForTimeout(200);
  }
  for (const name of notify) {
    await page.locator('input#usersToNotify').fill(name);
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
  }
  const selected = await notifySelect.locator('.ant-select-selection-item').count();
  if (selected !== notify.length) throw new Error(`notify list has ${selected} people, expected ${notify.length}; not publishing`);

  await page.locator('button#publish, button[name="publish"]').first().click();
  await page.getByText(title, { exact: true }).first().waitFor({ timeout: 60000 });
  const m = page.url().match(/DailyLogView\/(\d+)\/(\d+)/);
  return { logId: m ? Number(m[1]) : null, jobId: m ? Number(m[2]) : null, url: page.url() };
}
