// dailylog_done.mjs — which schedule items the Daily Logs say are DONE (config/bt_schedule_dailylog.json).
// doneFromLogs(logs) → Map(itemRegexSource → { date, exact, by, text }): the earliest day any log says it was done.
// Victor 11/20/26: only a log that says the work WAS done counts (no future, scheduling or inspection sentences,
// not the bot's own logs). 'exact' = the day the text gives for the work ('10/02', 'Saturday 10/03',
// 'last Friday', 'ontem'), else the log day; null when the text names a day that cannot be read with certainty.
import { readFileSync } from 'node:fs';

export const VOCAB = JSON.parse(readFileSync(new URL('../config/bt_schedule_dailylog.json', import.meta.url), 'utf8'));
// Word boundaries that also work next to accented letters ('será', 'concluído'): JavaScript's \b does not.
const W = 'A-Za-zÀ-ÿ0-9_';
const words = (src, flags = 'i') => new RegExp(String(src).replace(/^\\b/, `(?<![${W}])`).replace(/\\b$/, `(?![${W}])`), flags);
const DONE = words(VOCAB.done), NOT = words(VOCAB.not);
const ITEMS = VOCAB.items.map((x) => ({ ...x, itemRe: new RegExp(x.item, 'i'), wordsRe: new RegExp(x.words, 'gi'), notRe: x.not ? new RegExp(x.not, 'i') : null }));
const BOT = /\bbot\b/i;   // the bot's own logs (inspection results it posts) are not a person saying the work was done

// Bullet points / sentences of a log.
export const fragments = (text) => String(text || '')
  .split(/\r?\n|(?:^|\s)[-*•]\s+|[;!]|\.\s+(?=[A-ZÀ-Ú])|\s+[–—]\s+|\s\/\s?|\/\s/)
  .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 3);

// Portuguese weekdays only as days ('segunda-feira', 'na sexta'), never 'segunda camada' / 'quarta parte'.
const PT = (w) => `(?:${w}-?\\s?feira|(?:na|no|última|ultima|desta|nesta|essa|esta) ${w})`;
const DAYS = [/\b(sunday|domingo)\b/i, new RegExp(`\\b(monday|${PT('segunda')})`, 'i'), new RegExp(`\\b(tuesday|${PT('ter[cç]a')})`, 'i'),
  new RegExp(`\\b(wednesday|${PT('quarta')})`, 'i'), new RegExp(`\\b(thursday|${PT('quinta')})`, 'i'), new RegExp(`\\b(friday|${PT('sexta')})`, 'i'),
  /\b(saturday|s[aá]bado)/i];
const iso = (d) => d.toISOString().slice(0, 10);
// The work day the fragment gives, relative to the log day. undefined = no day named (→ the log day);
// null = a day is named but not certain.
export function workDate(frag, logDate) {
  const log = new Date(String(logDate).slice(0, 10) + 'T12:00:00Z');
  const back = (n) => { const d = new Date(log); d.setUTCDate(d.getUTCDate() - n); return d; };
  const cands = [];
  for (const m of frag.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    for (const [mo, da] of [[a, b], [b, a]]) {
      if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
      let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : log.getUTCFullYear();
      let d = new Date(Date.UTC(y, mo - 1, da, 12));
      if (!m[3] && d > log) d = new Date(Date.UTC(y - 1, mo - 1, da, 12));
      const age = (log - d) / 864e5;
      if (age >= 0 && age <= 21) cands.push(iso(d));
    }
  }
  const uniq = [...new Set(cands)];
  if (/\d{1,2}\/\d{1,2}/.test(frag)) return uniq.length === 1 ? uniq[0] : null;
  if (/\b(ontem|yesterday)\b/i.test(frag)) return iso(back(1));
  const wd = DAYS.findIndex((re) => re.test(frag));
  if (wd >= 0) { for (let n = 0; n <= 7; n++) if (back(n).getUTCDay() === wd) return iso(back(n)); }
  if (/\b(last week|semana passada)\b/i.test(frag)) return null;
  return undefined;
}

export function doneFromLogs(logs) {
  const found = new Map();
  const sorted = [...logs].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const l of sorted) {
    if (BOT.test(String(l.by || ''))) continue;
    for (const frag of fragments(`${l.title || ''}\n${l.notes || ''}`)) {
      let f = frag;
      if (!DONE.test(f) || NOT.test(f)) continue;
      for (const it of ITEMS) {
        it.wordsRe.lastIndex = 0;
        if (!it.wordsRe.test(f)) continue;
        if (it.notRe && it.notRe.test(f)) { f = f.replace(new RegExp(it.words, 'gi'), ' '); continue; }
        // The FIRST time the work shows as done wins (Victor, 11/21/26): logs are often copy-pasted, so the same
        // "bollard instalado" comes back in later logs, and one log may list several dated lines. Every log and every
        // line is compared and the earliest day kept (the day the text gives, else the log day).
        const w = workDate(frag, l.date);
        const cand = { date: l.date, exact: w === undefined ? String(l.date).slice(0, 10) : w, by: l.by, text: frag.slice(0, 160) };
        const day = (x) => String(x.exact || x.date).slice(0, 10);
        const cur = found.get(it.item);
        if (!cur || day(cand) < day(cur)) found.set(it.item, cand);
        f = f.replace(new RegExp(it.words, 'gi'), ' ');   // a more specific item (stucco grading) hides the generic one (stucco)
      }
    }
  }
  return found;
}
export const itemsFor = (title) => ITEMS.filter((x) => x.itemRe.test(String(title || '').trim()));
