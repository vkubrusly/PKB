// =============================================================================
// lead.mjs — create a Lead Opportunity in Buildertrend (Sales → Lead Opportunities → "Lead
// Opportunity") from a website work request: client contact, title, address, salespeople,
// estimated revenue, source, notes. Skips when a lead with the same key (parcel / client)
// already exists. stopBeforeSave fills everything (contact window filled, then cancelled)
// and returns without saving — for tests.
// =============================================================================
const LIST = 'https://buildertrend.net/app/leads/opportunities';
const hideBanners = (page) => page.evaluate(() => document.getElementById('chmln-dom')?.remove()).catch(() => {});

async function openList(page) {
  for (let k = 0; k < 3; k++) {
    await page.goto(LIST, { waitUntil: 'domcontentloaded' });
    if (await page.locator('button', { hasText: /^\W*Lead Opportunity\s*$/ }).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false)) { await hideBanners(page); return; }
    await page.waitForTimeout(5000);   // e.g. a PostLogin redirect: try again
  }
  throw new Error('Lead Opportunities list did not load');
}

// close an open dropdown without Escape (Escape on the form asks "discard changes?")
const closeDropdown = (page) => page.locator('.ant-modal-content:has(#name) .ant-modal-title, .ant-modal-content:has(#name) h1, .ant-modal-content:has(#name) h2').first().click({ force: true }).catch(() => {});

async function pickOption(page, inputId, text) {
  const box = page.locator(`[id="${inputId}"]`).first();
  await box.click({ force: true });
  await page.waitForTimeout(700);
  await box.fill(text).catch(() => {});
  await page.waitForTimeout(1200);
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').locator('.ant-select-item-option, .ant-select-tree-treenode').filter({ hasText: text }).first();
  if (!(await opt.isVisible().catch(() => false))) { await closeDropdown(page); return false; }
  await opt.click({ force: true });
  await page.waitForTimeout(500);
  await closeDropdown(page);
  await page.waitForTimeout(400);
  return true;
}

export async function findLead(page, key) {
  if (!key) return false;
  await openList(page);
  const search = page.locator('#keywordSearch').first();
  if (!(await search.isVisible().catch(() => false))) return false;
  await search.fill(key); await search.press('Enter');
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText();
  return body.toLowerCase().includes(String(key).toLowerCase()) && !/no (lead opportunities|results)/i.test(body);
}

export async function createLead(page, d, { stopBeforeSave = false } = {}) {
  // d: { title, dedupeKey, contact: {first, last, display, phone, email, street, city, state, zip},
  //      address: {street, city, state, zip}, salespeople: [names], revenue, source, notes }
  if (d.dedupeKey && await findLead(page, d.dedupeKey)) return { duplicate: true };
  await openList(page);
  const newBtn = page.locator('button', { hasText: /^\W*Lead Opportunity\s*$/ }).first();
  let ok = false;
  for (let k = 0; k < 3 && !ok; k++) {
    await newBtn.click();
    ok = await page.locator('#name').first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    if (!ok) { await page.locator('button', { hasText: /^Ok$/ }).first().click().catch(() => {}); await page.waitForTimeout(3000); }
  }
  if (!ok) throw new Error('Add Lead Opportunity form did not load');
  await page.waitForTimeout(1500);
  await hideBanners(page);
  const form = page.locator('.ant-modal-content:has(#name)').first();

  await page.locator('#name').first().fill(String(d.title).slice(0, 100));
  const a = d.address || {};
  for (const [id, v] of [['address.street', a.street], ['address.city', a.city], ['address.state', a.state], ['address.zip', a.zip]]) if (v) await page.locator(`[id="${id}"]`).first().fill(String(v));
  if (d.revenue) for (const id of ['estimatedStartPrice', 'estimatedEndPrice']) await page.locator(`#${id}`).first().fill(String(d.revenue)).catch(() => {});

  // salespeople: the listed ones, then drop the default "Bot PKB" chip if someone else was added
  const added = [];
  for (const n of d.salespeople || []) if (await pickOption(page, 'salespeople', n)) added.push(n);
  if (added.length) {
    // the bot's own chip (Buildertrend marks it isCurrentUser)
    const botChip = form.locator('.ant-select-selection-item:has(.BTUser.isCurrentUser) .ant-select-selection-item-remove').first();
    if (await botChip.count()) { await botChip.click({ force: true }); await page.waitForTimeout(500); await closeDropdown(page); }
  }
  const sourceOk = d.source ? await pickOption(page, 'source', d.source) : false;

  // notes: rich-text editor inside the form
  if (d.notes) {
    const ed = form.locator('[contenteditable="true"]').first();
    if (await ed.isVisible().catch(() => false)) { await ed.click(); await page.keyboard.insertText(String(d.notes).slice(0, 3800)); }
  }

  // client contact
  let contactSaved = false;
  if (d.contact && (d.contact.display || d.contact.first)) {
    await form.locator('#newContactInfoEmptyState, [data-testid="newContactInfoEmptyState"]').first().click();
    await page.locator('#displayName').first().waitFor({ timeout: 20000 });
    const c = d.contact;
    // display name: Buildertrend builds it from first + last; only set it when there is no name
    for (const [id, v] of [['firstName', c.first], ['lastName', c.last], ['displayName', c.first || c.last ? null : c.display], ['address.street', c.street], ['address.city', c.city], ['address.state', c.state], ['address.zip', c.zip], ['phonePrimary', c.phone], ['primaryEmail.emailAddress', c.email]]) {
      if (!v) continue;
      await page.locator('.ant-modal-content').last().locator(`[id="${id}"]`).first().fill(String(v));
    }
    const cm = page.locator('.ant-modal-content').last();
    if (stopBeforeSave) await cm.locator('button', { hasText: /^Cancel$/ }).first().click();
    else { await cm.locator('button', { hasText: /^Save$/ }).first().click(); contactSaved = true; }
    await page.waitForTimeout(3000);
  }

  const chips = await form.locator('#salespeople').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').locator('.BTUser .text-overflow-auto').allInnerTexts().catch(() => []);
  const filled = { title: await page.locator('#name').first().inputValue(), salespeople: chips.length ? chips : added, source: sourceOk ? d.source : null, contact: contactSaved || (stopBeforeSave ? 'filled, not saved (test)' : false) };
  if (stopBeforeSave) return { stopped: true, ...filled };

  await form.locator('.ant-modal-footer button, button').filter({ hasText: /^Save$/ }).first().click();
  await page.waitForTimeout(6000);
  const err = await page.locator('.ant-form-item-explain-error').allInnerTexts().catch(() => []);
  if (err.length) throw new Error('Buildertrend did not save the lead: ' + err.join('; '));
  const m = page.url().match(/Lead\/(\d+)/);
  return { saved: true, leadId: m && m[1] !== '0' ? Number(m[1]) : null, url: page.url(), ...filled };
}
