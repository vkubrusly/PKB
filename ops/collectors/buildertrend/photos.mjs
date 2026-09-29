#!/usr/bin/env node
// =============================================================================
// photos.mjs — every photo and video uploaded to each Buildertrend job: when,
// by whom, in which folder, and the Daily Log it is attached to.
//   BT_COOKIES_FILE=... node collectors/buildertrend/photos.mjs [jobId ...]
// Reads data/buildertrend/jobs.json (list_jobs.mjs) and calls the same JSON
// endpoints the Photos/Videos pages use (MediaFolders/MainDirectory and
// GetDirectoryDetails), walking every folder including the special
// "** Attached Photos **" tree (Daily Logs, To-Dos, …). Read-only.
// Writes data/buildertrend/photos.json.
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'buildertrend');
mkdirSync(OUT, { recursive: true });
const MEDIA = { 2: 'photo' }; // videos are rare here and their folders use another endpoint
const ASSOCIATED = { 27: 'daily_log' };
// Pictures of paperwork (bills, receipts, POs) live in the same tree; they are not site photos.
const PAPERWORK = /bills|proofs? of purchase|purchase orders?|invoices?|receipts?|change orders?|selections|bids/i;

const only = process.argv.slice(2).map(String);
const jobs = JSON.parse(readFileSync(join(OUT, 'jobs.json'), 'utf8')).jobs.filter(j => !only.length || only.includes(String(j.id)));

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired — re-export the bot cookies'); process.exit(1); }
// Buildertrend rate-limits bursts: pace the calls and back off when told to.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = async (path) => {
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(700);
    r = await page.request.get('https://buildertrend.net' + path);
    // 429, and sometimes 403, answer a burst; both clear after a pause.
    if (![429, 403].includes(r.status())) break;
    const wait = Number(r.headers()['retry-after']) || 5 * 2 ** attempt;
    await sleep(Math.min(wait, 60) * 1000);
  }
  if (!r.ok()) throw new Error(`${r.status()} ${path}`);
  const b = await r.json();
  if (b.needsToRelogin) throw new Error('session expired');
  return b.data;
};

const files = [];
async function walk(jobId, media, folder, path, depth = 0) {
  if (depth > 6) return;
  const assoc = folder.specialFolderExtraData?.folderAssociatedType ?? 0;
  const d = folder.folderId === 0
    ? await get(`/api/MediaFolders/MainDirectory?mediaType=${media}&folderId=0&associatedTypeId=0&directoryType=0&jobId=${jobId}`)
    : await get(`/api/MediaFolders/GetDirectoryDetails?mediaType=${media}&folderId=${folder.folderId}&associatedTypeId=${assoc}&directoryType=${folder.directoryType ?? 0}&jobId=${jobId}&filters=%7B%7D`);
  for (const f of d.files || []) {
    if (f.dateDeleted) continue;
    const a = (f.associatedEntities || [])[0];
    files.push({
      bt_job_id: jobId, bt_document_id: f.documentInstanceId, media: MEDIA[media], title: f.friendlyFileName || f.title,
      folder: path.replace(/\*\*\s*/g, '').trim(), site: !PAPERWORK.test(path), added_by: f.addedBy || null,
      attached_at: f.dateAttached || null, taken_at: f.dateTaken || null,
      linked_type: a ? (ASSOCIATED[a.associatedType] || `type_${a.associatedType}`) : null,
      linked_id: a?.associatedEntityId ?? null, linked_title: a?.associatedEntityTitle ?? null,
    });
  }
  for (const sub of d.folders || []) {
    if (!sub.totalDocumentCount) continue;
    await walk(jobId, media, sub, path ? `${path} / ${sub.title}` : sub.title, depth + 1);
  }
}

let ok = 0;
for (const j of jobs) {
  try {
    for (const media of [2]) await walk(j.id, media, { folderId: 0 }, '');
    ok++;
  } catch (e) { console.error(`${j.name}: ${e.message}`); if (/session expired/.test(e.message)) break; }
}
await browser.close();

const byJob = {};
for (const f of files) (byJob[f.bt_job_id] ||= []).push(f);
const summary = jobs.map(j => {
  const fs = (byJob[j.id] || []).filter(f => f.site).sort((a, b) => (b.attached_at || '').localeCompare(a.attached_at || ''));
  return { bt_job_id: j.id, name: j.name, count: fs.length, last_30d: fs.filter(f => (f.attached_at || '') >= new Date(Date.now() - 30 * 864e5).toISOString()).length, last_at: fs[0]?.attached_at || null, last_by: fs[0]?.added_by || null };
});
writeFileSync(join(OUT, 'photos.json'), JSON.stringify({ collectedAt: new Date().toISOString(), jobs: summary, files }, null, 1));
console.log(`photos: ${files.length} files across ${ok}/${jobs.length} jobs`);
