// dailylog_done.mjs — which schedule items the Daily Logs say are DONE (config/bt_schedule_dailylog.json).
// doneFromLogs(logs) → Map(itemRegexSource → { date, by, text }) with the earliest log that says it.
import { readFileSync } from 'node:fs';

export const VOCAB = JSON.parse(readFileSync(new URL('../config/bt_schedule_dailylog.json', import.meta.url), 'utf8'));
const DONE = new RegExp(VOCAB.done, 'i'), NOT = new RegExp(VOCAB.not, 'i');
const ITEMS = VOCAB.items.map((x) => ({ ...x, itemRe: new RegExp(x.item, 'i'), wordsRe: new RegExp(x.words, 'gi'), notRe: x.not ? new RegExp(x.not, 'i') : null }));

// Bullet points / sentences of a log.
export const fragments = (text) => String(text || '')
  .split(/\r?\n|(?:^|\s)[-*•]\s+|[;!]|\.\s+(?=[A-ZÀ-Ú])|\s+[–—]\s+|\s\/\s?|\/\s/)
  .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 3);

export function doneFromLogs(logs) {
  const found = new Map();
  const sorted = [...logs].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const l of sorted) for (const frag of fragments(`${l.title || ''}\n${l.notes || ''}`)) {
    let f = frag;
    if (!DONE.test(f) || NOT.test(f)) continue;
    for (const it of ITEMS) {
      it.wordsRe.lastIndex = 0;
      if (!it.wordsRe.test(f)) continue;
      if (it.notRe && it.notRe.test(f)) { f = f.replace(new RegExp(it.words, 'gi'), ' '); continue; }
      if (!found.has(it.item)) found.set(it.item, { date: l.date, by: l.by, text: frag.slice(0, 160) });
      f = f.replace(new RegExp(it.words, 'gi'), ' ');   // a more specific item (stucco grading) hides the generic one (stucco)
    }
  }
  return found;
}
export const itemsFor = (title) => ITEMS.filter((x) => x.itemRe.test(String(title || '').trim()));
