// Construction clock per job: when the build started, how long it has been going,
// and how long the job waited between permit issued and start.
//
// Start date (rule set by Victor, 2026-09-29): the construction clock starts when the
// 2nd invoice (2nd installment) is paid. Date of that payment, first available of:
//   1. 2nd draw date on the control sheet (the payment date)
//   2. Buildertrend "invoice paid" e-mail for the 2nd Installment (bot mailbox) — only when
//      the sheet has no date: the e-mail arrives when someone updates the invoice, which
//      can be long after the payment
// When it was paid before the permit was issued, the clock starts at issuance (no work
// before the permit). Only when there is no 2nd payment on record: Buildertrend
// "Actual Start" (if on/after issuance), then the first field inspection on the portal.
// A job with the permit issued and no start is "waiting to start". When it has an open
// pause (owner deferred start, waiting 1st draw / impact fees / warranty deed) the wait
// is not PKB's and is left out of the CEO numbers.

const DAY = 864e5;
const d = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00Z') : null);
const days = (a, b) => Math.round((d(b) - d(a)) / DAY);
const iso = (x) => (x ? String(x).slice(0, 10) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
export const NOT_OUR_FAULT = ['owner_deferred_start', 'awaiting_1st_draw', 'awaiting_impact_fees', 'awaiting_warranty_deed'];

// job: {status, bt_closed, issued_at, co_at, bt_actual_start, bt_actual_completion, second_invoice_paid_at, second_draw_at, pauses:[{reason, since, ended}],
//       inspections:[{type, at}]}
export function clock(job, asOf) {
  const today = iso(asOf || new Date().toISOString());
  const issued = iso(job.issued_at);
  if (!issued) return { phase: 'no_permit' };
  const field = (job.inspections || [])
    .filter((i) => i.at && iso(i.at) >= issued && !/pre-?work|erosion/i.test(i.type || ''))
    .map((i) => iso(i.at)).sort()[0] || null;
  let start = null, source = null;
  const paid2 = iso(job.second_draw_at) || iso(job.second_invoice_paid_at);
  if (paid2) { start = paid2 >= issued ? paid2 : issued; source = paid2 >= issued ? 'second_draw' : 'second_draw_before_permit'; }
  // Fallbacks when no 2nd payment is on record. Buildertrend fills Actual Start from the
  // schedule (often the contract date): it only counts when on or after the permit issue date.
  else if (job.bt_actual_start && iso(job.bt_actual_start) >= issued) { start = iso(job.bt_actual_start); source = 'buildertrend'; }
  else if (field) { start = field; source = 'first_inspection'; }
  const openPause = (job.pauses || []).find((p) => !p.ended && NOT_OUR_FAULT.includes(p.reason));
  // Construction is finished when Buildertrend (or the control sheet) marks the job completed;
  // the CO comes after and closes the permit. End date: Buildertrend Actual Completion when it
  // is already in the past, else the last passed inspection.
  const completed = job.status === 'completed' || job.bt_closed;
  const lastPass = (job.inspections || []).filter((i) => i.passed && i.at).map((i) => iso(i.at)).sort().pop() || null;
  const btDone = job.bt_actual_completion && iso(job.bt_actual_completion) <= today ? iso(job.bt_actual_completion) : null;
  const finishedAt = completed ? (btDone || lastPass || null) : null;
  const finishSource = completed ? (btDone ? 'buildertrend' : lastPass ? 'last_inspection' : 'unknown') : null;
  const end = finishedAt || iso(job.co_at) || today;
  if (!start && (job.status === 'construction' || completed)) {
    // Marked as building (or finished) but no dated evidence yet — e.g. Citrus before its
    // inspections are collected. Counted as started; clock unknown.
    return { phase: completed ? (job.co_at ? 'co' : 'awaiting_co') : 'building', issued, start: null, startSource: 'unknown', waitToStart: null, buildDays: null, issuedToNow: days(issued, end), finishedAt, finishSource, coAt: iso(job.co_at) };
  }
  if (!start) {
    return { phase: 'waiting_to_start', issued, waitingDays: days(issued, today), excused: !!openPause, excuse: openPause?.reason || null };
  }
  return {
    phase: completed ? (job.co_at ? 'co' : 'awaiting_co') : 'building', issued, start, startSource: source,
    waitToStart: days(issued, start), buildDays: completed && !finishedAt ? null : days(start, end), issuedToNow: days(issued, iso(job.co_at) || end),
    finishedAt, finishSource, coAt: iso(job.co_at), daysAwaitingCO: completed && !job.co_at && finishedAt ? days(finishedAt, today) : null,
  };
}

// CEO summary over many clocks (jobs already excluding Prime if wanted).
export function summarize(clocks) {
  const building = clocks.filter((c) => c.phase === 'building');
  const done = clocks.filter((c) => c.phase === 'awaiting_co' || c.phase === 'co');
  const waiting = clocks.filter((c) => c.phase === 'waiting_to_start');
  const started = [...building, ...done];
  return {
    building: building.length, done: done.length, awaitingCO: clocks.filter((c) => c.phase === 'awaiting_co').length,
    waiting: waiting.length, waitingExcused: waiting.filter((c) => c.excused).length,
    medianWaitToStart: median(started.filter((c) => c.waitToStart != null).map((c) => c.waitToStart)),
    startUnknown: started.filter((c) => c.startSource === 'unknown').length,
    medianBuildDaysSoFar: median(building.filter((c) => c.buildDays != null).map((c) => c.buildDays)),
    medianBuildDaysDone: median(done.filter((c) => c.buildDays != null).map((c) => c.buildDays)),
    medianIssuedToCO: median(clocks.filter((c) => c.coAt).map((c) => c.issuedToNow)),
    medianFinishToCO: median(clocks.filter((c) => c.coAt && c.finishedAt).map((c) => days(c.finishedAt, c.coAt))),
    longestBuilding: building.filter((c) => c.buildDays != null).sort((a, b) => b.buildDays - a.buildDays).slice(0, 5),
  };
}
