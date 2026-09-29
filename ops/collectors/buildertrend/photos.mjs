#!/usr/bin/env node
// =============================================================================
// photos.mjs — when each Buildertrend job last got a site photo, and from whom.
//   BT_COOKIES_FILE=... node collectors/buildertrend/photos.mjs [jobId ...]
// Light by design (about 3 small JSON calls per job, no images, no full listing):
//   1. MainDirectory → top folders with photo count and last-modified date;
//      the special "** Attached Photos **" folder is opened one level to see its
//      sub-folders (Daily Logs, Bills, …).
//   2. Only the most recently modified site folder is listed, to read the newest
//      photo's upload time, uploader and Daily Log.
// Pictures of paperwork (bills, receipts, POs) are not site photos and are ignored.
// Writes data/buildertrend/photos.json. Read-only.
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'buildertrend');
mkdirSync(OUT, { recursive: true });
const PAPERWORK = /bills|proofs? of purchase|purchase orders?|invoices?|receipts?|change orders?|selections|bids/i;

const only = process.argv.slice(2).map(String);
const jobs = JSON.parse(readFileSync(join(OUT, 'jobs.json'), 'utf8')).jobs.filter(j => !only.length || only.includes(String(j.id)));

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired — re-export the bot cookies'); process.exit(1); }

// Buildertrend rate-limits bursts (429): pace the calls and wait when told to.
// A folder the bot's role cannot open answers 403 and is skipped.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(path) {
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(400);
    r = await page.request.get('https://buildertrend.net' + path);
    if (r.status() !== 429) break;
    await sleep(Math.min(Number(r.headers()['retry-after']) || 5 * 2 ** attempt, 30) * 1000);
  }
  if (r.status() === 403) return null;
  if (!r.ok()) throw new Error(`${r.status()} ${path}`);
  const b = await r.json();
  if (b.needsToRelogin) throw new Error('session expired');
  return b.data;
}
const dir = (jobId, f) => get(`/api/MediaFolders/GetDirectoryDetails?mediaType=2&folderId=${f.folderId}&associatedTypeId=${f.specialFolderExtraData?.folderAssociatedType ?? 0}&directoryType=${f.directoryType ?? 0}&jobId=${jobId}&filters=%7B%7D`);

const out = [];
for (const j of jobs) {
  try {
    const main = await get(`/api/MediaFolders/MainDirectory?mediaType=2&folderId=0&associatedTypeId=0&directoryType=0&jobId=${j.id}`);
    const folders = [];
    for (const f of main?.folders || []) {
      if (!f.totalDocumentCount) continue;
      if (f.specialFolderExtraData?.isSpecialFolder && f.folderId < 0) {
        const d = await dir(j.id, f);
        for (const s of d?.folders || []) if (s.totalDocumentCount) folders.push({ ...s, path: `Attached Photos / ${s.title}` });
      } else folders.push({ ...f, path: f.title });
    }
    const site = folders.filter(f => !PAPERWORK.test(f.path)).sort((a, b) => (b.dateModified || '').localeCompare(a.dateModified || ''));
    const row = { bt_job_id: j.id, name: j.name, count: site.reduce((n, f) => n + f.totalDocumentCount, 0), last_at: null, last_by: null, last_folder: null, last_daily_log: null };
    if (site[0]) {
      const d = await dir(j.id, site[0]);
      const newest = (d?.files || []).filter(f => !f.dateDeleted).sort((a, b) => (b.dateAttached || '').localeCompare(a.dateAttached || ''))[0];
      const a = newest?.associatedEntities?.[0];
      Object.assign(row, {
        last_at: newest?.dateAttached || site[0].dateModified, last_by: newest?.addedBy || null, last_folder: site[0].path,
        last_daily_log: a?.associatedType === 27 ? a.associatedEntityTitle : null,
      });
    }
    out.push(row);
    if (out.length % 10 === 0) console.log(`… ${out.length}/${jobs.length}`);
  } catch (e) { console.error(`${j.name}: ${e.message}`); if (/session expired/.test(e.message)) break; }
}
await browser.close();
writeFileSync(join(OUT, 'photos.json'), JSON.stringify({ collectedAt: new Date().toISOString(), jobs: out }, null, 1));
console.log(`photos: last upload read for ${out.length}/${jobs.length} jobs`);
