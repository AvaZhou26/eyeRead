// Checks on articles sent by the browser extension (see ExtensionSync). Like validate.ts,
// it trusts nothing about the shape of what arrives.
import type { CoverageStatus, WebReading } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const STATUSES: CoverageStatus[] = ["read", "skimmed", "skipped"];
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const status = (v: unknown): CoverageStatus => (STATUSES.includes(v as CoverageStatus) ? (v as CoverageStatus) : "skipped");

/**
 * One article sent by the browser extension (its buildReport output). Returns null when it
 * isn't usable. Text is capped: we keep a short snippet per paragraph, not the article.
 */
export function checkWebReading(raw: unknown): Omit<WebReading, "id" | "userId" | "importedAt"> | null {
  if (!isObj(raw)) return null;
  let url: URL;
  try {
    url = new URL(String(raw.url ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A real moment between 2000 and tomorrow. Anything else is rejected: a number too big for
  // a date used to crash the whole import, and a far-future "last seen" would stop the
  // article ever being updated again (a newer copy only replaces an older one).
  const time = (v: unknown) => {
    const n = num(v, NaN);
    return Number.isFinite(n) && n >= EARLIEST_MS && n <= Date.now() + 86_400_000 ? new Date(n).toISOString() : null;
  };
  const firstSeen = time(raw.firstSeen), lastSeen = time(raw.lastSeen);
  if (!firstSeen || !lastSeen) return null;
  const paragraphs = arr(raw.paragraphs)
    .slice(0, 600)
    .filter(isObj)
    .map((p) => ({
      status: p.heading ? null : status(p.status),
      words: Math.round(num(p.words, 0, 0, 100_000)),
      text: String(p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
    }));
  const body = paragraphs.filter((p) => p.status);
  if (!body.length) return null;
  const wordsWith = (s: CoverageStatus) => body.filter((p) => p.status === s).reduce((t, p) => t + p.words, 0);
  const site = String(raw.site ?? url.hostname.replace(/^www\./, "")).slice(0, 100);
  // Coverage can't be more than the share of words in paragraphs that were at least skimmed.
  const totalWords = body.reduce((t, p) => t + p.words, 0);
  const seenPct = totalWords ? (100 * (wordsWith("read") + wordsWith("skimmed"))) / totalWords : 0;
  return {
    url: (url.origin + url.pathname).slice(0, 1000),
    title: String(raw.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || site,
    site,
    firstSeen,
    lastSeen,
    totalWords,
    coveragePct: Math.min(num(raw.coveragePct, 0, 0, 100), Math.round(seenPct * 10) / 10),
    activeSec: num(raw.activeSec, 0, 0, 7 * 86400),
    eyeSec: num(raw.eyeSec, 0, 0, 7 * 86400),
    wordsRead: wordsWith("read"),
    wordsSkimmed: wordsWith("skimmed"),
    wordsSkipped: wordsWith("skipped"),
    paragraphs,
  };
}
