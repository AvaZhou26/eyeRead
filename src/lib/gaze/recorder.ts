// Record a reading session's eye data, and play it back later.
//
// Why: the line tracker can only be tuned against real webcam data. Tuning by "read a page,
// squint at the debug dot, change a number, read again" is slow and can't be repeated. A
// recording captures exactly what the tracker was fed (every camera frame's gaze point, the
// page layouts, page turns), so the same session can be replayed through a changed tracker
// as many times as needed:  npx tsx scripts/replay.ts recording.json
//
// What's in a recording: numbers only. Gaze points, head angles, the eye-geometry features
// behind them, where each line of text sat on screen, and word counts. No video, no images,
// and none of the reading's text.
import type { FaceFrame } from "./faceTracker";
import type { ValidationResult } from "./gazeModel";
import type { LineBox } from "./lineHmm";
import type { ReadingFit } from "./readingCalibration";
import { ReadingTracker, type TrackerOptions, type TrackerTap, type TrackingMode } from "./readingTracker";
import type { ResumeState, SessionReport } from "../types";

type Pt = { x: number; y: number };

/**
 * One thing that happened, in order. Times are seconds on the tracker's clock.
 *  f: a camera frame   [ "f", t, flags, yaw, pitch, gazeX, gazeY, fastX, fastY, fps ]
 *     flags: 1 = face visible, 2 = blink, 4 = eyes usable (features present), 8 = no frame at all
 *     gaze/fast are null when there was no gaze point for the frame
 *  p: a page was shown [ "p", t, page, reason, byKeyboard, layoutIndex ]
 *  v: tab hidden/shown [ "v", t, hidden ]
 *  r: recalibrated     [ "r", t, sigmaY, biasY, mode, alignedByReading ]
 */
export type RecEvent =
  | ["f", number, number, number, number, number | null, number | null, number | null, number | null, number]
  | ["p", number, number, "turn" | "relayout", boolean, number]
  | ["v", number, boolean]
  | ["r", number, number, number, TrackingMode, boolean];

export interface GazeRecording {
  version: 1;
  createdAt: string;
  /** Free-form context: browser, screen, engine, calibration quality. Not used by replay. */
  meta: Record<string, unknown>;
  /** The tracker's settings at the start (wordParagraph as a plain array). */
  options: Omit<TrackerOptions, "wordParagraph"> & { wordParagraph: number[] };
  t0: number;
  /** Progress restored from an earlier sitting, if this session was a "continue reading". */
  resume: ResumeState | null;
  /** Each distinct page layout seen; "p" events point into this list. */
  layouts: LineBox[][];
  events: RecEvent[];
  /** Eye-geometry features per "f" event, in order (null where there were none). Optional. */
  features?: (number[] | null)[];
  endT: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Longest session we keep (frames). 30 fps × 90 minutes; beyond that, recording just stops. */
const MAX_FRAMES = 30 * 60 * 90;

export class GazeRecorder implements TrackerTap {
  private rec: GazeRecording;
  private layoutKeys = new Map<string, number>();
  private frames = 0;

  constructor(meta: Record<string, unknown> = {}, private keepFeatures = true) {
    this.rec = {
      version: 1,
      createdAt: new Date().toISOString(),
      meta,
      options: { mode: "gaze", totalWords: 0, wordParagraph: [], paragraphWords: [], lineHeight: 0, sigmaY: 0, initialBiasY: 0, aids: true },
      t0: 0,
      resume: null,
      layouts: [],
      events: [],
      features: keepFeatures ? [] : undefined,
      endT: 0,
    };
  }

  get frameCount() {
    return this.frames;
  }

  setMeta(more: Record<string, unknown>) {
    Object.assign(this.rec.meta, more);
  }

  start(opts: TrackerOptions, t0: number) {
    this.rec.options = { ...opts, wordParagraph: Array.from(opts.wordParagraph) };
    this.rec.t0 = t0;
    this.rec.endT = t0;
  }

  restore(state: ResumeState) {
    this.rec.resume = state;
  }

  setPage(lines: LineBox[], page: number, now: number, reason: "turn" | "relayout", byKeyboard: boolean) {
    const key = JSON.stringify(lines);
    let i = this.layoutKeys.get(key);
    if (i === undefined) {
      i = this.rec.layouts.length;
      this.rec.layouts.push(lines.map((l) => ({ ...l })));
      this.layoutKeys.set(key, i);
    }
    this.rec.events.push(["p", r4(now), page, reason, byKeyboard, i]);
    this.rec.endT = now;
  }

  frame(frame: FaceFrame | null, gaze: Pt | null, fast: Pt | null, now: number, fps: number) {
    if (this.frames >= MAX_FRAMES) return;
    this.frames++;
    const flags = frame ? (frame.face ? 1 : 0) | (frame.blink ? 2 : 0) | (frame.features ? 4 : 0) : 8;
    this.rec.events.push([
      "f", r4(now), flags, r4(frame?.yaw ?? 0), r4(frame?.pitch ?? 0),
      gaze ? r1(gaze.x) : null, gaze ? r1(gaze.y) : null, fast ? r1(fast.x) : null, fast ? r1(fast.y) : null, r1(fps),
    ]);
    if (this.keepFeatures) this.rec.features!.push(frame?.features ? frame.features.map(r4) : null);
    this.rec.endT = now;
  }

  visibility(hidden: boolean, now: number) {
    this.rec.events.push(["v", r4(now), hidden]);
    this.rec.endT = now;
  }

  retune(sigmaY: number, biasY: number, mode: TrackingMode, alignedByReading: boolean, now: number) {
    this.rec.events.push(["r", r4(now), r1(sigmaY), r1(biasY), mode, alignedByReading]);
  }

  toJSON(): GazeRecording {
    return this.rec;
  }
}

/** Calibration details worth keeping next to a recording (plain data only). */
export function calibrationMeta(c: { engine: string; validation: ValidationResult; readingFit?: ReadingFit; secPerWord?: number } | null) {
  if (!c) return null;
  return { engine: c.engine, validation: c.validation, readingFit: c.readingFit ?? null, secPerWord: c.secPerWord ?? null };
}

// ---------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------

export interface ReplayPage {
  /** Which visit this is (pages can be visited more than once). */
  visit: number;
  page: number;
  lines: number;
  seconds: number;
  /** Frames with a gaze point while this page was showing. */
  gazeFrames: number;
  /** Return sweeps the tracker detected on this page (a full read gives about lines − 1). */
  sweeps: number;
  /** Share of gaze frames where the tracker was confident (≥60%) about the line. */
  confident: number;
  /**
   * Only with `assumeLinear`: how often the tracker's line matched the line a steady
   * top-to-bottom read would be on at that moment (exact, and within one line).
   */
  exact?: number;
  near?: number;
  biasY: number;
  gain: number;
  /** The tracker's line (page-local index, −1 = none) sampled about twice a second. */
  trace: number[];
}

export interface ReplayResult {
  report: SessionReport;
  pages: ReplayPage[];
  frames: number;
  gazeFrames: number;
  /** Totals over pages that had enough gaze to judge (only with `assumeLinear`). */
  exact?: number;
  near?: number;
}

export interface ReplayOptions {
  /**
   * Treat each forward page visit as one steady read from the first line to the last, and
   * score the tracker against that. Only meaningful for a recording where the reader really
   * did read every page once, in order, at an even pace.
   */
  assumeLinear?: boolean;
  /** Change the tracker's settings before replaying (to try a different tuning). */
  options?: Partial<TrackerOptions>;
}

/** Feed a recording back through a fresh ReadingTracker. */
export function replay(rec: GazeRecording, ro: ReplayOptions = {}): ReplayResult {
  const opts: TrackerOptions = { ...rec.options, wordParagraph: Int32Array.from(rec.options.wordParagraph), ...ro.options };
  const rt = new ReadingTracker(opts, rec.t0);
  if (rec.resume) rt.restore(rec.resume, rec.t0);

  let bestLine = -1, bestProb = 0, sweeps = 0;
  rt.onDebug = (d) => {
    bestLine = d.line ? d.line.index : -1;
    bestProb = d.lineProb;
    sweeps = d.totalSweeps;
  };

  const pages: ReplayPage[] = [];
  let cur: (ReplayPage & { lineBoxes: LineBox[]; start: number; sweeps0: number; conf: number; times: number[]; best: number[]; forward: boolean }) | null = null;
  let lastPage = -1, frames = 0, gazeFrames = 0, lastTrace = -1e9;

  const close = (t: number) => {
    if (!cur) return;
    cur.seconds = t - cur.start;
    cur.sweeps = sweeps - cur.sweeps0;
    cur.confident = cur.gazeFrames ? cur.conf / cur.gazeFrames : 0;
    cur.biasY = rt.debugBias().biasY;
    cur.gain = rt.debugBias().gain;
    if (ro.assumeLinear && cur.forward && cur.times.length >= 60 && cur.lineBoxes.length >= 2) {
      // Steady read: time on each line is proportional to its word count.
      const words = cur.lineBoxes.map((l) => l.lastWord - l.firstWord + 1);
      const total = words.reduce((s, w) => s + w, 0);
      const ends: number[] = [];
      let seen = 0;
      for (const w of words) ends.push((seen += w) / total);
      const tA = cur.times[0], tB = cur.times[cur.times.length - 1];
      let exact = 0, near = 0;
      cur.times.forEach((ft, k) => {
        const prog = tB > tA ? (ft - tA) / (tB - tA) : 0;
        let truth = ends.findIndex((e) => prog <= e);
        if (truth < 0) truth = ends.length - 1;
        const got = cur!.best[k];
        if (got === truth) exact++;
        if (got >= 0 && Math.abs(got - truth) <= 1) near++;
      });
      cur.exact = exact / cur.times.length;
      cur.near = near / cur.times.length;
    }
    const { lineBoxes: _l, start: _s, sweeps0: _w, conf: _c, times: _t, best: _b, forward: _f, ...page } = cur;
    void _l; void _s; void _w; void _c; void _t; void _b; void _f;
    pages.push(page);
    cur = null;
  };

  for (const e of rec.events) {
    if (e[0] === "p") {
      const [, t, page, reason, byKeyboard, li] = e;
      const lines = rec.layouts[li] ?? [];
      if (reason === "turn" || !cur) {
        close(t);
        cur = {
          visit: pages.length, page, lines: lines.length, seconds: 0, gazeFrames: 0, sweeps: 0, confident: 0, biasY: 0, gain: 1, trace: [],
          lineBoxes: lines, start: t, sweeps0: sweeps, conf: 0, times: [], best: [], forward: page > lastPage,
        };
        lastPage = Math.max(lastPage, page);
        lastTrace = -1e9;
      } else {
        cur.lineBoxes = lines; // a relayout (font size, window resize) on the same page
        cur.lines = lines.length;
      }
      rt.setPage(lines, page, t, reason, byKeyboard);
    } else if (e[0] === "v") {
      rt.onVisibility(e[2], e[1]);
    } else if (e[0] === "r") {
      rt.retune(e[2], e[3], e[4], e[5], e[1]);
    } else {
      const [, t, flags, yaw, pitch, gx, gy, qx, qy, fps] = e;
      frames++;
      const frame: FaceFrame | null =
        flags & 8
          ? null
          : { t, face: !!(flags & 1), blink: !!(flags & 2), features: flags & 4 ? [0] : null, yaw, pitch, faceSize: 0, faceX: 0.5, faceY: 0.5, brightness: null, eyePx: 0, eyes: null };
      const gaze = gx !== null && gy !== null ? { x: gx, y: gy } : null;
      const fast = qx !== null && qy !== null ? { x: qx, y: qy } : null;
      bestLine = -1;
      bestProb = 0;
      rt.onFrame(frame, gaze, fast, t, fps);
      if (gaze && cur) {
        gazeFrames++;
        cur.gazeFrames++;
        const local = bestLine < 0 ? -1 : cur.lineBoxes.findIndex((l) => l.index === bestLine);
        if (bestProb >= 0.6) cur.conf++;
        cur.times.push(t);
        cur.best.push(local);
        if (t - lastTrace >= 0.5) {
          cur.trace.push(local);
          lastTrace = t;
        }
      }
    }
  }
  close(rec.endT);

  const calib = rec.meta.calibration as { validation?: ValidationResult } | null | undefined;
  const report = rt.buildReport(
    rec.endT,
    rec.options.paragraphWords.map(() => ""),
    { quality: calib?.validation?.quality ?? "attention-only", errorPx: calib?.validation ? Math.round(calib.validation.meanErrorPx) : null },
  );
  const scored = pages.filter((p) => p.exact !== undefined);
  const w = scored.reduce((s, p) => s + p.gazeFrames, 0);
  return {
    report,
    pages,
    frames,
    gazeFrames,
    exact: w ? scored.reduce((s, p) => s + p.exact! * p.gazeFrames, 0) / w : undefined,
    near: w ? scored.reduce((s, p) => s + p.near! * p.gazeFrames, 0) / w : undefined,
  };
}
