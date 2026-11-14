// Checks on data that arrives from the browser. Session reports are built in the reader
// (in the browser), so the server must not trust their shape: one malformed report used to
// crash the class pages for everyone. Everything here is plain data in, plain data out.
import type {
  CoverageStatus, DistractionEvent, ParagraphStat, Reading, ReadingState, ResumeState, SessionReport, StateSegment,
} from "./types";
import { countWords } from "./text";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const numOrNull = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const STATUSES: CoverageStatus[] = ["read", "skimmed", "skipped"];
const STATES: ReadingState[] = ["reading", "skimming", "pausing", "offtext", "away"];
const QUALITIES: SessionReport["calibrationQuality"][] = ["good", "fair", "poor", "attention-only"];
const KINDS: DistractionEvent["kind"][] = ["away", "offtext", "tab"];

const status = (v: unknown): CoverageStatus => (STATUSES.includes(v as CoverageStatus) ? (v as CoverageStatus) : "skipped");

/**
 * Read a JSON request body as an object. Returns null when the body isn't valid JSON or
 * isn't an object, so routes can answer 400 instead of crashing with a 500.
 */
export async function readJsonBody(req: Request): Promise<Obj | null> {
  try {
    const body: unknown = await req.json();
    return isObj(body) ? body : null;
  } catch {
    return null;
  }
}

/** A string field, or undefined when it's missing or the wrong type. */
export function strField(body: Obj, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

/** Parse an ISO timestamp sent by the browser; null when it isn't a real date. */
export function parseTimestamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function segment(v: unknown): StateSegment | null {
  if (!isObj(v) || !STATES.includes(v.state as ReadingState)) return null;
  const start = num(v.start);
  return { state: v.state as ReadingState, start, end: Math.max(start, num(v.end, start)) };
}

function distraction(v: unknown): DistractionEvent | null {
  if (!isObj(v) || !KINDS.includes(v.kind as DistractionEvent["kind"])) return null;
  return { kind: v.kind as DistractionEvent["kind"], start: num(v.start), durationSec: num(v.durationSec), paragraph: numOrNull(v.paragraph) };
}

function paragraphStat(v: unknown, index: number): ParagraphStat {
  const o = isObj(v) ? v : {};
  return {
    index,
    words: Math.round(num(o.words)),
    status: status(o.status),
    coverage: num(o.coverage, 0, 0, 1),
    dwellSec: num(o.dwellSec),
    expectedSec: num(o.expectedSec),
    rereads: Math.round(num(o.rereads, 0, 0, 1000)),
    wpm: numOrNull(o.wpm, 0, 5000),
  };
}

/**
 * Give a report every field the pages expect, with safe values where something is missing
 * or the wrong type. Used when loading sessions from the database, so an old or damaged
 * row can never crash a page.
 */
export function normalizeReport(raw: unknown): SessionReport {
  const o = isObj(raw) ? raw : {};
  const durationSec = num(o.durationSec);
  const activeSec = num(o.activeSec, durationSec, 0, durationSec);
  const wordStatus = arr(o.wordStatus).map(status);
  return {
    durationSec,
    activeSec,
    focusPct: num(o.focusPct, durationSec > 0 ? (activeSec / durationSec) * 100 : 100, 0, 100),
    coveragePct: num(o.coveragePct, 0, 0, 100),
    wordsRead: Math.round(num(o.wordsRead)),
    avgWpm: numOrNull(o.avgWpm, 0, 5000),
    baselineWpm: numOrNull(o.baselineWpm, 0, 5000),
    calibrationQuality: QUALITIES.includes(o.calibrationQuality as SessionReport["calibrationQuality"])
      ? (o.calibrationQuality as SessionReport["calibrationQuality"])
      : "attention-only",
    calibrationErrorPx: numOrNull(o.calibrationErrorPx),
    paragraphs: arr(o.paragraphs).map(paragraphStat),
    wordStatus,
    distractions: arr(o.distractions).map(distraction).filter((d): d is DistractionEvent => d !== null),
    timeline: arr(o.timeline).map(segment).filter((s): s is StateSegment => s !== null),
    nudges: Math.round(num(o.nudges)),
    pagesTurned: Math.round(num(o.pagesTurned)),
  };
}

/**
 * Check a report sent by the reader against the reading it claims to be about, and return
 * a clean copy. Returns an error message when it doesn't fit the reading.
 *
 * The headline numbers (coverage, words read) are recomputed here from the per-word
 * statuses instead of being taken on trust. This keeps a report consistent with itself;
 * it can't prove the student really read the words, because the measuring happens in
 * their browser.
 */
export function checkReport(raw: unknown, reading: Reading): { report: SessionReport } | { error: string } {
  if (!isObj(raw) || !Array.isArray(raw.paragraphs) || !Array.isArray(raw.wordStatus)) return { error: "Missing session report." };
  if (raw.paragraphs.length !== reading.paragraphs.length || raw.wordStatus.length !== countWords(reading.paragraphs))
    return { error: "This report doesn't match the reading. Reload the page and try again." };
  if (typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec < 0)
    return { error: "Missing session report." };

  const report = normalizeReport(raw);
  const read = report.wordStatus.filter((s) => s === "read").length;
  const skimmed = report.wordStatus.filter((s) => s === "skimmed").length;
  const total = Math.max(1, report.wordStatus.length);
  report.wordsRead = read;
  report.coveragePct = Math.round(((read + 0.5 * skimmed) / total) * 1000) / 10;
  report.focusPct = report.durationSec > 0 ? Math.round((report.activeSec / report.durationSec) * 1000) / 10 : 100;
  return { report };
}

/** Check the "pick up where you left off" state saved on Pause. Null when it's unusable. */
export function checkResume(raw: unknown, reading: Reading): ResumeState | null {
  const n = countWords(reading.paragraphs);
  if (!isObj(raw) || !Array.isArray(raw.wordDwell) || raw.wordDwell.length !== n) return null;
  const wordRereads = arr(raw.wordRereads);
  const regressions = arr(raw.regressions)
    .filter(isObj)
    .map((r) => ({ from: Math.round(num(r.from, 0, 0, Math.max(0, n - 1))), to: Math.round(num(r.to, 0, 0, Math.max(0, n - 1))) }))
    .filter((r) => r.from <= r.to);
  return {
    version: 1,
    elapsedSec: num(raw.elapsedSec),
    firstWord: Math.round(num(raw.firstWord, 0, 0, Math.max(0, n - 1))),
    wordDwell: raw.wordDwell.map((v) => num(v)),
    wordRereads: Array.from({ length: n }, (_, i) => Math.round(num(wordRereads[i]))),
    segments: arr(raw.segments).map(segment).filter((s): s is StateSegment => s !== null),
    distractions: arr(raw.distractions).map(distraction).filter((d): d is DistractionEvent => d !== null),
    regressions,
    nudges: Math.round(num(raw.nudges)),
    pagesTurned: Math.round(num(raw.pagesTurned)),
    totalSweeps: Math.round(num(raw.totalSweeps)),
    calibrationQuality: QUALITIES.includes(raw.calibrationQuality as SessionReport["calibrationQuality"])
      ? (raw.calibrationQuality as SessionReport["calibrationQuality"])
      : "attention-only",
    calibrationErrorPx: numOrNull(raw.calibrationErrorPx),
  };
}
