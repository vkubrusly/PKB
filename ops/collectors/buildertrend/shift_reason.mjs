// shift_reason.mjs — when a Start Date change pushes the item later, Buildertrend requires a "Shift Reason".
// pickShiftReason(page, name, log) selects `name` in the Shift Reason field of the open schedule-item editor,
// creating it first with the field's "Add" button when it does not exist yet (Victor, 11/19/26: option 1).
// Returns true when the field is absent (no reason needed) or the reason is selected.
export async function pickShiftReason(page, name, log = () => {}) {
  const label = page.locator('label', { hasText: /^Shift Reason/ }).first();
  if (!(await label.count()) || !(await label.isVisible().catch(() => false))) return true;
  const item = label.locator('xpath=ancestor::*[contains(@class,"ant-form-item") or contains(@class,"ant-row")][1]');
  const select = item.locator('.ant-select').first();
  const openList = async () => { await select.click(); await page.waitForTimeout(800); };
  const options = async () => page.locator('.ant-select-dropdown:visible .ant-select-item-option').allInnerTexts();
  await openList();
  let opts = await options(); log(`shift reasons: ${opts.join(' | ')}`);
  if (!opts.some((o) => o.trim() === name)) {
    await page.keyboard.press('Escape');
    await item.getByRole('button', { name: /^add$/i }).first().click();
    await page.waitForTimeout(1500);
    const dlg = page.locator('.ant-modal:visible').last();
    log(`add dialog: ${(await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
    const input = dlg.locator('input[type=text], input:not([type]), textarea').first();
    await input.fill(name);
    await dlg.getByRole('button', { name: /^(save|add|ok|create)$/i }).first().click();
    await page.waitForTimeout(2500);
    await openList(); opts = await options(); log(`shift reasons after add: ${opts.join(' | ')}`);
  }
  const opt = page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: name }).first();
  if (!(await opt.count())) { await page.keyboard.press('Escape'); return false; }
  await opt.click(); await page.waitForTimeout(800);
  return true;
}
