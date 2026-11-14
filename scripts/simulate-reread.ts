// Benchmark for two field complaints: the tracker drifting DOWN the page while you read,
// and re-reading going unnoticed. Simulated readers make the moves real readers make:
//   - short leftward jumps back within a line (re-reading a phrase, ~1 per 3 lines),
//   - re-reading jumps back 1 (to mid-line: re-reading a sentence), 2, 3 or 5 lines,
// while the webcam gaze is noisy and, optionally, drifts slowly downward (as when eyelids
// droop or you slouch during a session). Seeded, so runs are comparable before/after a change.
//
// Run with:  npx tsx scripts/simulate-reread.ts
// Options (env): RUNS=40, NOISE=60 (gaze σ, px), LINE_H=48, SEED=1,
//   PREG=0.33 (chance per line of a hop back within it)
import { ReadingTracker } from "../src/lib/gaze/readingTracker";
import { OneEuroFilter } from "../src/lib/gaze/oneEuro";
import type { LineBox } from "../src/lib/gaze/lineHmm";
import type { FaceFrame } from "../src/lib/gaze/faceTracker";

const RUNS = Number(process.env.RUNS) || 40;
const NOISE = Number(process.env.NOISE) || 60;
const LINE_H = Number(process.env.LINE_H) || 48;
const SEED = Number(process.env.SEED) || 1;
const LEFT = 300, WIDTH = 620, TOP = 100, WORDS_PER_LINE = 11, N_LINES = 14, PAGES = 3;
const WPM = 250, FPS = 30;
const LINE_SEC = WORDS_PER_LINE / (WPM / 60);

let rngState = SEED;
function rand() {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() {
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makePage(page: number): LineBox[] {
  return Array.from({ length: N_LINES }, (_, i) => {
    const g = page * N_LINES + i;
    return {
      index: g, page, top: TOP + i * LINE_H + LINE_H * 0.2, bottom: TOP + i * LINE_H + LINE_H * 0.8,
      left: LEFT, right: LEFT + WIDTH - (g % 5 === 4 ? 200 : 0),
      firstWord: g * WORDS_PER_LINE, lastWord: g * WORDS_PER_LINE + WORDS_PER_LINE - 1, paragraph: Math.floor(g / 5),
    };
  });
}

/** Read page-local `line` from fraction `a` to `b` of its width. */
interface Seg { line: number; a: number; b: number }

interface Scenario {
  name: string;
  /** Lines back of each re-reading jump on a page (0 = none); one jump per page, mid-page. */
  back: number;
  /** Downward gaze drift, px/s. */
  drift: number;
}

/** One page of reading: line by line, with within-line regressions and (maybe) one re-read jump. */
function pageScript(back: number): { segs: Seg[]; jumpTo: number | null } {
  const segs: Seg[] = [];
  const jumpAfter = back > 0 ? 7 + Math.floor(rand() * 3) : -1; // after line 7..9
  let jumpTo: number | null = null;
  for (let i = 0; i < N_LINES; i++) {
    if (rand() < Number(process.env.PREG ?? 0.33)) {
      // a short regression within the line: read to `a`, hop back to `b`, carry on
      const a = 0.45 + rand() * 0.45, b = Math.max(0, a - 0.3 - rand() * 0.25);
      segs.push({ line: i, a: 0, b: a }, { line: i, a: b, b: 1 });
    } else segs.push({ line: i, a: 0, b: 1 });
    if (i === jumpAfter) {
      jumpTo = i - back;
      // back 1 = re-read the last sentence: from mid-line above; further = from the line start
      segs.push({ line: jumpTo, a: back === 1 ? 0.5 : 0, b: 1 });
      for (let j = jumpTo + 1; j <= i; j++) segs.push({ line: j, a: 0, b: 1 });
    }
  }
  return { segs, jumpTo };
}

interface Result {
  exact: number;
  near: number;
  offset: number; // mean (believed line − true line): positive = the model sits too LOW
  biasErr: number; // mean (learned offset − true offset) / line height: positive = dot drawn too HIGH
  dotErr: number; // mean (drawn dot y − true y) / line height, on each page's last third, settled moments
  hit: number; // re-reading jumps detected (share)
  falseRe: number; // re-readings recorded per page that match no jump
  follow: number; // seconds after a jump back until the believed line is within 1 of the truth
}

function runOnce(sc: Scenario): Result {
  const total = PAGES * N_LINES * WORDS_PER_LINE;
  const wordParagraph = new Int32Array(total).map((_, w) => Math.floor(w / WORDS_PER_LINE / 5));
  const nPara = Math.ceil((PAGES * N_LINES) / 5);
  const paragraphWords = Array.from({ length: nPara }, (_, p) => Math.min(5, PAGES * N_LINES - p * 5) * WORDS_PER_LINE);
  const sigmaY = Math.max(LINE_H * 0.7, NOISE * 1.3);
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph, paragraphWords, lineHeight: LINE_H, sigmaY, initialBiasY: 0, aids: true },
    0,
  );
  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  // A calibration also leaves a constant vertical offset.
  const bias0 = 40;
  let t = 0, frames = 0, exact = 0, near = 0, offSum = 0, offN = 0, dotSum = 0, dotN = 0, biasSum = 0;
  const jumps: number[] = []; // global line index each jump went back to
  const follows: number[] = [];

  for (let page = 0; page < PAGES; page++) {
    const lines = makePage(page);
    rt.setPage(lines, page, t, page === 0 ? "relayout" : "turn", true);
    const { segs, jumpTo } = pageScript(sc.back);
    if (jumpTo !== null) jumps.push(lines[jumpTo].index);
    let jumpStart: number | null = null;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      const L = lines[seg.line];
      const isJump = jumpTo !== null && seg.line === jumpTo && jumpStart === null && s > 0 && segs[s - 1].line > seg.line;
      if (isJump) jumpStart = t;
      const n = Math.max(2, Math.round(LINE_SEC * (seg.b - seg.a) * FPS));
      const w = L.right - L.left;
      for (let k = 0; k < n; k++, t += 1 / FPS) {
        const tx = L.left + (seg.a + ((seg.b - seg.a) * k) / n) * w;
        const ty = (L.top + L.bottom) / 2;
        const gx = tx + gauss() * NOISE, gy = ty + bias0 + sc.drift * t + gauss() * NOISE;
        const blink = rand() < 0.03;
        const f: FaceFrame = { t, face: true, blink, features: blink ? null : [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 30, eyes: null };
        let raw = -1, dotY: number | null = null, bias = 0;
        rt.onDebug = (d) => {
          raw = d.line ? d.line.index : -1;
          dotY = d.gaze ? d.gaze.y - d.biasY : null;
          bias = d.biasY;
        };
        const gaze = { x: fx.filter(gx, t), y: fy.filter(gy, t) };
        const fast = { x: qx.filter(gx, t), y: qy.filter(gy, t) };
        rt.onFrame(f, blink ? null : gaze, blink ? null : fast, t);
        frames++;
        biasSum += (bias - (bias0 + sc.drift * t)) / LINE_H;
        if (raw === L.index) exact++;
        if (raw >= 0 && Math.abs(raw - L.index) <= 1) {
          near++;
          if (jumpStart !== null && follows.length < jumps.length) follows.push(t - jumpStart);
        }
        if (raw >= 0) {
          offSum += raw - L.index;
          offN++;
        }
        // Settled moments only: right after a line change the smoothed gaze is still on its way.
        if (dotY !== null && k / FPS >= 0.5 && seg.line >= Math.floor((N_LINES * 2) / 3)) {
          dotSum += (dotY - ty) / LINE_H;
          dotN++;
        }
      }
    }
    if (jumpTo !== null && follows.length < jumps.length) follows.push(LINE_SEC * 3); // never caught up
  }
  const st = rt.exportState(t, 0, { quality: "good", errorPx: NOISE });
  const lineOf = (w: number) => Math.floor(w / WORDS_PER_LINE);
  const matched = new Set<number>();
  let falseRe = 0;
  for (const r of st.regressions) {
    const j = jumps.findIndex((g, i) => !matched.has(i) && Math.abs(lineOf(r.from) - g) <= 1);
    if (j >= 0) matched.add(j);
    else falseRe++;
  }
  return {
    exact: exact / frames,
    near: near / frames,
    offset: offSum / Math.max(1, offN),
    biasErr: biasSum / frames,
    dotErr: dotSum / Math.max(1, dotN),
    hit: jumps.length ? matched.size / jumps.length : NaN,
    falseRe: falseRe / PAGES,
    follow: follows.length ? follows.reduce((a, b) => a + b, 0) / follows.length : NaN,
  };
}

const scenarios: Scenario[] = [];
for (const drift of [0, 1])
  for (const back of [0, 1, 2, 3, 5]) scenarios.push({ name: `drift ${drift}px/s back ${back}`, back, drift });

const f2 = (x: number) => (Number.isNaN(x) ? "  –  " : x.toFixed(2).padStart(5));
const pct = (x: number) => (Number.isNaN(x) ? "  –" : `${(x * 100).toFixed(0)}%`.padStart(4));
console.log(`line ${LINE_H}px · noise σ=${NOISE}px · ${N_LINES} lines × ${PAGES} pages · ${RUNS} runs each · seed ${SEED}`);
console.log("scenario                               exact  ±1   offset  bias-err  dot-err  reread-hit  false/page  follow-s");
const totals = { exact: 0, hit: 0, hitN: 0, falseRe: 0, absOff: 0, absBias: 0, absDot: 0, n: 0 };
for (const sc of scenarios) {
  rngState = SEED * 1000 + scenarios.indexOf(sc);
  const rs = Array.from({ length: RUNS }, () => runOnce(sc));
  const avg = (k: keyof Result) => {
    const v = rs.map((r) => r[k]).filter((x) => !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  const r = { exact: avg("exact"), near: avg("near"), offset: avg("offset"), biasErr: avg("biasErr"), dotErr: avg("dotErr"), hit: avg("hit"), falseRe: avg("falseRe"), follow: avg("follow") };
  totals.exact += r.exact;
  totals.falseRe += r.falseRe;
  totals.absOff += Math.abs(r.offset);
  totals.absDot += Math.abs(r.dotErr);
  totals.absBias += Math.abs(r.biasErr);
  totals.n++;
  if (!Number.isNaN(r.hit)) {
    totals.hit += r.hit;
    totals.hitN++;
  }
  console.log(
    `${sc.name.padEnd(38)} ${pct(r.exact)} ${pct(r.near)}  ${f2(r.offset)}   ${f2(r.biasErr)}    ${f2(r.dotErr)}      ${pct(r.hit)}       ${f2(r.falseRe)}     ${f2(r.follow)}`,
  );
}
console.log(
  `\nSUMMARY exact ${pct(totals.exact / totals.n)} · re-read hit ${pct(totals.hit / totals.hitN)} · false re-reads/page ${f2(totals.falseRe / totals.n)} · |offset| ${f2(totals.absOff / totals.n)} lines · |bias err| ${f2(totals.absBias / totals.n)} lines · |dot err| ${f2(totals.absDot / totals.n)} lines`,
);
