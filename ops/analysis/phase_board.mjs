// Phase board (portal "Board" tab, Victor 2026-11-13): every job in one column by phase, with the
// days it has spent in that phase and the average time PKB jobs take in it.
//
// Phases, in order: licensing → waiting to start → the field manual's construction phases
// (foundation, walls, roof & frame, MEP, close-in, finishes, final stretch) → awaiting CO → done.
// Stand-by (status stand_by or an open pause) is a column of its own.
//
// When a job entered each phase:
//   licensing     contract signed / permit applied (earliest)
//   waiting       building permit issued
//   foundation    construction start (construction clock: 2nd draw paid, else BT start / 1st field inspection)
//   walls … final first pass of the inspection that closes the previous phase (PHASES[].re)
//   awaiting_co   last inspection passed (construction clock finishedAt)
//   done          CO date
// The job is in the furthest phase it has entered. A phase's average is the mean of the
// days between its entry and the next phase's entry, over PKB jobs that have both dates.

export const PHASES = [
  { key: 'licensing', label: 'Licensing' },
  { key: 'waiting', label: 'Waiting to start' },
  { key: 'foundation', label: 'Foundation' },
  { key: 'walls', label: 'Walls', re: /foundation pre-?pour|^mono\b|^(res )?slab\b/i },
  { key: 'roof', label: 'Roof & frame', re: /lintel|tie beam/i },
  { key: 'mep', label: 'MEP', re: /roof assembly|roof sheathing|roofing deck nailing|roofing dry-?in|roof dry in/i },
  { key: 'closein', label: 'Close-in', re: /^(framing|frame|structural frame)\b/i },
  { key: 'finishes', label: 'Finishes', re: /wire lath|lath nailing/i },
  { key: 'final', label: 'Final stretch', re: /pre ?power|preliminary power release/i },
  { key: 'awaiting_co', label: 'Awaiting CO' },
  { key: 'done', label: 'Done' },
];
export const STANDBY = { key: 'standby', label: 'Stand-by' };

const DAY = 864e5;
const iso = (x) => (x ? String(x).slice(0, 10) : null);
const days = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / DAY);
const min = (...xs) => xs.filter(Boolean).sort()[0] || null;

// x: { status, signed_at, co_at, pauses:[{reason, since, ended}] }, b: building permit {applied_at, issued_at, inspections:[{type, passed, at}]} or null,
// ck: construction clock result. Returns { phase, since, entries: {phase: date}, standby, standby_since }.
export function jobPhase(x, b, ck) {
  const passed = (b?.inspections || []).filter((i) => i.passed && i.at);
  const firstPass = (re) => passed.filter((i) => re.test(i.type || '')).map((i) => iso(i.at)).sort()[0] || null;
  const e = {
    licensing: min(iso(x.signed_at), iso(b?.applied_at)),
    waiting: iso(b?.issued_at),
    foundation: ck?.start ? iso(ck.start) : null,
    awaiting_co: ck?.finishedAt ? iso(ck.finishedAt) : null,
    done: iso(x.co_at),
  };
  for (const p of PHASES) if (p.re) e[p.key] = firstPass(p.re);

  let phase;
  if (ck?.phase === 'co' || (x.status === 'completed' && e.done)) phase = 'done';
  else if (ck?.phase === 'awaiting_co' || x.status === 'completed') phase = 'awaiting_co';
  else if (ck?.phase === 'building') {
    phase = 'foundation';
    for (const p of PHASES) if (p.re && e[p.key]) phase = p.key; // furthest construction phase entered (PHASES is in order)
    if (phase === 'foundation' && !e.foundation) e.foundation = e.waiting; // start unknown: count from issuance
  } else if (ck?.phase === 'waiting_to_start') phase = 'waiting';
  else phase = 'licensing';

  const open = (x.pauses || []).find((p) => !p.ended);
  const standby = x.status === 'stand_by' || !!open;
  return { phase, since: e[phase] || null, entries: e, standby, standby_since: open?.since || null };
}

// Mean days per phase over jobs that entered the phase and the next one (in order, both dated,
// next on/after this). A missing next entry (e.g. an inspection the county does not use) leaves the pair out.
export function phaseAverages(list) {
  const out = {};
  PHASES.forEach((p, k) => {
    const next = PHASES[k + 1];
    if (!next) return;
    const d = list.map((e) => (e[p.key] && e[next.key] && e[next.key] >= e[p.key] ? days(e[p.key], e[next.key]) : null)).filter((v) => v != null);
    out[p.key] = { avg: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null, n: d.length };
  });
  return out;
}
