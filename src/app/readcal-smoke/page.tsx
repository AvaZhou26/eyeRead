"use client";
// TEMPORARY debug of the horizontal fit in the real screen. Delete after use.
import { useState } from "react";
import type { FaceFrame, FaceTracker } from "@/lib/gaze/faceTracker";
import { ReadingCalibration, type ReadingCalibrationOutcome } from "@/components/reader/ReadingCalibration";
import type { CalibrationResult } from "@/components/reader/Calibration";

const WPM = 250;
let seed = 9;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
let readStart = -1;
let colMid = 720;
const gx = (x: number) => (x < colMid ? x - 0.5 * (colMid - x) : x);
let rowsDbg: { c: number; l: number; r: number; n: number }[] = [];
function measure() {
  const out: { x: number; c: number }[] = []; const rows: { c: number; l: number; r: number; n: number }[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-w]"))) {
    const r = el.getBoundingClientRect(); const c = (r.top + r.bottom) / 2;
    const row = rows.find((y) => Math.abs(y.c - c) < 15); if (row) { row.l = Math.min(row.l, r.left); row.r = Math.max(row.r, r.right); row.n++; } else rows.push({ c, l: r.left, r: r.right, n: 1 });
    out.push({ x: (r.left + r.right) / 2, c });
  }
  rowsDbg = rows;
  return out;
}
const fakeTracker = { subscribe(fn: (f: FaceFrame) => void) { const id = setInterval(() => fn({ t: performance.now() / 1000, face: true, blink: false, features: [0], yaw: 0, pitch: 0, faceSize: 0.12, faceX: 0.5, faceY: 0.5, brightness: 120, eyePx: 50, eyes: null }), 33); return () => clearInterval(id); } } as unknown as FaceTracker;
const dotCal: CalibrationResult = {
  engine: "webeyetrack",
  validation: { meanErrorPx: 100, meanAbsDyPx: 50, meanDyPx: 0, jitterDyPx: 40, quality: "good" },
  estimator: { predict: (f) => {
    const w = measure(); if (!w.length) return null;
    colMid = (Math.min(...w.map((v) => v.x)) + Math.max(...w.map((v) => v.x))) / 2;
    if (readStart < 0) readStart = f.t;
    const k = Math.min(w.length - 1, Math.floor(((f.t - readStart) * WPM) / 60));
    const out = { x: gx(w[k].x) + gauss() * 50, y: w[k].c + gauss() * 36 };
    const dbg = ((window as unknown as { __dbg?: { s: unknown[]; rows?: unknown; colMid?: number } }).__dbg ??= { s: [] });
    dbg.s.push({ t: f.t, x: out.x, y: out.y, k, trueX: w[k].x });
    dbg.rows = rowsDbg; dbg.colMid = colMid;
    return out;
  } },
};
export default function Smoke() {
  const [out, setOut] = useState("");
  return (<>
    {!out && <ReadingCalibration tracker={fakeTracker} calibration={dotCal} prefs={{ font: "serif", size: "m", aids: true, showGaze: false }}
      onDone={(o: ReadingCalibrationOutcome) => setOut(JSON.stringify({ x: o.fit?.x, colMid: Math.round(colMid), rows: rowsDbg.slice(0, 4).map((r) => [Math.round(r.c), Math.round(r.l), Math.round(r.r), r.n]) }, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)))}
      onSkip={() => setOut("skipped")} />}
    <pre id="out">{out}</pre>
  </>);
}
