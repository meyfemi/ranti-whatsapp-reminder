import type { Reminder } from '../db/schema.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'this', 'that', 'for', 'of', 'to', 'on', 'at', 'in',
  'reminder', 'reminders', 'remind', 'one', 'about', 'please', 's',
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t));
}

export type TargetResolution =
  | { kind: 'found'; reminder: Reminder }
  | { kind: 'ambiguous'; candidates: Reminder[] }
  | { kind: 'none'; message: string };

/**
 * Resolves "#4" or "the dues reminder" to one active reminder. Deterministic: the LLM may
 * suggest a short ID, but it must exist; descriptions are matched by word overlap with titles.
 */
export function resolveTarget(
  active: Reminder[],
  target: { short_id: number | null; description: string | null },
): TargetResolution {
  if (target.short_id !== null) {
    const r = active.find((x) => x.shortId === target.short_id);
    if (r) return { kind: 'found', reminder: r };
    if (!target.description) return { kind: 'none', message: `I couldn't find an active reminder #${target.short_id}.` };
  }
  const wanted = tokens(target.description ?? '');
  if (wanted.length === 0) {
    return { kind: 'none', message: 'Which reminder do you mean? You can use its number, e.g. #4.' };
  }
  const scored = active
    .map((r) => {
      const title = new Set(tokens(`${r.title} ${r.kind}`));
      const score = wanted.filter((w) => title.has(w) || [...title].some((t) => t.startsWith(w) || w.startsWith(t))).length;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: 'none', message: "I couldn't find a reminder matching that. Try listing them first." };
  const best = scored.filter((x) => x.score === scored[0]!.score);
  if (best.length === 1) return { kind: 'found', reminder: best[0]!.r };
  return { kind: 'ambiguous', candidates: best.map((x) => x.r).slice(0, 5) };
}
