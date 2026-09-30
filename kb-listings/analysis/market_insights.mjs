#!/usr/bin/env node
// Product suggestions for the markets where we have listings: which floor plan (beds/baths),
// size, price band, new construction premium and features sell fastest — from kb.market_comps.
// Upserts kb.suggestions (one per market × kind) and prints / writes a markdown summary.
//   node analysis/market_insights.mjs [--days 180] [--md data/reports/market.md] [--dry-run]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { areaLabel, inMarket, productSuggestions } from '../lib/market.mjs';
import { q, sql } from '../lib/db.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DRY = process.argv.includes('--dry-run');
const days = Number(arg('--days', 180));

const listings = await sql(`select * from kb.listings where status in ('coming_soon', 'active', 'pending')`);
const comps = await sql(`select * from kb.market_comps where coalesce(sold_at, pending_at, listed_at, imported_at::date) > current_date - ${days + 30}`);
const areas = new Map();
for (const l of listings) { const name = areaLabel(l); if (!areas.has(name)) areas.set(name, comps.filter((c) => inMarket(l, c))); }

const lines = [`# Sugestões de produto — ${new Date().toISOString().slice(0, 10)} (últimos ${days} dias)`, ''];
for (const [area, cs] of areas) {
  const s = productSuggestions(area, cs, { days });
  lines.push(`## ${area} — ${cs.length} comps`, '');
  if (!s.length) lines.push('_Amostra insuficiente — importe um export do MLS com vendidos/pending desta área._', '');
  for (const x of s) {
    lines.push(`- **${x.title}** — ${x.detail}`);
    if (DRY) continue;
    await sql(`insert into kb.suggestions (key, area, kind, title, detail, evidence) values (${q(x.key)}, ${q(x.area)}, ${q(x.kind)}, ${q(x.title)}, ${q(x.detail)}, ${q(JSON.stringify(x.evidence))}::jsonb)
      on conflict (key) do update set title = excluded.title, detail = excluded.detail, evidence = excluded.evidence, updated_at = now(),
        status = case when kb.suggestions.title = excluded.title then kb.suggestions.status else 'new' end`);
  }
  lines.push('');
}
const md = lines.join('\n');
console.log(md);
const out = arg('--md');
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md); }
