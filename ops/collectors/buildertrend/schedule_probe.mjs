#!/usr/bin/env node
// schedule_probe.mjs — READ-ONLY look at one job's Schedule in Buildertrend, to design marking the
// construction phases (Victor, 2026-10-19: phases live in the job Schedules). Prints the API calls the
// Schedule page makes (url, method, a sample of the JSON), the schedule items (title, phase, dates,
// complete flag, ids) and, for one item, the controls its detail window offers. Changes nothing:
// no click on save/complete, the detail window is closed with Escape.
//   BT_COOKIES_FILE=… node collectors/buildertrend/schedule_probe.mjs <buildertrend job id>
import { openBuildertrend } from './session.mjs';

const jobIds = (process.argv[2] || '44609047').split(/[,\s]+/).filter(Boolean); // 0031 by default
const jobId = jobIds[0];
const section = (t, s) => console.log(`\n===== ${t} =====\n${s}`);
const shape = (o, depth = 0) => {
  if (Array.isArray(o)) return o.length ? [`array(${o.length})`, shape(o[0], depth + 1)] : 'array(0)';
  if (o && typeof o === 'object') { if (depth > 3) return '{…}'; const r = {}; for (const [k, v] of Object.entries(o).slice(0, 40)) r[k] = shape(v, depth + 1); return r; }
  return typeof o === 'string' ? `"${o.slice(0, 60)}"` : o;
};

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const calls = [];
// any request the detail window makes (to learn the update / complete endpoint without calling it)
page.on('request', (r) => { if (/\/api(x)?\//i.test(r.url()) && /schedul|calendar/i.test(r.url()) && !/CalendarList/i.test(r.url())) console.log(`[request] ${r.method()} ${r.url().slice(0, 200)}`); });
page.on('response', async (r) => {
  const u = r.url();
  if (!/buildertrend\.net\/(api|apix)\//i.test(u) || !/schedul|calendar|phase|gantt/i.test(u)) return;
  const j = await r.json().catch(() => null);
  calls.push({ method: r.request().method(), url: u.slice(0, 250), status: r.status(), body: (r.request().postData() || '').slice(0, 600), shape: j ? JSON.stringify(shape(j)).slice(0, 2500) : null, json: j });
});

let listReq = null;
page.on('request', (r) => { if (!listReq && /\/api\/calendar\/CalendarList/i.test(r.url())) listReq = { url: r.url(), headers: r.headers(), body: r.postData() }; });
await page.goto(`https://buildertrend.net/app/Schedules/List?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 60 && !listReq; i++) await page.waitForTimeout(500);
await page.waitForTimeout(4000);
// Every item of each job: replay the page's own CalendarList call month by month (read-only POST that lists).
if (listReq) {
  const headers = Object.fromEntries(Object.entries(listReq.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
  for (const id of jobIds) {
    const seen = new Map();
    for (let k = -8; k <= 6; k++) {
      const d = new Date(Date.UTC(2026, 9 + k, 1)).toISOString().slice(0, 10) + 'T00:00:00';
      const body = { ...JSON.parse(listReq.body), startDate: d, selectedJobIds: [Number(id)], perDayLimit: 100 };
      const res = await page.request.post(listReq.url, { headers: { ...headers, 'content-type': 'application/json' }, data: JSON.stringify(body) });
      const j = await res.json().catch(() => null);
      for (const it of j?.data?.calendarItems || []) seen.set(it.id, it);
      if (k === 0) section(`job ${id} phases`, JSON.stringify(j?.data?.phases || []).slice(0, 1500));
    }
    const items = [...seen.values()].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    section(`job ${id} all items (${items.length})`, items.map((it) => `${it.id} | ${String(it.title).trim()} | ${String(it.startDate).slice(0, 10)} → ${String(it.endDate).slice(0, 10)} | completed=${it.completed} | phase=${it.phaseId} | type=${it.type}`).join('\n'));
  }
} else section('CalendarList', 'request not seen');
await browser.close();
