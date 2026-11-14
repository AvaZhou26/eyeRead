// Multi-page simulation: a reader works through several pages while the webcam gaze is
// noisy, offset, slowly drifting AND vertically stretched or squashed (a "gain" error:
// the calibration is right at the top of the page but increasingly wrong further down).
// Reports how often the tracker's line estimate is right, averaged over many runs.
//
// Run with:  npx tsx scripts/simulate-pages.ts
// Options (env): LINE_H=40 (line height in px), RUNS=30, NOISE=80
import { ReadingTracker } from "../src/lib/gaze/readingTracker";
import { OneEuroFilter } from "../src/lib/gaze/oneEuro";
import type { LineBox } from "../src/lib/gaze/lineHmm";
import type { FaceFrame } from "../src/lib/gaze/faceTracker";

const LINE_H = Number(process.env.LINE_H) || 50;
const RUNS = Number(process.env.RUNS) || 30;
const NOISE = Number(process.env.NOISE) || 80;
const PAGE_PX = 600; // usable page height; taller lines mean fewer lines per page
const LEFT = 300, WIDTH = 620, TOP = 100, WORDS_PER_LINE = 11, PAGES = 5;
const N_LINES = Math.floor(PAGE_PX / LINE_H);
const WPM = 250, FPS = 30;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
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

interface Result {
  exact: number; // share of frames where the most likely line is the true line
  near: number; // ... within one line
  bottomExact: number; // same, for the bottom third of each page (where a gain error bites)
  read: number; // share of lines that ended up counted as "read" (all were truly read)
}

function runOnce(gain: number, biasY: number): Result {
  const total = PAGES * N_LINES * WORDS_PER_LINE;
  const wordParagraph = new Int32Array(total).map((_, w) => Math.floor(w / WORDS_PER_LINE / 5));
  const nPara = Math.ceil((PAGES * N_LINES) / 5);
  const paragraphWords = Array.from({ length: nPara }, (_, p) => Math.min(5, PAGES * N_LINES - p * 5) * WORDS_PER_LINE);
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph, paragraphWords, lineHeight: LINE_H,
      sigmaY: Math.max(LINE_H * 0.7, NOISE * 1.3), initialBiasY: 0, aids: true },
    0,
  );
  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  let t = 0, frames = 0, exact = 0, near = 0, bFrames = 0, bExact = 0;
  const lineSec = WORDS_PER_LINE / (WPM / 60);
  const firstCentre = TOP + LINE_H * 0.5;
  const allLines: LineBox[] = [];

  for (let page = 0; page < PAGES; page++) {
    const lines = makePage(page);
    allLines.push(...lines);
    rt.setPage(lines, page, t, page === 0 ? "relayout" : "turn", true);
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      const n = Math.round(lineSec * FPS);
      for (let k = 0; k < n; k++, t += 1 / FPS) {
        const tx = L.left + (k / n) * (L.right - L.left);
        const ty = (L.top + L.bottom) / 2;
        // What the camera "sees": right at the first line, stretched/squashed below it.
        const seenY = firstCentre + gain * (ty - firstCentre) + biasY + t * 0.3;
        const gx = tx + gauss() * NOISE, gy = seenY + gauss() * NOISE;
        const blink = Math.random() < 0.03;
        const f: FaceFrame = { t, face: true, blink, features: blink ? null : [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 30, eyes: null };
        let raw = -1;
        rt.onDebug = (d) => { raw = d.line ? d.line.index : -1; };
        rt.onFrame(f, blink ? null : { x: fx.filter(gx, t), y: fy.filter(gy, t) }, blink ? null : { x: qx.filter(gx, t), y: qy.filter(gy, t) }, t);
        frames++;
        if (raw === L.index) exact++;
        if (raw >= 0 && Math.abs(raw - L.index) <= 1) near++;
        if (li >= Math.floor((lines.length * 2) / 3)) {
          bFrames++;
          if (raw === L.index) bExact++;
        }
      }
    }
  }
  const r = rt.buildReport(t, Array.from({ length: nPara }, () => "x"), { quality: "good", errorPx: NOISE });
  const readLines = allLines.filter((l) => r.wordStatus[l.firstWord] === "read").length;
  return { exact: exact / frames, near: near / frames, bottomExact: bExact / bFrames, read: readLines / allLines.length };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
console.log(`line height ${LINE_H}px · ${N_LINES} lines/page · ${PAGES} pages · noise σ=${NOISE}px · ${RUNS} runs each`);
console.log("vertical gain   exact line   within ±1   exact (bottom third)   lines counted read");
for (const gain of [1.0, 0.85, 1.15, 0.75, 1.3]) {
  const rs = Array.from({ length: RUNS }, () => runOnce(gain, 50));
  const avg = (k: keyof Result) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
  console.log(`${gain.toFixed(2).padStart(8)}       ${pct(avg("exact"))}         ${pct(avg("near"))}          ${pct(avg("bottomExact"))}                  ${pct(avg("read"))}`);
}
