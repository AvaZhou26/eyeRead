// Replays a real reading session logged by the dev gaze logger (data/gaze-debug*.jsonl, see
// src/lib/gaze/devLog.ts) through the reading tracker, and reports how well the corrected gaze
// fits the text. There's no ground truth for which line was being read, so it reports what can
// be judged without one:
//   - on-column: share of frames whose corrected gaze x is inside the text column
//   - on-page:   share whose corrected gaze y is between the first and last line
//   - offtext:   share of frames the tracker called "looking off the text"
//   - advance:   lines moved down per minute by the tracker's line (reading moves steadily down)
//   - backsteps: times the tracker's line jumped back up 2+ lines (should be rare)
//
// Run with:  npx tsx scripts/replay-gaze-log.ts data/gaze-debug.jsonl [more logs...]
// Each file's LAST session is replayed (the logger appends every session to the same file).
// --refit recomputes the gaze with the CURRENT gaze model, fitted to the session's own
// calibration samples, instead of using the gaze as it was logged.
// WPM=300 sets the reader's pace for logs that didn't record it (it decides what counts as read).
// Y_DETAIL=1 also prints, per page, where the dot sat vertically (5th/50th/95th percentile).
import { readFileSync } from "node:fs";
import { ReadingTracker } from "../src/lib/gaze/readingTracker";
import { OneEuroFilter } from "../src/lib/gaze/oneEuro";
import type { LineBox } from "../src/lib/gaze/lineHmm";
import type { FaceFrame } from "../src/lib/gaze/faceTracker";
import { GazeModel, type CalibSample } from "../src/lib/gaze/gazeModel";

const WORDS_PER_LINE = 11;

interface LoggedLine { i: number; top: number; bottom: number; left: number; right: number }

/**
 * Fit the CURRENT gaze model to the calibration this session used: the last attempt logged
 * before it (a retry restarts at the first dot after the validation dots), the way the reader
 * does (fit on the dots, then refit with the validation dots at the same strength).
 */
function refitModel(before: Record<string, unknown>[]) {
  let attempt = 0, sawVal = false;
  before.forEach((r, i) => {
    if (r.k === "val") sawVal = true;
    if (r.k === "cal" && sawVal) {
      attempt = i;
      sawVal = false;
    }
  });
  const pick = (k: string): CalibSample[] =>
    before.slice(attempt).filter((r) => r.k === k && r.feat).map((r) => ({ features: r.feat as number[], x: r.x as number, y: r.y as number, point: r.point as number }));
  const cal = pick("cal"), val = pick("val");
  if (cal.length < 10) throw new Error("no calibration samples in this log to refit from");
  const first = GazeModel.fit(cal);
  return GazeModel.fit([...cal, ...val], first.lambda);
}

export function replay(file: string, refit = false) {
  const all = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // The logger appends every session to the same file: replay the last one.
  const startIdx = all.map((r) => r.k).lastIndexOf("start");
  if (startIdx < 0) throw new Error(`${file}: no reading session in this log`);
  const rows = all.slice(startIdx);
  const start = rows[0];
  const model = refit ? refitModel(all.slice(0, startIdx)) : null;
  const pages = new Map<number, LineBox[]>();
  let maxLine = 0;
  for (const r of rows.filter((r) => r.k === "page")) {
    const ls = (r.lines as LoggedLine[]).map((l) => {
      maxLine = Math.max(maxLine, l.i);
      return {
        index: l.i, page: r.page, top: l.top, bottom: l.bottom, left: l.left, right: l.right,
        firstWord: l.i * WORDS_PER_LINE, lastWord: l.i * WORDS_PER_LINE + WORDS_PER_LINE - 1, paragraph: Math.floor(l.i / 5),
      };
    });
    pages.set(r.page, ls);
  }
  const total = (maxLine + 1) * WORDS_PER_LINE;
  const frames = rows.filter((r) => r.k === "f");
  const t0 = frames[0].t;
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph: new Int32Array(total).map((_, w) => Math.floor(w / WORDS_PER_LINE / 5)), paragraphWords: Array.from({ length: Math.ceil((maxLine + 1) / 5) }, () => 5 * WORDS_PER_LINE), lineHeight: start.lineH, sigmaY: start.sigmaY, initialBiasY: 0, aids: false,
      // The reader's own pace: from the log when recorded, else WPM=… from the command line.
      secPerWord: start.secPerWord ?? (process.env.WPM ? 60 / Number(process.env.WPM) : undefined) },
    t0,
  );
  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  let page = -1, n = 0, onCol = 0, onPage = 0, off = 0, back = 0, prevLine: number | null = null;
  const lineTimes: { t: number; line: number }[] = [];
  const yByPage = new Map<number, number[]>();
  type Snap = { seen: { x: number; y: number } | null; line: LineBox | null; state: string };
  const cur: { snap: Snap | null } = { snap: null };
  rt.onDebug = (d) => (cur.snap = { seen: d.seen, line: d.line, state: d.state });
  for (const r of frames) {
    if (r.page !== page) {
      rt.setPage(pages.get(r.page) ?? [], r.page, r.t, page < 0 ? "relayout" : "turn", true);
      page = r.page;
      prevLine = null;
    }
    const raw = (model ? (r.feat ? model.predict(r.feat) : null) : r.raw) as { x: number; y: number } | null;
    // Older logs lack features: a placeholder marks frames that had eye data.
    const f: FaceFrame = { t: r.t, face: r.face, blink: !raw, features: r.feat ?? (raw ? [0] : null), yaw: 0, pitch: 0, faceSize: 0.17, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 30, eyes: null };
    const gaze = raw ? { x: fx.filter(raw.x, r.t), y: fy.filter(raw.y, r.t) } : null;
    const fast = raw ? { x: qx.filter(raw.x, r.t), y: qy.filter(raw.y, r.t) } : null;
    cur.snap = null;
    rt.onFrame(f, gaze, fast, r.t);
    const s = cur.snap as Snap | null; // set by onDebug during onFrame
    if (!s || !s.seen) continue;
    const L = pages.get(page) ?? [];
    if (!L.length) continue;
    n++;
    const colL = L[0].left, colR = Math.max(...L.map((l) => l.right));
    if (s.seen.x >= colL && s.seen.x <= colR) onCol++;
    if (s.seen.y >= L[0].top && s.seen.y <= L[L.length - 1].bottom) onPage++;
    if (!yByPage.has(page)) yByPage.set(page, []);
    yByPage.get(page)!.push(s.seen.y);
    if (s.state === "offtext") off++;
    if (process.env.TRACE_PAGE && Number(process.env.TRACE_PAGE) === page && n % 15 === 0) {
      const tr = rt as unknown as { pageMax: number; regress: { ev: number; counted: boolean } | null; hmm: { biasY: number; p: Float64Array } };
      const pTop = s.line ? tr.hmm.p[s.line.index - L[0].index] : 0;
      console.log(`  t ${(r.t - t0).toFixed(1).padStart(5)} raw y ${raw ? Math.round(raw.y) : "-"} dot y ${Math.round(s.seen.y)} line ${s.line ? s.line.index - L[0].index : "-"} (${Math.round(pTop * 100)}%) reached ${tr.pageMax} reread-evidence ${tr.regress ? tr.regress.ev.toFixed(2) + (tr.regress.counted ? "*" : "") : "-"} bias ${Math.round(tr.hmm.biasY)}`);
    }
    if (s.line) {
      const li = s.line.index - L[0].index;
      if (prevLine !== null && li <= prevLine - 2) back++;
      prevLine = li;
      lineTimes.push({ t: r.t, line: li });
    }
  }
  const dur = (frames[frames.length - 1].t - t0) / 60;
  // Lines moved down per minute: sum of forward steps of the believed line, per page.
  let fwd = 0;
  for (let i = 1; i < lineTimes.length; i++) fwd += Math.max(0, lineTimes[i].line - lineTimes[i - 1].line);
  // Re-readings the tracker recorded, as page lines.
  const lineOf = new Map<number, { page: number; li: number }>();
  for (const [p, ls] of pages) ls.forEach((l, li) => { for (let w = l.firstWord; w <= l.lastWord; w++) lineOf.set(w, { page: p, li }); });
  const rereads = rt.exportState(frames[frames.length - 1].t, 0, { quality: "good", errorPx: null }).regressions.map((r) => {
    const a = lineOf.get(r.from), b = lineOf.get(r.to);
    return a && b ? `page ${a.page} lines ${a.li}-${b.li}` : "?";
  });
  // Moments the reader marked (M key) as "going back to re-read now".
  const marks = rows.filter((r) => r.k === "mark").map((r) => `page ${r.page} at ${(r.t - t0).toFixed(1)}s`);
  if (process.env.Y_DETAIL) for (const [p, ys] of yByPage) { const q = (k: number) => [...ys].sort((a, b) => a - b)[Math.floor(k * (ys.length - 1))]; const L = pages.get(p)!; console.log(`  page ${p}: page y ${L[0].top}-${L[L.length - 1].bottom}, dot y p5/med/p95 ${Math.round(q(0.05))}/${Math.round(q(0.5))}/${Math.round(q(0.95))}`); }
  return { file, rereads, marks, seconds: Math.round(dur * 60), onColumn: n ? onCol / n : 0, onPage: n ? onPage / n : 0, offtext: n ? off / n : 0, advancePerMin: fwd / dur, backsteps: back };
}

if (process.argv[1]?.endsWith("replay-gaze-log.ts")) {
  const refit = process.argv.includes("--refit");
  const files = process.argv.slice(2).filter((a) => a !== "--refit");
  if (!files.length) {
    console.error("usage: npx tsx scripts/replay-gaze-log.ts data/gaze-debug.jsonl [...]");
    process.exit(1);
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  for (const f of files) {
    const r = replay(f, refit);
    console.log(`${r.file} (${r.seconds}s): on-column ${pct(r.onColumn)} · on-page ${pct(r.onPage)} · offtext ${pct(r.offtext)} · advance ${r.advancePerMin.toFixed(1)} lines/min · backsteps ${r.backsteps} · re-reads found: ${r.rereads.join("; ") || "none"} · marked by reader: ${r.marks.join("; ") || "none"}`);
  }
}
