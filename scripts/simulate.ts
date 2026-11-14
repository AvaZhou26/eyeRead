// Simulates a reader with noisy webcam-like gaze to sanity-check the tracking algorithm.
// Run with:  npx tsx scripts/simulate.ts
import { ReadingTracker } from "../src/lib/gaze/readingTracker";
import { OneEuroFilter } from "../src/lib/gaze/oneEuro";
import type { LineBox } from "../src/lib/gaze/lineHmm";
import type { FaceFrame } from "../src/lib/gaze/faceTracker";

const LINE_H = 40, LEFT = 300, WIDTH = 620, TOP = 100, N_LINES = 20, WORDS_PER_LINE = 11;
const WPM = 250, FPS = 30;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeLines(): LineBox[] {
  return Array.from({ length: N_LINES }, (_, i) => ({
    index: i, page: 0, top: TOP + i * LINE_H + 8, bottom: TOP + i * LINE_H + 32,
    left: LEFT, right: LEFT + WIDTH - (i % 5 === 4 ? 200 : 0),
    firstWord: i * WORDS_PER_LINE, lastWord: i * WORDS_PER_LINE + WORDS_PER_LINE - 1, paragraph: Math.floor(i / 5),
  }));
}

type Step = { kind: "read"; line: number } | { kind: "away"; sec: number };

function run(name: string, script: Step[], noise: number, biasY: number) {
  const lines = makeLines();
  const total = N_LINES * WORDS_PER_LINE;
  const wordParagraph = new Int32Array(total).map((_, w) => Math.floor(w / WORDS_PER_LINE / 5));
  const rt = new ReadingTracker(
    { mode: "gaze", totalWords: total, wordParagraph, paragraphWords: [55, 55, 55, 55], lineHeight: LINE_H,
      sigmaY: Math.max(LINE_H * 0.7, noise * 1.3), initialBiasY: 0, aids: true },
    0,
  );
  const markers: string[] = [];
  rt.onMarker = (m) => markers.push(m ? `${m.reason}@line${m.line.index}` : "hide");
  rt.setPage(lines, 0, 0, "relayout");
  const fx = new OneEuroFilter(0.6, 0.004), fy = new OneEuroFilter(0.6, 0.004);
  const qx = new OneEuroFilter(2.5, 0.01), qy = new OneEuroFilter(2.5, 0.01);
  const trace: string[] = [];
  let t = 0, hits = 0, near = 0, frames = 0, offSum = 0, offN = 0, lastBias = 0;
  const lineSec = WORDS_PER_LINE / (WPM / 60);
  const drift = (tt: number) => biasY + tt * 0.6; // slow calibration drift (px/s)

  for (const step of script) {
    if (step.kind === "away") {
      for (let k = 0; k < step.sec * FPS; k++, t += 1 / FPS) {
        const f: FaceFrame = { t, face: false, blink: false, features: null, yaw: 0, pitch: 0, faceSize: 0, faceX: 0.5, faceY: 0.5, brightness: 120 };
        rt.onFrame(f, null, null, t);
      }
      continue;
    }
    const L = lines[step.line];
    const n = Math.round(lineSec * FPS);
    for (let k = 0; k < n; k++, t += 1 / FPS) {
      const prog = k / n;
      const tx = L.left + prog * (L.right - L.left);
      const ty = (L.top + L.bottom) / 2;
      const gx = tx + gauss() * noise, gy = ty + drift(t) + gauss() * noise;
      const gaze = { x: fx.filter(gx, t), y: fy.filter(gy, t) };
      const fast = { x: qx.filter(gx, t), y: qy.filter(gy, t) };
      const blink = Math.random() < 0.03;
      const f: FaceFrame = { t, face: true, blink, features: blink ? null : [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120 };
      let best = -1;
      let raw = -1;
      rt.onDebug = (d) => {
        best = d.line && d.lineProb > 0.5 ? d.line.index : -1;
        raw = d.line ? d.line.index : -1;
        if (process.env.TRACE && k % 15 === 0) trace.push(`${step.line}:${raw}(${Math.round(d.lineProb * 100)})`);
        lastBias = d.biasY;
      };
      rt.onFrame(f, blink ? null : gaze, blink ? null : fast, t);
      frames++;
      if (best === step.line) hits++;
      if (raw >= 0 && Math.abs(raw - step.line) <= 1) near++;
      if (raw >= 0) { offSum += raw - step.line; offN++; }
    }
  }
  const r = rt.buildReport(t, ["a", "b", "c", "d"], { quality: "good", errorPx: noise });
  const status = lines.map((l) => ({ read: "R", skimmed: "s", skipped: "-" })[r.wordStatus[l.firstWord]]).join("");
  console.log(`\n=== ${name} (noise σ=${noise}px, bias=${biasY}px) ===`);
  console.log(`line accuracy: ${((hits / frames) * 100).toFixed(1)}% exact+confident, ${((near / frames) * 100).toFixed(1)}% within ±1 line · mean offset ${(offSum / Math.max(1, offN)).toFixed(2)} lines · learned bias ${lastBias.toFixed(0)}px (true ≈ ${(biasY + t * 0.6).toFixed(0)}) · sweeps ${rt.totalSweeps}`);
  console.log(`line status (R=read s=skimmed -=skipped): ${status}`.replace("skipped)", "skipped)"));
  console.log(`coverage ${r.coveragePct}%  focus ${r.focusPct}%  wpm ${r.avgWpm}  distractions ${r.distractions.length}  rereads ${r.paragraphs.map((p) => p.rereads).join(",")}`);
  console.log(`markers: ${markers.join(" → ") || "none"}`);
  if (process.env.TRACE) console.log(trace.join(" "));
  console.log(`dwell ratio per line: ${lines.map((l) => (rt.wordDwell[l.firstWord] / 0.25).toFixed(2)).join(" ")}`);
}

const seq = (a: number, b: number): Step[] => Array.from({ length: b - a + 1 }, (_, i) => ({ kind: "read", line: a + i }));

for (const noise of [40, 80, 120]) run("read everything", seq(0, 19), noise, 60);
run("skip lines 8-13", [...seq(0, 7), ...seq(14, 19)], 80, 60);
run("look away 5s after line 9, come back", [...seq(0, 9), { kind: "away", sec: 5 }, ...seq(10, 19)], 80, 60);
run("re-read lines 5-8", [...seq(0, 9), ...seq(5, 8), ...seq(10, 19)], 80, 60);
