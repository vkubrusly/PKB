// Construction clock per job: when the build started, how long it has been going,
// and how long the job waited between permit issued and start.
//
// Start date, first available of:
//   1. Buildertrend "Actual Start" (when the supervisor fills it)
//   2. first field inspection on the county portal after issuance (not Pre-Work / Erosion)
//   3. 2nd draw date, only when it falls after the permit was issued (Citrus until its
//      inspections are collected)
// A job with the permit issued and no start is "waiting to start". When it has an open
// pause (owner deferred start, waiting 1st draw / impact fees / warranty deed) the wait
// is not PKB's and is left out of the CEO numbers.

const DAY = 864e5;
const d = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00Z') : null);
const days = (a, b) => Math.round((d(b) - d(a)) / DAY);
const iso = (x) => (x ? String(x).slice(0, 10) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
export const NOT_OUR_FAULT = ['owner_deferred_start', 'awaiting_1st_draw', 'awaiting_impact_fees', 'awaiting_warranty_deed'];

// job: {status, issued_at, co_at, bt_actual_start, second_draw_at, pauses:[{reason, since, ended}],
//       inspections:[{type, at}]}
export function clock(job, asOf) {
  const today = iso(asOf || new Date().toISOString());
  const issued = iso(job.issued_at);
  if (!issued) return { phase: 'no_permit' };
  const field = (job.inspections || [])
    .filter((i) => i.at && iso(i.at) >= issued && !/pre-?work|erosion/i.test(i.type || ''))
    .map((i) => iso(i.at)).sort()[0] || null;
  let start = null, source = null;
  if (job.bt_actual_start) { start = iso(job.bt_actual_start); source = 'buildertrend'; }
  else if (field) { start = field; source = 'first_inspection'; }
  else if (job.second_draw_at && iso(job.second_draw_at) >= issued) { start = iso(job.second_draw_at); source = 'second_draw'; }
  const openPause = (job.pauses || []).find((p) => !p.ended && NOT_OUR_FAULT.includes(p.reason));
  const end = iso(job.co_at) || today;
  if (!start && ['construction', 'completed'].includes(job.status)) {
    // Marked as building (or finished) but no dated evidence yet — e.g. Citrus before its
    // inspections are collected. Counted as started; clock unknown.
    return { phase: job.status === 'completed' ? 'done' : 'building', issued, start: null, startSource: 'unknown', waitToStart: null, buildDays: null, issuedToNow: days(issued, end) };
  }
  if (!start) {
    return { phase: 'waiting_to_start', issued, waitingDays: days(issued, today), excused: !!openPause, excuse: openPause?.reason || null };
  }
  return {
    phase: job.co_at ? 'done' : 'building', issued, start, startSource: source,
    waitToStart: days(issued, start), buildDays: days(start, end), issuedToNow: days(issued, end), coAt: iso(job.co_at),
  };
}

// CEO summary over many clocks (jobs already excluding Prime if wanted).
export function summarize(clocks) {
  const building = clocks.filter((c) => c.phase === 'building');
  const done = clocks.filter((c) => c.phase === 'done');
  const waiting = clocks.filter((c) => c.phase === 'waiting_to_start');
  const started = [...building, ...done];
  return {
    building: building.length, done: done.length,
    waiting: waiting.length, waitingExcused: waiting.filter((c) => c.excused).length,
    medianWaitToStart: median(started.filter((c) => c.waitToStart != null).map((c) => c.waitToStart)),
    startUnknown: started.filter((c) => c.startSource === 'unknown').length,
    medianBuildDaysSoFar: median(building.filter((c) => c.buildDays != null).map((c) => c.buildDays)),
    medianBuildDaysDone: median(done.filter((c) => c.buildDays != null).map((c) => c.buildDays)),
    medianIssuedToCO: median(done.filter((c) => c.coAt).map((c) => c.issuedToNow)),
    longestBuilding: building.filter((c) => c.buildDays != null).sort((a, b) => b.buildDays - a.buildDays).slice(0, 5),
  };
}
