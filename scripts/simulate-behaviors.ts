// Behaviour simulation: can the tracker tell reading, skimming, re-reading and skipping apart?
//
// A simulated reader works through pages of 5-line paragraphs. Each paragraph gets one
// behaviour, and the webcam gaze is noisy, offset and interrupted by blinks, as in
// simulate-pages.ts. At the end we compare what the report says about each paragraph with
// what the reader really did.
//
//   read      every line once, left to right, at a normal pace
//   skimFast  a quick glance along the first part of most lines (about a fifth of the time)
//   skimHalf  the first half of every line at normal speed, then down to the next line
//   reread1   read normally, but one line in the middle is read twice in a row
//   rereadP   read the whole paragraph, jump back to its first line, read it all again
//   skip      jumped over without looking
//
// It ends with a second check: the reader stops and stares beside the text for 45 s. That
// time must be reported as off the text, not as reading.
//
// Run with:  npm run simulate:behaviors
// Options (env): RUNS=30, NOISE=80, LINE_H=50, XBIAS=40
import { ReadingTracker } from "../src/lib/gaze/readingTracker";
import { OneEuroFilter } from "../src/lib/gaze/oneEuro";
import type { LineBox } from "../src/lib/gaze/lineHmm";
import type { FaceFrame } from "../src/lib/gaze/faceTracker";

const LINE_H = Number(process.env.LINE_H) || 50;
const RUNS = Number(process.env.RUNS) || 30;
const NOISE = Number(process.env.NOISE) || 80;
const XBIAS = Number(process.env.XBIAS ?? 40);
const LEFT = 300, WIDTH = 620, TOP = 100, WPL = 11, WPM = 250, FPS = 30;
const PARA_LINES = 5, PARAS_PER_PAGE = 2, PAGES = 8;
const N_LINES = PARA_LINES * PARAS_PER_PAGE;

export type Behaviour = "read" | "skimFast" | "skimHalf" | "reread1" | "rereadP" | "skip";
const BEHAVIOURS: Behaviour[] = ["read", "skimFast", "skimHalf", "reread1", "rereadP", "skip"];

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makePage(page: number): LineBox[] {
  return Array.from({ length: N_LINES }, (_, i) => {
    const g = page * N_LINES + i;
    const lastOfPara = i % PARA_LINES === PARA_LINES - 1;
    return {
      index: g, page, top: TOP + i * LINE_H + LINE_H * 0.2, bottom: TOP + i * LINE_H + LINE_H * 0.8,
      left: LEFT, right: LEFT + WIDTH - (lastOfPara ? 200 : 0),
      firstWord: g * WPL, lastWord: g * WPL + WPL - 1, paragraph: Math.floor(g / PARA_LINES),
    };
  });
}

/** One stretch of eye movement along a line: from x-fraction `a` to `b` over `sec` seconds. */
interface Move { line: LineBox; a: number; b: number; sec: number }

function plan(lines: LineBox[], behaviour: Behaviour): Move[] {
  const lineSec = WPL / (WPM / 60);
  const full = (l: LineBox): Move => ({ line: l, a: 0, b: 1, sec: lineSec * (0.85 + Math.random() * 0.3) });
  switch (behaviour) {
    case "read":
      return lines.map(full);
    case "skimFast":
      return lines.filter(() => Math.random() > 0.3).map((l) => ({ line: l, a: 0, b: 0.4 + Math.random() * 0.3, sec: lineSec * 0.3 }));
    case "skimHalf":
      return lines.map((l) => ({ line: l, a: 0, b: 0.45, sec: lineSec * 0.45 }));
    case "reread1": {
      const k = 1 + Math.floor(Math.random() * (lines.length - 2));
      return lines.flatMap((l, i) => (i === k ? [full(l), full(l)] : [full(l)]));
    }
    case "rereadP":
      return [...lines.map(full), ...lines.map(full)];
    case "skip":
      return [];
  }
}

interface Outcome { truth: Behaviour; status: "read" | "skimmed" | "skipped"; reread: boolean }

function runOnce(): Outcome[] {
  const nPara = PAGES * PARAS_PER_PAGE;
  const total = PAGES * N_LINES * WPL;
  const wordParagraph = new Int32Array(total).map((_, w) => Math.floor(w / WPL / PARA_LINES));
  const paragraphWords = Array.from({ length: nPara }, () => PARA_LINES * WPL);
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph, paragraphWords, lineHeight: LINE_H,
      sigmaY: Math.max(LINE_H * 0.7, NOISE * 1.3), initialBiasY: 0, aids: false },
    0,
  );
  // The first paragraph of every page is read normally: people don't open a page mid-skim,
  // and the tracker anchors itself on the first line. Everything else is drawn at random,
  // with plain reading the most common.
  const truth: Behaviour[] = Array.from({ length: nPara }, (_, p) =>
    p % PARAS_PER_PAGE === 0 || Math.random() < 0.35 ? "read" : BEHAVIOURS[1 + Math.floor(Math.random() * (BEHAVIOURS.length - 1))],
  );

  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  let t = 0, blinkUntil = -1, nextBlink = 1 + Math.random() * 4;

  for (let page = 0; page < PAGES; page++) {
    const lines = makePage(page);
    rt.setPage(lines, page, t, page === 0 ? "relayout" : "turn", true);
    const moves: Move[] = [];
    for (let p = 0; p < PARAS_PER_PAGE; p++) {
      moves.push(...plan(lines.slice(p * PARA_LINES, (p + 1) * PARA_LINES), truth[page * PARAS_PER_PAGE + p]));
    }
    for (const m of moves) {
      const n = Math.max(2, Math.round(m.sec * FPS));
      if (Math.random() < 0.3) blinkUntil = t + 0.1 + Math.random() * 0.15; // blink on the jump to this line
      for (let k = 0; k < n; k++, t += 1 / FPS) {
        if (t >= nextBlink) {
          blinkUntil = t + 0.15 + Math.random() * 0.15;
          nextBlink = t + 2 + Math.random() * 5;
        }
        const blink = t < blinkUntil;
        const L = m.line;
        const tx = L.left + (m.a + (k / n) * (m.b - m.a)) * (L.right - L.left);
        const ty = (L.top + L.bottom) / 2;
        const gx = tx + XBIAS + gauss() * NOISE, gy = ty + 40 + t * 0.2 + gauss() * NOISE;
        const f: FaceFrame = { t, face: true, blink, features: blink ? null : [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 30, eyes: null };
        rt.onFrame(f, blink ? null : { x: fx.filter(gx, t), y: fy.filter(gy, t) }, blink ? null : { x: qx.filter(gx, t), y: qy.filter(gy, t) }, t);
      }
    }
  }
  const r = rt.buildReport(t, Array.from({ length: nPara }, () => "x"), { quality: "good", errorPx: NOISE });
  return r.paragraphs.map((p, i) => ({ truth: truth[i], status: p.status, reread: p.rereads > 0 }));
}

const all: Outcome[] = [];
for (let i = 0; i < RUNS; i++) all.push(...runOnce());

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–").padStart(5);
console.log(`line height ${LINE_H}px · noise σ=${NOISE}px · sideways offset ${XBIAS}px · ${RUNS} runs · ${all.length} paragraphs`);
console.log("what the reader did    n   reported: read  skimmed  skipped   flagged re-read   right?");
let right = 0;
for (const b of BEHAVIOURS) {
  const rows = all.filter((o) => o.truth === b);
  const n = rows.length;
  const c = (s: string) => rows.filter((o) => o.status === s).length;
  const rr = rows.filter((o) => o.reread).length;
  // What a correct report looks like for each behaviour.
  const ok = rows.filter((o) =>
    b === "read" ? o.status === "read" && !o.reread
    : b === "reread1" || b === "rereadP" ? o.status === "read" && o.reread
    : b === "skip" ? o.status === "skipped" && !o.reread
    : o.status !== "read" && !o.reread,
  ).length;
  right += ok;
  console.log(`${b.padEnd(18)} ${String(n).padStart(5)}        ${pct(c("read"), n)}    ${pct(c("skimmed"), n)}    ${pct(c("skipped"), n)}           ${pct(rr, n)}     ${pct(ok, n)}`);
}
console.log(`overall: ${pct(right, all.length).trim()} of paragraphs reported correctly`);


// ---- Looking beside the text must not count as reading ----
function stareBeside(offsetCols: number) {
  const lines = makePage(0);
  const total = N_LINES * WPL;
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph: new Int32Array(total).map((_, w) => Math.floor(w / WPL / PARA_LINES)),
      paragraphWords: Array.from({ length: PARAS_PER_PAGE }, () => PARA_LINES * WPL), lineHeight: LINE_H, sigmaY: Math.max(LINE_H * 0.7, NOISE * 1.3), initialBiasY: 0, aids: false },
    0,
  );
  rt.setPage(lines, 0, 0, "relayout");
  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  let t = 0, offText = 0;
  const frame = (tx: number, ty: number) => {
    const gx = tx + gauss() * NOISE, gy = ty + gauss() * NOISE;
    const f: FaceFrame = { t, face: true, blink: false, features: [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 30, eyes: null };
    rt.onFrame(f, { x: fx.filter(gx, t), y: fy.filter(gy, t) }, { x: qx.filter(gx, t), y: qy.filter(gy, t) }, t);
    t += 1 / FPS;
  };
  for (const m of plan(lines.slice(0, 5), "read")) {
    const n = Math.round(m.sec * FPS);
    for (let k = 0; k < n; k++) frame(m.line.left + (k / n) * (m.line.right - m.line.left), (m.line.top + m.line.bottom) / 2);
  }
  const x = offsetCols < 0 ? LEFT + offsetCols * WIDTH : LEFT + WIDTH + offsetCols * WIDTH;
  for (let k = 0; k < 45 * FPS; k++) {
    frame(x, TOP + 5 * LINE_H);
    if (rt.state === "offtext" || rt.state === "away") offText += 1 / FPS;
  }
  return offText;
}
console.log("\nstaring beside the text for 45 s (should be off the text nearly the whole time):");
for (const [label, cols] of [["0.6 column widths to the left", -0.6], ["0.6 column widths to the right", 0.6]] as const) {
  console.log(`  ${label}: ${stareBeside(cols).toFixed(0)} s counted as off the text`);
}
