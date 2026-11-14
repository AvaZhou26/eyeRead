// The "brain" of a reading session. Every camera frame it:
//   • decides if you're reading, skimming, pausing, looking off the text, or away
//   • detects return sweeps (end-of-line jumps) and feeds them to the line HMM
//   • adds up how long your eyes spent on every word (by line probability, and by where
//     along the line the eyes are, so a half-read line isn't counted as fully read)
//   • counts how many times each line was read to its end ("passes")
//   • spots re-reading (jumping back several lines, or extra passes) and big jumps ahead
//   • decides when to show the gentle "your place was here" marker
// At the end it turns all of that into a SessionReport.
import type { FaceFrame } from "./faceTracker";
import { LineHmm, type LineBox } from "./lineHmm";
import type {
  CoverageStatus,
  DistractionEvent,
  ParagraphStat,
  ReadingState,
  ResumeState,
  SessionReport,
  StateSegment,
} from "../types";

export type TrackingMode = "gaze" | "attention" | "none";

/** Seconds a typical college reader spends per word (≈240 wpm). Used when we don't know the student's own pace. */
export const SEC_PER_WORD = 60 / 240;
// Both ratios are relative to the reader's normal time per word (their own pace when known,
// from the reading calibration; else SEC_PER_WORD). At 240 wpm that means:
const READ_RATIO = 0.35; // ≥35% of normal time on a word → read  (i.e. faster than ~690 wpm is not "reading")
const SKIM_RATIO = 0.15; // 15–35% → skimmed (~700–1600 wpm); below → skipped
/**
 * How a frame's time on a line is shared among that line's words: this share goes evenly to
 * every word, the rest goes to the words near where the eyes are, left to right. Left-right
 * is the webcam's better axis, so this is what separates "read the whole line" from "read
 * the first half and dropped down" (skimming). The even share keeps a sideways calibration
 * offset from starving the words at one end of every line.
 */
const EVEN_SHARE = 0.4;
/**
 * Re-reading by passes: a paragraph counts as re-read when it got at least this many lines'
 * worth of extra passes and this many lines' worth of extra time (see buildReport). Picked
 * with scripts/simulate-behaviors.ts: about 3 in 4 single re-read lines caught, with no false
 * alarms in ~1,600 normally read paragraphs. Lower values catch a few more and start to
 * flag ordinary reading (0.4 / 0.25 gave 1% false alarms).
 */
const EXTRA_PASS_LINES = 0.5;
const EXTRA_TIME_LINES = 0.2;
/** Longest gap without eye data (seconds) that still counts as a blink rather than looking away. */
const BLINK_GAP_S = 0.45;
/** "Skimming" state: moving down lines this many times faster than your normal pace. */
const SKIM_SPEEDUP = 2.75; // at 240 wpm and ~11 words a line ≈ 1 line/s, the old fixed threshold

export interface MarkerInfo {
  line: LineBox;
  reason: "away" | "jump";
}

export interface ToastInfo {
  id: number;
  message: string;
  goToPage: number | null;
}

export interface DebugSnapshot {
  state: ReadingState;
  gaze: { x: number; y: number } | null;
  line: LineBox | null;
  lineProb: number;
  offProb: number;
  biasY: number;
  gain: number;
  sweeps: number;
  /** Return sweeps detected since the session started. */
  totalSweeps: number;
  fps: number;
  face: boolean;
}

/**
 * Something that wants a copy of everything the tracker is fed (see recorder.ts). Attach
 * with `attachTap` right after creating the tracker.
 */
export interface TrackerTap {
  start(opts: TrackerOptions, t0: number): void;
  restore(state: ResumeState): void;
  setPage(lines: LineBox[], page: number, now: number, reason: "turn" | "relayout", byKeyboard: boolean): void;
  frame(frame: FaceFrame | null, gaze: { x: number; y: number } | null, fast: { x: number; y: number } | null, now: number, fps: number): void;
  visibility(hidden: boolean, now: number): void;
  retune(sigmaY: number, biasY: number, mode: TrackingMode, alignedByReading: boolean, now: number): void;
}

export type TrackerOptions = Options;

interface Options {
  mode: TrackingMode;
  totalWords: number;
  wordParagraph: Int32Array; // paragraph index of each word
  paragraphWords: number[]; // word count per paragraph
  lineHeight: number;
  sigmaY: number;
  initialBiasY: number;
  aids: boolean;
  /** This student's normal seconds per word (from the reading calibration); default SEC_PER_WORD. */
  secPerWord?: number;
  /**
   * The gaze is already aligned to real lines of text (the reading calibration succeeded):
   * keep the reader's own offset correction to drift-sized amounts.
   */
  alignedByReading?: boolean;
}

/**
 * With a reading-aligned calibration: max drift correction (lines) and its time constant (s).
 * Picked in a simulation of 3 pages read line by line (gaze jitter 1–2.5 lines, a glance
 * around each new page, slow drift of 1–2 lines): 2 lines / 4 s kept the right line 87–98% of
 * the time. Slower adaptation (8–20 s) lost the drift cases (65–76% at 2 lines of drift); the
 * cap mattered little once page-start anchoring ignored the glance.
 */
const ALIGNED_BIAS_CAP_LINES = 2;
const ALIGNED_BIAS_TAU = 4;

export class ReadingTracker {
  readonly wordDwell: Float64Array;
  readonly wordRereads: Int32Array;
  /**
   * How many times each word's line was read to its end (a "pass"). Every jump back to the
   * left margin, and every forward page turn, completes a pass of the line the eyes were on.
   * One read gives about 1 everywhere; a line read twice gives about 2 there. This catches
   * re-reading a single line, which never moves the eyes far enough up the page to notice.
   */
  private wordPasses: Float32Array;
  private lineWordsSum = 0;
  private lineWordsN = 0;
  private hmm: LineHmm;
  private lines: LineBox[] = [];
  private page = 0;
  private pageStart = 0;
  private t0: number;
  private lastT: number | null = null;

  // state machine
  state: ReadingState = "reading";
  private candidate: { kind: "away" | "offtext" | "ontext"; since: number } = { kind: "ontext", since: 0 };
  private segments: StateSegment[] = [];
  private segStart = 0;
  private distractions: DistractionEvent[] = [];
  private openDistraction: DistractionEvent | null = null;
  private tabHiddenAt: number | null = null;

  // sweeps & lines
  private gazeHist: { t: number; x: number; y: number }[] = [];
  private lastSweep = -10;
  private sweepTimes: number[] = [];
  private confHist: { t: number; line: number }[] = [];
  private pageMax = -1;
  // `snap` = how well each line on the page had been read when you jumped back. Only lines
  // that were already properly READ count as re-read; going back to lines you skimmed or
  // skipped is just reading them (their dwell keeps adding up and they turn "read").
  private regressCandidate: { line: number; since: number; snap: number[] } | null = null;
  private regressionActive = false;
  private regressions: { from: number; to: number }[] = []; // word ranges re-read

  // page-start anchoring: after a page turn people read the first line, so the gaze offset
  // while they do tells us the calibration drift directly. But the first moments on a new page
  // are often a glance around it, so we only trust the second just before the first return
  // sweep: to sweep back to the start of line 2 you must have just been reading line 1.
  private anchoring = false;
  private anchorResid: { t: number; r: number }[] = [];

  // Vertical stretch ("gain") learning. On each page we know two moments for sure: the
  // reader starts on the first line and, if they read down the page, presses "next" from
  // the last line. Comparing where the camera saw those two moments with how far apart the
  // lines really are tells us how stretched the gaze is. See learnGain().
  private pageAnchorRawY: number | null = null; // raw gaze y while on this page's first line
  private sweepsOnPage = 0;
  private yHist: { t: number; y: number }[] = []; // last ~1.5 s of smoothed gaze y
  private gainObs: number[] = [];

  // place marker
  private place = -1; // page-local line index of where you're reading
  private skipCandidate: { line: number; since: number } | null = null;
  private lastSkipScan = 0;
  private flaggedLines = new Set<number>();
  private marker: (MarkerInfo & { returnedAt: number | null; shownAt: number; nearSince: number | null }) | null = null;
  private lastNudgeAt = -1e9;
  private lastToastAt = -1e9;
  private toastId = 0;
  nudges = 0;
  totalSweeps = 0;
  pagesTurned = 0;

  onMarker: (m: MarkerInfo | null) => void = () => {};
  onToast: (t: ToastInfo) => void = () => {};
  onState: (s: ReadingState) => void = () => {};
  onDebug: (d: DebugSnapshot) => void = () => {};

  constructor(private opts: Options, now: number) {
    this.wordDwell = new Float64Array(opts.totalWords);
    this.wordRereads = new Int32Array(opts.totalWords);
    this.wordPasses = new Float32Array(opts.totalWords);
    this.hmm = new LineHmm(opts.sigmaY, Math.max(60, opts.sigmaY));
    this.hmm.biasY = opts.initialBiasY;
    this.applyBiasLimits();
    this.t0 = now;
    this.segStart = 0;
    this.pageStart = now;
  }

  get mode() {
    return this.opts.mode;
  }

  private tap: TrackerTap | null = null;

  /** Send a copy of everything this tracker is fed to `tap` (call right after creating it). */
  attachTap(tap: TrackerTap, now = this.t0) {
    this.tap = tap;
    tap.start({ ...this.opts }, this.t0);
    // Attached part-way through a session: tell it which page is showing.
    if (this.lines.length) tap.setPage(this.lines, this.page, now, "relayout", false);
  }

  detachTap() {
    this.tap = null;
  }

  /** The drift corrections learned so far (for diagnostics). */
  debugBias() {
    return { biasY: this.hmm.biasY, gain: this.hmm.gain };
  }

  /** Normal seconds per word for this reader: their own pace if measured, else typical. */
  private get spw() {
    return this.opts.secPerWord ?? SEC_PER_WORD;
  }

  setAids(on: boolean) {
    this.opts.aids = on;
    if (!on) this.setMarker(null);
  }

  private applyBiasLimits() {
    const aligned = !!this.opts.alignedByReading;
    this.hmm.biasCap = aligned ? ALIGNED_BIAS_CAP_LINES * this.opts.lineHeight : null;
    this.hmm.biasTau = aligned ? ALIGNED_BIAS_TAU : 4;
  }

  /** Largest offset the reader may apply (also caps the page-start anchoring). */
  private biasCap() {
    return this.hmm.biasCap ?? Math.max(this.opts.lineHeight * 4, this.opts.sigmaY * 2);
  }

  /** Re-tune after a recalibration. */
  retune(sigmaY: number, biasY: number, mode: TrackingMode, alignedByReading = false, now = this.lastT ?? this.t0) {
    this.tap?.retune(sigmaY, biasY, mode, alignedByReading, now);
    // Switching from focus-only to eye tracking mid-session: we don't know the line yet.
    if (mode === "gaze" && this.opts.mode !== "gaze") this.hmm.setLines(this.lines, "spread");
    this.opts.mode = mode;
    this.opts.sigmaY = sigmaY;
    this.opts.alignedByReading = alignedByReading;
    this.hmm.sigmaY = sigmaY;
    this.hmm.biasY = biasY;
    this.applyBiasLimits();
    // A new calibration has its own stretch: forget what we learned about the old one.
    this.hmm.gain = 1;
    this.gainObs = [];
    this.pageAnchorRawY = null;
  }

  /**
   * Learn the vertical stretch from the page that was just finished. Only trusted when the
   * reader clearly read down the page (enough line-to-line return sweeps) and turned it
   * from the keyboard (a mouse click means the eyes were on the button, not the last line).
   */
  private learnGain(lines: LineBox[], now: number) {
    if (this.opts.mode !== "gaze" || lines.length < 6 || this.pageAnchorRawY === null) return;
    if (this.sweepsOnPage < 0.6 * (lines.length - 1)) return;
    const recent = this.yHist.filter((g) => now - g.t >= 0.1 && now - g.t <= 0.8).map((g) => g.y).sort((a, b) => a - b);
    if (recent.length < 8) return;
    const first = lines[0], last = lines[lines.length - 1];
    const span = (last.top + last.bottom) / 2 - (first.top + first.bottom) / 2;
    if (span < this.opts.lineHeight * 4) return;
    const obs = (recent[recent.length >> 1] - this.pageAnchorRawY) / span;
    if (!(obs >= 0.55 && obs <= 1.7)) return; // implausible: they weren't on the last line
    this.gainObs.push(obs);
    if (this.gainObs.length > 5) this.gainObs.shift();
    const sorted = [...this.gainObs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    // One page is a noisy measurement, so move only part of the way until more agree.
    const trust = (this.gainObs.length + 0.5) / (this.gainObs.length + 1);
    const gain = 1 + (median - 1) * trust;
    this.hmm.gain = Math.abs(gain - 1) < 0.03 ? 1 : Math.max(0.6, Math.min(1.6, gain));
  }

  /** Called when the page changes (or the layout is rebuilt). */
  setPage(lines: LineBox[], page: number, now: number, reason: "turn" | "relayout", byKeyboard = false) {
    this.tap?.setPage(lines, page, now, reason, byKeyboard);
    if (page !== this.page || !this.lineWordsN) {
      for (const l of lines) {
        this.lineWordsSum += l.lastWord - l.firstWord + 1;
        this.lineWordsN++;
      }
    }
    const prevPage = this.page;
    const prevLines = this.lines;
    if (reason === "turn" && page !== prevPage) {
      this.pagesTurned++;
      if (page > prevPage) this.checkRushedPage(prevLines, prevPage, now);
      // Turning forward ends a pass of the last line you were on (there's no sweep to see).
      if (page === prevPage + 1 && this.opts.mode === "gaze" && !this.anchoring && (this.state === "reading" || this.state === "skimming")) this.countPass();
      if (page === prevPage + 1 && byKeyboard) this.learnGain(prevLines, now);
    }
    this.lines = lines;
    this.page = page;
    this.pageStart = now;
    const backwards = reason === "turn" && page < prevPage;
    this.hmm.setLines(lines, backwards ? "spread" : "top");
    this.anchoring = !backwards && (reason === "turn" || this.pagesTurned === 0);
    this.anchorResid = [];
    this.pageAnchorRawY = null;
    this.sweepsOnPage = 0;
    this.pageMax = -1;
    this.place = -1;
    this.skipCandidate = null;
    this.regressCandidate = null;
    this.regressionActive = false;
    this.confHist = [];
    this.setMarker(null);
  }

  private wordsIn(l: LineBox) {
    return l.lastWord - l.firstWord + 1;
  }

  private lineRatio(l: LineBox) {
    let d = 0;
    for (let w = l.firstWord; w <= l.lastWord; w++) d += this.wordDwell[w];
    return d / (this.wordsIn(l) * this.spw);
  }

  private checkRushedPage(lines: LineBox[], page: number, now: number) {
    if (!lines.length) return;
    let words = 0, skipped = 0;
    for (const l of lines) {
      const n = this.wordsIn(l);
      words += n;
      if (this.lineRatio(l) < 0.15) skipped += n;
    }
    if (words >= 40 && skipped / words >= 0.4 && this.opts.aids && now - this.lastToastAt > 40) {
      this.lastToastAt = now;
      this.nudges++;
      this.onToast({
        id: ++this.toastId,
        message: `Page ${page + 1} went by quickly. Want to go back to it?`,
        goToPage: page,
      });
    }
  }

  private setMarker(m: MarkerInfo | null, now = 0) {
    if (!m) {
      if (this.marker) {
        this.marker = null;
        this.onMarker(null);
      }
      return;
    }
    this.marker = { ...m, returnedAt: null, shownAt: now, nearSince: null };
    this.onMarker(m);
  }

  // ---------- tab visibility ----------
  onVisibility(hidden: boolean, now: number) {
    this.tap?.visibility(hidden, now);
    const t = now - this.t0;
    if (hidden) {
      this.tabHiddenAt = now;
      this.enterState("away", t, "tab");
    } else if (this.tabHiddenAt !== null) {
      this.tabHiddenAt = null;
      this.lastT = now; // don't count the hidden gap as dwell
      this.candidate = { kind: "ontext", since: now };
      this.enterState("pausing", t);
    }
  }

  // ---------- per-frame update ----------
  onFrame(frame: FaceFrame | null, gaze: { x: number; y: number } | null, gazeFast: { x: number; y: number } | null, now: number, fps = 0) {
    this.tap?.frame(frame, gaze, gazeFast, now, fps);
    if (this.tabHiddenAt !== null) return;
    const dt = this.lastT === null ? 1 / 30 : Math.min(0.25, Math.max(0, now - this.lastT));
    this.lastT = now;
    const t = now - this.t0;
    const mode = this.opts.mode;
    const lines = this.lines;
    const lineH = this.opts.lineHeight;

    // 1) Instant classification
    let inst: "away" | "offtext" | "ontext" = "ontext";
    if (mode !== "none" && frame) {
      if (!frame.face || Math.abs(frame.yaw) > 0.6 || Math.abs(frame.pitch) > 0.5) inst = "away";
      else if (mode === "gaze" && gaze && lines.length) {
        const colL = lines[0].left, colR = Math.max(...lines.map((l) => l.right));
        const w = colR - colL;
        const y = this.hmm.correctY(gaze.y);
        const top = lines[0].top, bottom = lines[lines.length - 1].bottom;
        const margin = Math.max(this.opts.sigmaY * 1.6, lineH * 3);
        if (gaze.x < colL - 0.35 * w || gaze.x > colR + 0.35 * w || y < top - margin || y > bottom + margin) inst = "offtext";
      }
    }

    // 2) Return-sweep detection (big, fast leftward jump of the gaze)
    let sweep = false;
    if (mode === "gaze" && gazeFast && frame?.features) {
      // A blink hides the eyes for a moment, and people often blink exactly as they jump to
      // the next line. Keep the gaze history across such short gaps, or that jump is missed.
      // Only a long gap (looked away) starts the history over.
      const last = this.gazeHist[this.gazeHist.length - 1];
      if (last && now - last.t > BLINK_GAP_S) this.gazeHist = [];
      this.gazeHist.push({ t: now, ...gazeFast });
      while (this.gazeHist.length && now - this.gazeHist[0].t > 1.2) this.gazeHist.shift();
      if (lines.length && now - this.lastSweep > 0.7) {
        const before = this.gazeHist.filter((g) => now - g.t >= 0.35 && now - g.t <= 0.75);
        const after = this.gazeHist.filter((g) => now - g.t <= 0.15);
        if (before.length >= 4 && after.length >= 2) {
          const mean = (a: typeof before, k: "x" | "y") => a.reduce((s, g) => s + g[k], 0) / a.length;
          const colW = Math.max(...lines.map((l) => l.right)) - lines[0].left;
          const dx = mean(after, "x") - mean(before, "x");
          const dy = mean(after, "y") - mean(before, "y");
          if (dx < -0.33 * colW && dy > -1.5 * lineH) {
            sweep = true;
            this.lastSweep = now;
            this.sweepTimes.push(t);
            this.totalSweeps++;
            this.sweepsOnPage++;
          }
        }
      }
    }
    while (this.sweepTimes.length && t - this.sweepTimes[0] > 20) this.sweepTimes.shift();

    if (mode === "gaze" && gaze && frame?.features) {
      this.yHist.push({ t: now, y: gaze.y });
      while (this.yHist.length && now - this.yHist[0].t > 1.5) this.yHist.shift();
    }

    // 3) Line HMM
    if (mode === "gaze" && lines.length && this.anchoring) {
      // Still on the first line of a fresh page: learn the offset, keep the model pinned.
      if (gaze && frame?.features && inst !== "away") {
        const first = lines[0];
        this.anchorResid.push({ t: now, r: gaze.y - (first.top + first.bottom) / 2 });
      }
      // Give up after ~6 s without a sweep (or on looking away): then we learn nothing.
      const timedOut = this.anchorResid.length >= 180 || inst === "away";
      if (sweep || timedOut) {
        // Only the last stretch of line 1, before the sweep's own movement.
        const onLine1 = sweep ? this.anchorResid.filter((a) => now - a.t <= 1.2 && now - a.t >= 0.25).map((a) => a.r) : [];
        if (onLine1.length >= 12) {
          const sorted = onLine1.sort((a, b) => a - b);
          const med = sorted[sorted.length >> 1];
          const cap = this.biasCap();
          // Reading-aligned: the offset is already known, so only nudge it halfway.
          const target = this.opts.alignedByReading ? this.hmm.biasY + 0.5 * (med - this.hmm.biasY) : med;
          this.hmm.biasY = Math.max(-cap, Math.min(cap, target));
          this.pageAnchorRawY = (lines[0].top + lines[0].bottom) / 2 + med;
        }
        this.anchoring = false;
        this.hmm.pin(0);
        if (sweep) {
          this.countPass();
          this.hmm.predict(dt, true);
        }
      } else {
        this.hmm.pin(0);
      }
    } else if (mode === "gaze" && lines.length) {
      if (sweep) this.countPass();
      this.hmm.predict(dt, sweep);
      if (inst === "away") this.hmm.observe(null, true, dt);
      else if (gaze && frame?.features) {
        this.hmm.observe(gaze, false, dt);
        if (this.state === "reading") this.hmm.adaptBias(gaze, dt, lineH);
      }
    }
    const best = mode === "gaze" ? this.hmm.best() : { index: -1, prob: 0, off: 0 };
    const confident = best.index >= 0 && best.prob >= 0.6 ? best.index : -1;
    const likely = best.index >= 0 && best.prob >= 0.4 && best.off < 0.5 ? best.index : -1;
    if (confident >= 0) {
      this.confHist.push({ t, line: confident });
      while (this.confHist.length && t - this.confHist[0].t > 6) this.confHist.shift();
    }

    // 4) State machine with hysteresis (so one noisy frame never triggers anything)
    if (inst !== this.candidate.kind) this.candidate = { kind: inst, since: now };
    const held = now - this.candidate.since;
    const onText = this.state === "reading" || this.state === "skimming" || this.state === "pausing";
    if (this.candidate.kind === "away" && held >= 1.2 && this.state !== "away") this.enterState("away", t, "away");
    else if (this.candidate.kind === "offtext" && held >= 2.0 && this.state !== "offtext" && this.state !== "away")
      this.enterState("offtext", t, "offtext");
    else if (this.candidate.kind === "ontext" && (onText || held >= 0.6)) {
      const sub = this.subState(t);
      if (sub !== this.state) this.enterState(sub, t);
    }

    // 5) Dwell: spread this frame's time over the words you're probably looking at
    const nowOnText = this.state === "reading" || this.state === "skimming" || this.state === "pausing";
    if (nowOnText && lines.length) {
      if (mode === "gaze") {
        // The quicker-reacting gaze point follows the eyes along the line; the smooth one lags.
        const x = frame?.features ? (gazeFast ?? gaze)?.x : undefined;
        for (let i = 0; i < lines.length; i++) {
          const share = this.hmm.p[i] * dt;
          if (share < 1e-5) continue;
          const L = lines[i];
          const n = this.wordsIn(L);
          const per = share / n;
          if (x === undefined || n < 3) {
            for (let w = L.firstWord; w <= L.lastWord; w++) this.wordDwell[w] += per;
            continue;
          }
          // Part evenly, part to the words near the eyes (see EVEN_SHARE).
          const width = L.right - L.left;
          const sx = Math.max(50, 0.12 * width);
          let sum = 0;
          const wts = this.scratch.length >= n ? this.scratch : (this.scratch = new Float64Array(n * 2));
          for (let k = 0; k < n; k++) {
            const z = (x - (L.left + ((k + 0.5) / n) * width)) / sx;
            sum += wts[k] = Math.exp(-0.5 * z * z) + 1e-9;
          }
          const near = (share * (1 - EVEN_SHARE)) / sum;
          for (let k = 0; k < n; k++) this.wordDwell[L.firstWord + k] += per * EVEN_SHARE + near * wts[k];
        }
      } else {
        // Without gaze we only know you're facing the page: spread time evenly over it.
        const first = lines[0].firstWord, last = lines[lines.length - 1].lastWord;
        const per = dt / (last - first + 1);
        for (let w = first; w <= last; w++) this.wordDwell[w] += per;
      }
    }

    // 6) Re-reading, place tracking and the place marker (gaze mode only)
    if (mode === "gaze" && lines.length && !this.anchoring) this.trackPlace(likely, now);
    else if (mode === "gaze" && this.anchoring && this.state === "reading") this.place = 0;

    this.onDebug({
      state: this.state,
      gaze,
      line: best.index >= 0 ? lines[best.index] : null,
      lineProb: best.prob,
      offProb: best.off,
      biasY: this.hmm.biasY,
      gain: this.hmm.gain,
      sweeps: this.sweepTimes.length,
      totalSweeps: this.totalSweeps,
      fps,
      face: !!frame?.face,
    });
  }

  private subState(t: number): ReadingState {
    if (this.opts.mode !== "gaze") return "reading";
    const recent = this.confHist.filter((c) => t - c.t <= 4);
    let advance = 0;
    if (recent.length > 4) {
      const span = recent[recent.length - 1].t - recent[0].t;
      if (span > 1.5) advance = (recent[recent.length - 1].line - recent[0].line) / span;
    }
    const sweeps5 = this.sweepTimes.filter((s) => t - s <= 5).length;
    const sweeps12 = this.sweepTimes.filter((s) => t - s <= 12).length;
    // Your normal pace in lines per second on this page, then "much faster than that" = skimming.
    const lines = this.lines;
    const wordsPerLine = lines.length ? lines.reduce((s, l) => s + this.wordsIn(l), 0) / lines.length : 11;
    const skimAdvance = Math.max(0.4, SKIM_SPEEDUP / (wordsPerLine * this.spw));
    // Return sweeps: 4 in 5 s at 240 wpm; scaled to your pace (a fast reader sweeps more often).
    const skimSweeps = Math.max(3, Math.round((4 * SEC_PER_WORD) / this.spw));
    if (advance > skimAdvance || sweeps5 >= skimSweeps) return "skimming";
    if (sweeps12 === 0 && t - (this.pageStart - this.t0) > 12) return "pausing";
    return "reading";
  }

  private enterState(s: ReadingState, t: number, distraction?: DistractionEvent["kind"]) {
    if (s === this.state && !distraction) return;
    // close the current segment
    if (t > this.segStart) this.segments.push({ state: this.state, start: this.segStart, end: t });
    this.segStart = t;
    const wasDistracted = this.state === "away" || this.state === "offtext";
    const nowDistracted = s === "away" || s === "offtext";
    if (this.openDistraction && (!nowDistracted || distraction === "tab")) {
      this.openDistraction.durationSec = t - this.openDistraction.start;
      if (this.openDistraction.durationSec >= 1) this.distractions.push(this.openDistraction);
      this.openDistraction = null;
    }
    if (nowDistracted && distraction && !this.openDistraction) {
      const placeLine = this.place >= 0 ? this.lines[this.place] : this.lines[0];
      this.openDistraction = { kind: distraction, start: t, durationSec: 0, paragraph: placeLine ? placeLine.paragraph : null };
      // Leave a bookmark where you were, so it's waiting when you look back.
      if (this.opts.mode === "gaze" && this.opts.aids && this.place >= 0 && !this.marker) {
        this.setMarker({ line: this.lines[this.place], reason: "away" }, this.lastT ?? 0);
      }
    }
    if (wasDistracted && !nowDistracted && this.marker && this.marker.returnedAt === null) {
      this.marker.returnedAt = this.lastT ?? 0;
    }
    this.state = s;
    this.onState(s);
  }

  private trackPlace(likely: number, now: number) {
    const lines = this.lines;
    // --- re-reading: you jumped back ≥2 lines and stayed there
    if (likely >= 0) {
      if (likely > this.pageMax) this.pageMax = likely;
      if (this.pageMax >= 0 && likely <= this.pageMax - 2) {
        if (!this.regressCandidate || Math.abs(this.regressCandidate.line - likely) > 1)
          this.regressCandidate = { line: likely, since: now, snap: lines.map((l) => this.lineRatio(l)) };
        else if (!this.regressionActive && now - this.regressCandidate.since >= 1.5) {
          this.regressionActive = true;
          const snap = this.regressCandidate.snap;
          // Contiguous runs of previously-read lines between where you went back to and where you were.
          let run: { from: number; to: number } | null = null;
          for (let i = likely; i <= Math.max(likely, this.pageMax - 1); i++) {
            if ((snap[i] ?? 0) >= READ_RATIO) {
              if (run) run.to = lines[i].lastWord;
              else run = { from: lines[i].firstWord, to: lines[i].lastWord };
            } else if (run) {
              this.addRegression(run);
              run = null;
            }
          }
          if (run) this.addRegression(run);
        }
      } else {
        this.regressCandidate = null;
        if (likely >= this.pageMax - 1) this.regressionActive = false;
      }
    }

    // --- your "place": where you were reading (used for the look-away bookmark)
    const reading = this.state === "reading" || this.state === "skimming";
    if (reading && likely >= 0) this.place = likely;

    // --- skipped ahead? Look for a block of ≥3 lines ABOVE where you're now reading
    // that got almost no time, right after lines you did read.
    if (reading && likely >= 3 && now - this.lastSkipScan > 0.5) {
      this.lastSkipScan = now;
      let block: number | null = null;
      for (let i = 0; i <= likely - 2; i++) {
        if (this.flaggedLines.has(lines[i].index)) continue;
        let j = i;
        while (j <= likely - 2 && this.lineRatio(lines[j]) < 0.15) j++;
        const len = j - i;
        // you read something just before the gap (allowing one half-read edge line)
        const readBefore =
          i === 0 ||
          this.lineRatio(lines[i - 1]) >= READ_RATIO ||
          (i >= 2 && this.lineRatio(lines[i - 2]) >= READ_RATIO);
        if (len >= 3 && readBefore) {
          // point at the first line you didn't really read
          block = i > 0 && this.lineRatio(lines[i - 1]) < READ_RATIO ? i - 1 : i;
          break;
        }
        i = Math.max(i, j);
      }
      if (block === null) this.skipCandidate = null;
      else if (!this.skipCandidate || this.skipCandidate.line !== block) this.skipCandidate = { line: block, since: now };
      else if (now - this.skipCandidate.since >= 2 && !this.marker && this.opts.aids && now - this.lastNudgeAt > 30) {
        this.lastNudgeAt = now;
        this.nudges++;
        for (let k = block; k < Math.min(lines.length, block + 3); k++) this.flaggedLines.add(lines[k].index);
        this.setMarker({ line: lines[block], reason: "jump" }, now);
        this.skipCandidate = null;
      }
    }

    // --- hide the marker once you're back on track (or after a while)
    if (this.marker) {
      const m = this.marker;
      const markerIdx = lines.indexOf(m.line);
      const near = likely >= 0 && markerIdx >= 0 && Math.abs(likely - markerIdx) <= 1;
      if (near) m.nearSince ??= now;
      else m.nearSince = null;
      const backOnTrack = m.nearSince !== null && now - m.nearSince > 0.8 && (m.reason === "jump" || m.returnedAt !== null);
      const expired =
        m.reason === "away" ? m.returnedAt !== null && now - m.returnedAt > 6 : now - m.shownAt > 9;
      if (backOnTrack || expired) this.setMarker(null);
    }
  }

  private scratch = new Float64Array(64);

  /** The eyes just finished a line (return sweep or page turn): credit a pass to it. */
  private countPass() {
    const lines = this.lines;
    // Share one whole pass among the lines, by how likely each is (ignoring "off the text").
    let onLines = 0;
    for (let i = 0; i < lines.length; i++) onLines += this.hmm.p[i];
    if (onLines < 0.2) return;
    for (let i = 0; i < lines.length; i++) {
      const p = this.hmm.p[i] / onLines;
      if (p < 0.01) continue;
      for (let w = lines[i].firstWord; w <= lines[i].lastWord; w++) this.wordPasses[w] += p;
    }
  }

  private addRegression(r: { from: number; to: number }) {
    for (let w = r.from; w <= r.to; w++) this.wordRereads[w]++;
    this.regressions.push(r);
  }

  dismissMarker() {
    this.setMarker(null);
  }

  // ---------- final report ----------
  /** Segments and distractions so far, with the currently-open ones closed at time t (no mutation). */
  private closed(t: number) {
    const distractions = [...this.distractions];
    if (this.openDistraction) {
      const d = { ...this.openDistraction, durationSec: t - this.openDistraction.start };
      if (d.durationSec >= 1) distractions.push(d);
    }
    const segments = [...this.segments];
    if (t > this.segStart) segments.push({ state: this.state, start: this.segStart, end: t });
    return { distractions, segments };
  }

  /** Session time so far, in seconds. */
  elapsed(now: number) {
    return now - this.t0;
  }

  /** Everything needed to continue this session later (see ResumeState). */
  exportState(now: number, firstWord: number, calibration: { quality: SessionReport["calibrationQuality"]; errorPx: number | null }): ResumeState {
    const t = now - this.t0;
    const { distractions, segments } = this.closed(t);
    return {
      version: 1,
      elapsedSec: t,
      firstWord,
      wordDwell: Array.from(this.wordDwell, (v) => Math.round(v * 1000) / 1000),
      wordRereads: Array.from(this.wordRereads),
      segments,
      distractions,
      regressions: [...this.regressions],
      nudges: this.nudges,
      pagesTurned: this.pagesTurned,
      totalSweeps: this.totalSweeps,
      calibrationQuality: calibration.quality,
      calibrationErrorPx: calibration.errorPx,
    };
  }

  /** Continue a paused session: the clock picks up at its old elapsed time. */
  restore(s: ResumeState, now: number) {
    this.tap?.restore(s);
    if (s.wordDwell.length === this.wordDwell.length) this.wordDwell.set(s.wordDwell);
    if (s.wordRereads.length === this.wordRereads.length) this.wordRereads.set(s.wordRereads);
    this.segments = [...s.segments];
    this.distractions = [...s.distractions];
    this.regressions = [...s.regressions];
    this.nudges = s.nudges;
    this.pagesTurned = s.pagesTurned;
    this.totalSweeps = s.totalSweeps;
    this.t0 = now - s.elapsedSec;
    this.segStart = s.elapsedSec;
    this.lastT = null;
  }

  buildReport(now: number, paragraphs: string[], calibration: { quality: SessionReport["calibrationQuality"]; errorPx: number | null }): SessionReport {
    const t = now - this.t0;
    const { distractions, segments } = this.closed(t);

    const { totalWords, wordParagraph, paragraphWords } = this.opts;
    const wordStatus: CoverageStatus[] = new Array(totalWords);
    for (let w = 0; w < totalWords; w++) {
      const r = this.wordDwell[w] / this.spw;
      wordStatus[w] = r >= READ_RATIO ? "read" : r >= SKIM_RATIO ? "skimmed" : "skipped";
    }

    const paraStats: ParagraphStat[] = paragraphWords.map((words, index) => ({
      index,
      words,
      status: "skipped" as CoverageStatus,
      coverage: 0,
      dwellSec: 0,
      expectedSec: words * this.spw,
      rereads: 0,
      wpm: null,
    }));
    const readCount = new Array(paragraphs.length).fill(0);
    const skimCount = new Array(paragraphs.length).fill(0);
    let readWords = 0, skimWords = 0, readDwell = 0;
    for (let w = 0; w < totalWords; w++) {
      const p = wordParagraph[w];
      paraStats[p].dwellSec += this.wordDwell[w];
      if (wordStatus[w] === "read") {
        readCount[p]++;
        readWords++;
        readDwell += this.wordDwell[w];
      } else if (wordStatus[w] === "skimmed") {
        skimCount[p]++;
        skimWords++;
      }
    }
    for (const reg of this.regressions) {
      const touched = new Set<number>();
      for (let w = reg.from; w <= reg.to; w++) touched.add(wordParagraph[w]);
      touched.forEach((p) => paraStats[p].rereads++);
    }
    paraStats.forEach((s, p) => {
      const n = Math.max(1, s.words);
      const readShare = readCount[p] / n;
      const seenShare = (readCount[p] + skimCount[p]) / n;
      s.coverage = (readCount[p] + 0.5 * skimCount[p]) / n;
      s.status = readShare >= 0.6 ? "read" : seenShare < 0.35 ? "skipped" : "skimmed";
      // No speed for skipped paragraphs: a glance isn't "reading at N wpm".
      s.wpm = s.status !== "skipped" && s.dwellSec >= 2 && s.coverage > 0 ? Math.round((s.words * s.coverage) / (s.dwellSec / 60)) : null;
      s.dwellSec = Math.round(s.dwellSec * 10) / 10;
      s.expectedSec = Math.round(s.expectedSec * 10) / 10;
    });

    // Lingering far longer than YOUR usual pace on a paragraph also signals re-reading / struggle.
    const ratios = paraStats.filter((p) => p.status === "read" && p.words >= 8).map((p) => p.dwellSec / p.expectedSec).sort((a, b) => a - b);
    const typical = ratios.length ? ratios[ratios.length >> 1] : 1;
    // Lines read twice: more passes than one read needs (about a line's worth or more), AND
    // the extra time to match. Either alone is too easy to get by accident.
    const passWords = new Array(paraStats.length).fill(0);
    for (let w = 0; w < totalWords; w++) passWords[wordParagraph[w]] += this.wordPasses[w];
    const lineWords = this.lineWordsN ? this.lineWordsSum / this.lineWordsN : 11;
    paraStats.forEach((p, i) => {
      if (p.rereads > 0 || p.status !== "read" || p.words < 8) return;
      const extraPassWords = passWords[i] - p.words;
      const extraSec = p.dwellSec - typical * p.expectedSec;
      if (extraPassWords >= EXTRA_PASS_LINES * lineWords && extraSec >= EXTRA_TIME_LINES * lineWords * this.spw) p.rereads = 1;
    });
    for (const p of paraStats) {
      if (p.rereads === 0 && p.status === "read" && p.words >= 8 && p.dwellSec / p.expectedSec >= Math.max(1, typical * 1.6)) p.rereads = 1;
    }

    const distractedSec = distractions.reduce((s, d) => s + d.durationSec, 0);
    const activeSec = Math.max(0, t - distractedSec);
    const avgWpm = readWords >= 30 && readDwell > 0 ? Math.round(Math.min(1200, Math.max(40, readWords / (readDwell / 60)))) : null;

    // merge tiny timeline segments for a clean chart
    const timeline: StateSegment[] = [];
    for (const s of segments) {
      const last = timeline[timeline.length - 1];
      if (last && last.state === s.state) last.end = s.end;
      else if (s.end - s.start >= 0.3) timeline.push({ ...s });
      else if (last) last.end = s.end;
    }

    return {
      durationSec: Math.round(t),
      activeSec: Math.round(activeSec),
      focusPct: t > 0 ? Math.round((activeSec / t) * 1000) / 10 : 100,
      coveragePct: totalWords ? Math.round(((readWords + 0.5 * skimWords) / totalWords) * 1000) / 10 : 0,
      wordsRead: Math.round(readWords + 0.5 * skimWords),
      avgWpm,
      baselineWpm: this.opts.secPerWord ? Math.round(60 / this.opts.secPerWord) : null,
      calibrationQuality: calibration.quality,
      calibrationErrorPx: calibration.errorPx,
      paragraphs: paraStats,
      wordStatus,
      distractions: distractions.map((d) => ({ ...d, start: Math.round(d.start * 10) / 10, durationSec: Math.round(d.durationSec * 10) / 10 })),
      timeline: timeline.map((s) => ({ ...s, start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10 })),
      nudges: this.nudges,
      pagesTurned: this.pagesTurned,
    };
  }
}
