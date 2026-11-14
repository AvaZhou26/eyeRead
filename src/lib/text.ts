// Text helpers shared by the server and the browser.

/** Split a paragraph into words exactly the same way everywhere (reader, report, server). */
export function splitWords(paragraph: string): string[] {
  return paragraph.split(/\s+/).filter(Boolean);
}

export function countWords(paragraphs: string[]): number {
  return paragraphs.reduce((n, p) => n + splitWords(p).length, 0);
}

/** A short line without ending punctuation is treated as a heading. */
export function isHeading(paragraph: string): boolean {
  const t = paragraph.trim();
  return t.length > 0 && t.length < 90 && !/[.!?:;,"”’)]$/.test(t) && splitWords(t).length <= 12;
}

/**
 * Turn pasted text into paragraphs. Blank lines separate paragraphs; if the text has
 * no blank lines at all, every line break is treated as a paragraph break.
 */
export function toParagraphs(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  if (!text) return [];
  const hasBlankLines = /\n\s*\n/.test(text);
  const blocks = hasBlankLines ? text.split(/\n\s*\n/) : text.split("\n");
  return blocks
    .map((b) =>
      b
        .replace(/(\w)-\n(\w)/g, "$1$2") // re-join hyphenated line breaks
        .replace(/\s*\n\s*/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** Estimated reading minutes at a typical college pace. */
export function estimateMinutes(wordCount: number, wpm = 240): number {
  return Math.max(1, Math.round(wordCount / wpm));
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Due dates are calendar days, not moments in time. We store them as noon UTC on the day the
 * professor picked and display them by their UTC date, so everyone sees the same day no
 * matter their timezone (older entries saved at midnight UTC also show the right day).
 */
export function formatDueDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Is a due date in the past? Compares calendar days: the due day (its UTC date, see
 * formatDueDate) against today's local date. A reading due today is not overdue yet.
 */
export function isPastDue(dueIso: string | null, now = new Date()): boolean {
  if (!dueIso) return false;
  const dueDay = new Date(dueIso).toISOString().slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return today > dueDay;
}

/** Turn a date-input value ("2026-11-20") into the stored due date (noon UTC that day). */
export function dueDateFromInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
