// Construction time per phase, per county (Victor, 2026-10-14): how long PKB houses take in
// each phase, and which houses in progress are taking longer than the county's normal.
//
// Phases are cut at county inspection passes (first pass of each step, from the portal):
// the only dated milestones every house has. The 2nd-draw start date is not used here: it is
// a payment date and can be months off the field work (0001: 2nd draw 09/28, slab 03/05).
//   espera_inicio  permit issued        → first field inspection passed (pre-work/erosion excluded)
//   fundacao       first field pass     → slab / foundation pre-pour
//   paredes        slab                 → lintel / tie beam
//   telhado        lintel               → roof dry-in
//   instalacoes    dry-in               → framing (rough-ins pass with it)
//   isolamento     framing              → insulation
//   ligacoes       insulation           → water service (sewer, flatwork in between)
//   acabamento     water service        → first final inspection (no county inspection in between)
//   finais         first final          → building final
// Baselines are PKB houses only (same as the construction clock); a phase sample is dropped
// when its end passed before its start (steps done out of order). Pauses are not subtracted:
// a house with an open pause is left out of the "slower than normal" list instead.
//
// CLI: node ops/analysis/phase_times.mjs [--json out.json]   (reads Supabase via sb.mjs)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_SAMPLES = 5; // fewer finished houses in a phase → no baseline for it
const DAY = 864e5;
const iso = (s) => (s ? String(s).slice(0, 10) : null);
const days = (a, b) => Math.round((new Date(iso(b) + 'T12:00:00Z') - new Date(iso(a) + 'T12:00:00Z')) / DAY);
const quantile = (a, p) => {
  const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i);
  return Math.round(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo));
};

const STEP = {
  slab: /Foundation Pre-Pour|^Mono \/ Slab|^RES Slab/i,
  lintel: /Lintel/i,
  dryin: /Dry-In/i,
  frame: /^Framing$|^Frame$|^RES Framing/i,
  insul: /Insulation/i,
  water: /^Water Service/i,
  bfinal: /Final Structural|^Building Final|^RES Building Final/i,
};
export const PHASES = [
  { key: 'espera_inicio', name: 'espera para começar', from: 'issued', to: 'start' },
  { key: 'fundacao', name: 'fundação', from: 'start', to: 'slab' },
  { key: 'paredes', name: 'paredes', from: 'slab', to: 'lintel' },
  { key: 'telhado', name: 'telhado', from: 'lintel', to: 'dryin' },
  { key: 'instalacoes', name: 'instalações', from: 'dryin', to: 'frame' },
  { key: 'isolamento', name: 'isolamento', from: 'frame', to: 'insul' },
  { key: 'ligacoes', name: 'externo e ligações', from: 'insul', to: 'water' },
  { key: 'acabamento', name: 'acabamento interno', from: 'water', to: 'final1' },
  { key: 'finais', name: 'inspeções finais', from: 'final1', to: 'bfinal' },
];

// steps: [{name, final, passedAt}] (inspection_progress jobProgress().steps)
export function milestones(issuedAt, steps = []) {
  const first = (pred) => steps.filter((s) => s.passedAt && pred(s)).map((s) => iso(s.passedAt)).sort()[0] || null;
  const m = { issued: iso(issuedAt), start: first((s) => !s.final && !/pre-?work|erosion/i.test(s.name)), final1: first((s) => s.final) };
  for (const [k, re] of Object.entries(STEP)) m[k] = first((s) => re.test(s.name));
  return m;
}

// houses: [{job_number, county, company, ms}] → {county: {phase: {n, median, p25, p75}}}
export function baselines(houses) {
  const acc = {};
  for (const h of houses) {
    if (h.company !== 'PKB') continue;
    for (const p of PHASES) {
      if (!h.ms[p.from] || !h.ms[p.to]) continue;
      const v = days(h.ms[p.from], h.ms[p.to]);
      if (v >= 0) ((acc[h.county] ??= {})[p.key] ??= []).push(v);
    }
  }
  const out = {};
  for (const [c, ph] of Object.entries(acc)) {
    out[c] = {};
    for (const [k, a] of Object.entries(ph)) out[c][k] = { n: a.length, median: quantile(a, 0.5), p25: quantile(a, 0.25), p75: quantile(a, 0.75) };
  }
  return out;
}

// The phase a house is in now: the one after the furthest milestone it reached (a step with no
// recorded pass, e.g. water service done under another permit, does not hold the house back).
export function currentPhase(h, base, today) {
  if (!h.ms.issued || h.ms.bfinal) return null;
  const last = PHASES.reduce((m, x, i) => (h.ms[x.to] ? i : m), -1);
  const p = PHASES[last + 1];
  if (!p) return null;
  const b = base[h.county]?.[p.key];
  const inPhase = days(h.ms[p.from], today);
  const ok = b && b.n >= MIN_SAMPLES;
  return { phase: p.key, name: p.name, since: h.ms[p.from], days: inPhase, median: ok ? b.median : null, p75: ok ? b.p75 : null, n: b?.n || 0, delta: ok ? inPhase - b.median : null, slow: ok && inPhase > b.p75 };
}

// From the database: every building permit issued, with its inspections → baselines + houses.
export async function phaseTimesAll(today = new Date().toISOString()) {
  const { sql } = await import('../scripts/sb.mjs');
  const { progressAll } = await import('./inspection_progress.mjs');
  const prog = await progressAll();
  const jobs = await sql(`select j.job_number, j.address, j.county, j.company, j.status, c.issued_at,
      exists (select 1 from ops.job_pauses p where p.job_id = j.id and p.ended_at is null) paused
    from ops.jobs j join ops.permit_cases c on c.job_id = j.id and c.kind = 'building' where c.issued_at is not null`);
  const houses = jobs.map((j) => ({ ...j, ms: milestones(j.issued_at, prog.jobs[j.job_number]?.steps) }));
  const base = baselines(houses);
  for (const h of houses) h.current = ['construction', 'starting'].includes(h.status) ? currentPhase(h, base, iso(today)) : null;
  return { baselines: base, houses };
}

async function main() {
  const out = await phaseTimesAll();
  const i = process.argv.indexOf('--json');
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 1));
  else console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
