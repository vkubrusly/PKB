#!/usr/bin/env node
// daily_log_check.mjs — opens the "new Daily Log" form for a job and stops BEFORE publishing (nothing is
// saved): prints which job the form is on. Used to check the Prime jobs ("PRIME - …").
//   BT_COOKIES_FILE=… node collectors/buildertrend/daily_log_check.mjs <jobId> "<job name>" […]
import { openBuildertrend } from './session.mjs';
import { createDailyLog } from './daily_log.mjs';

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) {
  const r = await createDailyLog(page, { jobId: Number(a[i]), jobName: a[i + 1], title: 'check (not published)', notes: 'check', stopBeforePublish: true }).catch((e) => ({ error: e.message }));
  console.log(`${a[i + 1]} → ${JSON.stringify(r)}`);
}
await browser.close();
