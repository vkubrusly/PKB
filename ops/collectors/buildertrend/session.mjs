// =============================================================================
// session.mjs — open Buildertrend with a seeded browser session.
//
// Buildertrend's login page requires a reCAPTCHA, so the bot never types a
// password. Instead a person logs the bot user in once (any Chrome) and exports
// the cookies for buildertrend.net as JSON (Cookie-Editor → Export → JSON).
// Point BT_COOKIES_FILE at that file. The file is a credential: keep it out of
// the repo (see .gitignore) and rotate it by re-exporting when the session dies.
//
// Exports: openBuildertrend() → { browser, ctx, page, loggedIn }
// =============================================================================
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

// Cookie-Editor export → Playwright cookie objects.
export function cookiesFromExport(path) {
  let raw = JSON.parse(readFileSync(path, 'utf8').trim());
  if (typeof raw === 'string') raw = JSON.parse(raw);           // pasted as a quoted JSON string
  if (raw && !Array.isArray(raw) && Array.isArray(raw.cookies)) raw = raw.cookies; // {cookies:[...]} exports
  if (!Array.isArray(raw)) {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 5).join(', ') : typeof raw;
    throw new Error(`BT cookies are not a Cookie-Editor JSON array (got ${keys}). Export again with Cookie-Editor → Export → JSON, without encryption.`);
  }
  const sameSite = (v) => ({ strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' }[String(v || '').toLowerCase()] || 'Lax');
  return raw.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
    httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: sameSite(c.sameSite),
  }));
}

export async function openBuildertrend({ headless = true } = {}) {
  const file = process.env.BT_COOKIES_FILE;
  if (!file || !existsSync(file)) throw new Error('BT_COOKIES_FILE not set or missing (export the bot session cookies first)');
  const browser = await chromium.launch({ executablePath: EXEC, headless, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
  await ctx.addCookies(cookiesFromExport(file));
  const page = await ctx.newPage();
  await page.goto('https://buildertrend.net/app/Landing', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const loggedIn = !/login\.buildertrend\.com/.test(page.url());
  return { browser, ctx, page, loggedIn };
}
