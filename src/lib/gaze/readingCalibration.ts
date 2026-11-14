// Calibrate by reading: after the dot calibration, the student reads a short passage laid
// out exactly like the reader. Because people read lines in order, we can work out which
// line they were on at each moment (a monotonic alignment of gaze over time), and from that:
//   1. a correction learned from real reading, for both axes and by the same method
//      (vertical: which line you were on; horizontal: how far along it you were), covering
//      the text column itself, which the dot grid only covers loosely; and the gaze scatter
//      during real reading, which tells the reader's line model how much to trust each reading;
//   2. the student's own reading pace, so "read" vs "skimmed" is judged against how fast
//      *they* read rather than an assumed 240 wpm.
import type { GazeEstimator } from "./webEyeTrackSource";

export interface ReadingSample {
  t: number; // seconds
  y: number; // estimated gaze y, CSS px
  x?: number; // estimated gaze x, CSS px (needed for the horizontal correction)
}

/**
 * A 1-D correction, measured → true position, used for each axis. A straight line
 * (true = a * measured + b), optionally bent through knots: measured level `y[i]` belongs to
 * true position `c[i]` (both increasing); between knots it interpolates, beyond them it
 * continues with slope `a`. The bend captures distortions a line can't, e.g. gaze squashed
 * toward the bottom of the screen (eyelids cover more of the iris when you look down) or
 * toward one side, without a rule for any particular region.
 */
export interface AxisMap {
  a: number;
  b: number;
  knots?: { y: number[]; c: number[] };
}

/** Vertical correction at the top level (a, b, knots); horizontal in `x`, when it could be learned. */
export interface ReadingFit extends AxisMap {
  x?: AxisMap;
  /** Typical vertical error of a single reading after the correction (median |dy|, px). */
  jitterPx: number;
  ok: boolean;
  reason?: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  return s[s.length >> 1];
};

/** One line of the calibration passage: where its text sits, and how many words it has. */
export interface CalibLine {
  center: number; // CSS px, viewport
  words: number;
  /** Horizontal extent of the line's text (CSS px); without it there's no horizontal correction. */
  left?: number;
  right?: number;
}

/** True position `c` and the gaze measurements `vals` taken there (for one line, or one x-band). */
interface Group {
  c: number;
  vals: number[];
}

/** Weighted least squares of each group's median on its true position: measured ≈ alpha·c + beta. */
function lineThrough(groups: Group[]): { alpha: number; beta: number } | null {
  const pts = groups.filter((g) => g.vals.length >= 2).map((g) => ({ c: g.c, m: median(g.vals), n: g.vals.length }));
  if (pts.length < 3) return null;
  const W = pts.reduce((s, p) => s + p.n, 0);
  const mc = pts.reduce((s, p) => s + p.n * p.c, 0) / W;
  const mm = pts.reduce((s, p) => s + p.n * p.m, 0) / W;
  const sxx = pts.reduce((s, p) => s + p.n * (p.c - mc) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + p.n * (p.c - mc) * (p.m - mm), 0);
  const alpha = Math.max(0.5, Math.min(2, sxx > 0 ? sxy / sxx : 1));
  return { alpha, beta: mm - alpha * mc };
}

/**
 * Do the groups' levels clearly depart from the straight line? Each group's median is compared
 * with the line relative to the standard error of a median of that many readings (pooled
 * noise), so per-reading jitter can't fake a bend or hide a real one. Threshold: ~3 standard
 * deviations above what noise alone gives (chi-square with one degree of freedom per group).
 *
 * Consecutive readings are not independent: the eyes rest on a word for a while and the
 * tracker smooths its output, so neighbouring readings repeat much of the same error. We
 * measure that (lag-1 autocorrelation of the residuals, in time order within each group) and
 * count readings as n·(1−ρ)/(1+ρ) independent ones; otherwise noise passes for a bend.
 */
function bendIsReal(groups: Group[], alpha: number, beta: number): boolean {
  const res = groups.map((g) => g.vals.map((v) => v - (alpha * g.c + beta)));
  const sigma = 1.4826 * median(res.flat().map(Math.abs));
  if (!sigma) return false;
  let num = 0, den = 0;
  for (const r of res) {
    const m = r.reduce((s, v) => s + v, 0) / (r.length || 1);
    for (let i = 0; i < r.length; i++) {
      den += (r[i] - m) ** 2;
      if (i > 0) num += (r[i] - m) * (r[i - 1] - m);
    }
  }
  const rho = Math.max(0, Math.min(0.95, den > 0 ? num / den : 0));
  const effective = (1 - rho) / (1 + rho);
  let chi2 = 0, used = 0;
  for (const g of groups) {
    if (g.vals.length < 3) continue;
    const se = (1.2533 * sigma) / Math.sqrt(Math.max(1, g.vals.length * effective));
    chi2 += ((median(g.vals) - (alpha * g.c + beta)) / se) ** 2;
    used++;
  }
  return used >= 6 && chi2 > used + 3 * Math.sqrt(2 * used);
}

/**
 * Measured level for each group (in order of c): the line plus each group's residual,
 * smoothed over neighbouring groups (each median has noise of its own), then kept increasing
 * with a minimum slope (where gaze barely moves between groups, inverting would blow noise up).
 */
function bentLevels(groups: Group[], alpha: number, beta: number): number[] {
  const n = groups.length;
  const r = groups.map((g) => (g.vals.length >= 3 ? median(g.vals) - (alpha * g.c + beta) : NaN));
  const m = groups.map((g, i) => {
    let s = 0, w = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
      if (Number.isNaN(r[j])) continue;
      const wj = groups[j].vals.length * (j === i ? 2 : 1);
      s += wj * r[j];
      w += wj;
    }
    return alpha * g.c + beta + (w ? s / w : 0);
  });
  for (let i = 1; i < n; i++) m[i] = Math.max(m[i], m[i - 1] + MIN_RELATIVE_SLOPE * alpha * (groups[i].c - groups[i - 1].c));
  return m;
}

/** Straight line + optional bend through the groups, inverted into a measured → true map. */
function axisMapFrom(groups: Group[]): AxisMap | undefined {
  const lf = lineThrough(groups);
  if (!lf) return undefined;
  const { alpha, beta } = lf;
  const map: AxisMap = { a: 1 / alpha, b: -beta / alpha };
  if (bendIsReal(groups, alpha, beta)) map.knots = { y: bentLevels(groups, alpha, beta), c: groups.map((g) => g.c) };
  return map;
}

/**
 * Weight of the "line took a plausible time" prior, in units of one sample one line off.
 * Tuned on simulated read-throughs (12 lines, gaze noise 0.5–2.5 lines, ±40% pace per line,
 * up to 30% stretch): 120–250 kept the worst line within ~1 line after correction; lower
 * values let the alignment follow the current (wrong) stretch and lock it in.
 */
const DURATION_WEIGHT = 150;

/**
 * Align samples to lines in reading order (a segmentation: line 0 first, then 1, 2, … to the
 * last). Two things decide where one line ends and the next begins:
 *   - gaze: samples should land near where gaze on that line is expected (`predicted[i]`);
 *     errors are in lines and capped, so blinks and glances away can't drag the alignment;
 *   - timing: a line should take time roughly in proportion to its words. Without this, the
 *     whole alignment can slip by a line (the offset absorbing it) and fit the gaze just as well.
 * Exact dynamic programming over segment boundaries: O(lines × samples²), tiny here.
 */
export function alignToLines(ys: number[], predicted: number[], words: number[], lineH: number): number[] {
  return alignWithCost(ys, predicted, words, lineH).assign;
}

/** alignToLines, plus the total cost of the best alignment (gaze misfit + timing penalty). */
function alignWithCost(ys: number[], predicted: number[], words: number[], lineH: number): { assign: number[]; cost: number } {
  const T = ys.length, L = predicted.length;
  const totalWords = words.reduce((a, b) => a + b, 0) || L;
  const expected = words.map((w) => (Math.max(1, w) / totalWords) * T); // samples per line
  const maxDur = expected.map((x) => Math.ceil(Math.max(10, 5 * x)));
  // prefix sums of capped squared error (in lines) per line
  const pre: Float64Array[] = predicted.map((m) => {
    const a = new Float64Array(T + 1);
    for (let t = 0; t < T; t++) a[t + 1] = a[t] + Math.min(9, ((ys[t] - m) / lineH) ** 2);
    return a;
  });
  const segCost = (i: number, s: number, e: number) => {
    const dur = e - s;
    const r = Math.log((dur + 1) / (expected[i] + 1));
    return pre[i][e] - pre[i][s] + DURATION_WEIGHT * r * r;
  };
  // D[i][e]: best cost with lines 0..i covering samples [0, e); each line gets ≥ 1 sample.
  const D = predicted.map(() => new Float64Array(T + 1).fill(Infinity));
  const back = predicted.map(() => new Int32Array(T + 1));
  for (let e = 1; e <= T - (L - 1); e++) D[0][e] = segCost(0, 0, e);
  for (let i = 1; i < L; i++) {
    for (let e = i + 1; e <= T - (L - 1 - i); e++) {
      let best = Infinity, arg = i;
      // A line can't plausibly take more than ~5× its expected time; looking further back
      // only costs time (O(lines × samples²) otherwise, slow for a 45 s read at 30 fps).
      for (let s = Math.max(i, e - maxDur[i]); s < e; s++) {
        const prev = D[i - 1][s];
        if (prev === Infinity) continue;
        const c = prev + segCost(i, s, e);
        if (c < best) {
          best = c;
          arg = s;
        }
      }
      D[i][e] = best;
      back[i][e] = arg;
    }
  }
  const assign = new Array<number>(T);
  let e = T;
  for (let i = L - 1; i >= 0; i--) {
    const s = i === 0 ? 0 : back[i][e];
    for (let t = s; t < e; t++) assign[t] = i;
    e = s;
  }
  return { assign, cost: D[L - 1][T] };
}

/**
 * Fit the vertical correction from one read-through. We model the *measured* gaze as
 * y = alpha * lineCenter + beta + noise (the noise is in the gaze, the line positions are
 * exact, so this is the unbiased direction to regress), alternating with the alignment,
 * then invert it into a correction.
 */
export function fitReadingCalibration(samples: ReadingSample[], lines: CalibLine[], lineH: number): ReadingFit {
  const fail = (reason: string): ReadingFit => ({ a: 1, b: 0, jitterPx: 0, ok: false, reason });
  const L = lines.length, T = samples.length;
  if (L < 3) return fail("passage too short");
  if (T < 6 * L) return fail("not enough gaze readings");
  const centers = lines.map((l) => l.center);
  const words = lines.map((l) => l.words);
  const ys = samples.map((s) => s.y);
  const groupsOf = (asg: number[]): Group[] => centers.map((c, i) => ({ c, vals: ys.filter((_, t) => asg[t] === i) }));
  // Alternate: line through the per-line levels ⇄ alignment, from a given starting offset.
  // The first rounds fit only the offset (no stretch): the dot calibration already gets the
  // scale roughly right, and fitting a stretch to a rough first alignment can lock it in.
  const OFFSET_ONLY_ROUNDS = 2;
  const fitFrom = (beta0: number) => {
    let alpha = 1, beta = beta0;
    let { assign, cost } = alignWithCost(ys, centers.map((c) => c + beta), words, lineH);
    for (let iter = 0; iter < 10; iter++) {
      const lf = lineThrough(groupsOf(assign));
      if (!lf) return null;
      if (iter < OFFSET_ONLY_ROUNDS) {
        const g = groupsOf(assign).filter((x) => x.vals.length >= 2);
        const W = g.reduce((s, x) => s + x.vals.length, 0);
        beta = g.reduce((s, x) => s + x.vals.length * (median(x.vals) - x.c), 0) / W;
      } else {
        alpha = lf.alpha;
        beta = lf.beta;
      }
      const next = alignWithCost(ys, centers.map((c) => alpha * c + beta), words, lineH);
      const same = next.assign.every((v, t) => v === assign[t]);
      assign = next.assign;
      cost = next.cost;
      if (same && iter >= OFFSET_ONLY_ROUNDS) break;
    }
    return { alpha, beta, assign, cost };
  };
  // Starting offset: gaze median minus the median line position *weighted by reading time*
  // (≈ words per line; a short last line holds few readings). An alignment can still settle
  // a line off (the offset absorbing it), so also start one and two lines either side and
  // keep whichever explains the gaze and the timing best.
  const byTime = centers.map((c, i) => ({ c, w: words[i] })).sort((p, q) => p.c - q.c);
  const half = words.reduce((s, w) => s + w, 0) / 2;
  let acc = 0, midC = byTime[byTime.length - 1].c;
  for (const p of byTime) if ((acc += p.w) >= half) { midC = p.c; break; }
  const start = median(ys) - midC;
  let best: NonNullable<ReturnType<typeof fitFrom>> | null = null;
  for (const k of [0, -1, 1, -2, 2]) {
    const r = fitFrom(start + k * lineH);
    if (r && (!best || r.cost < best.cost)) best = r;
  }
  if (!best) return fail("couldn't follow the lines");
  const { alpha, beta } = best;
  let assign = best.assign;
  const a = 1 / alpha, b = -beta / alpha;

  // ---- Optional bend, from each line's own measured level (shared with the x axis) ----
  let knots: ReadingFit["knots"];
  if (L >= 6 && bendIsReal(groupsOf(assign), alpha, beta)) {
    // Re-align with the bent levels (lines near a bend may have been mis-split), then re-level.
    const assign2 = alignToLines(ys, bentLevels(groupsOf(assign), alpha, beta), words, lineH);
    knots = { y: bentLevels(groupsOf(assign2), alpha, beta), c: [...centers] };
    assign = assign2;
  }

  // ---- Horizontal, by the same method: where along each line you were ----
  const x = fitHorizontal(samples, lines, assign);

  const fitNoJitter = { a, b, knots };
  const correct = (y: number) => correctY(fitNoJitter, y);
  // Two jitter estimates; keep the larger.
  //  - against the assigned lines: can come out too small, since the alignment is free to
  //    put a noisy reading on whichever line it lands nearest;
  //  - from readings ~0.4 s apart (past the tracker's own smoothing, but usually still on
  //    the same line): for Gaussian noise, median |difference| ≈ 1.41 × median |error|.
  const vsLines = median(ys.map((y, t) => Math.abs(correct(y) - centers[assign[t]])));
  const diffs: number[] = [];
  for (let t = 0, k = 0; t < T; t++) {
    while (k < t && samples[t].t - samples[k].t > 0.4) k++;
    if (k > 0 && samples[t].t - samples[k - 1].t >= 0.4) diffs.push(Math.abs(correct(ys[t]) - correct(ys[k - 1])));
  }
  const fromDiffs = diffs.length >= 20 ? median(diffs) / Math.SQRT2 : 0;
  const jitterPx = Math.max(vsLines, fromDiffs);
  if (jitterPx > 3 * lineH) return { a, b, knots, x, jitterPx, ok: false, reason: "gaze too scattered to follow the lines" };
  return { a, b, knots, x, jitterPx, ok: true };
}

/** Number of bands across the column for the horizontal fit (≥ 6 lets a bend be detected). */
const X_BANDS = 8;
/**
 * Readings this close (s) to a line's start / end are left out of the horizontal fit: around
 * each line change the reported gaze is still in transit (the return sweep, plus the tracker
 * reporting where the eyes were a moment ago), so it would be paired with the wrong place on
 * the line — e.g. the previous line's end counted as this line's start.
 */
const X_SKIP_START = 0.15;
const X_SKIP_END = 0.1;

/**
 * Horizontal correction. Once we know which line each reading belongs to (and so when each
 * line started and ended), the expected x of a reading follows from how far through that
 * line's time it was (ignoring the moments around each line change, see X_SKIP_START): reading moves left to right at a roughly steady pace. Pace varies
 * within a line, but that error is independent of the expected position (a Berkson error),
 * so fitting measured x against expected x stays unbiased. The eyes' first and last
 * fixations on a line land about half a word in from its ends, so the expected range is
 * inset by half the passage's average word width. Readings are grouped into bands across
 * the column and fitted exactly like the vertical axis (line, plus a bend only if it's real).
 */
function fitHorizontal(samples: ReadingSample[], lines: CalibLine[], assign: number[]): AxisMap | undefined {
  if (lines.some((l) => l.left === undefined || l.right === undefined) || samples.some((s) => s.x === undefined)) return undefined;
  const totalW = lines.reduce((s, l) => s + (l.right! - l.left!), 0);
  const totalWords = lines.reduce((s, l) => s + l.words, 0) || 1;
  const inset = 0.5 * (totalW / totalWords);
  const pairs: { ex: number; x: number }[] = [];
  let s = 0;
  while (s < assign.length) {
    let e = s;
    while (e < assign.length && assign[e] === assign[s]) e++;
    const line = lines[assign[s]];
    const n = e - s;
    const span = Math.max(0, line.right! - line.left! - 2 * inset);
    if (n >= 6 && span > 0) {
      const t0 = samples[s].t, t1 = samples[e - 1].t;
      for (let t = s; t < e; t++) {
        if (samples[t].t - t0 < X_SKIP_START || t1 - samples[t].t < X_SKIP_END) continue;
        pairs.push({ ex: line.left! + inset + ((t - s + 0.5) / n) * span, x: samples[t].x! });
      }
    }
    s = e;
  }
  if (pairs.length < 30) return undefined;
  // Bands with equal numbers of readings (not equal widths): every part of the line, the
  // margins included, gets the same weight. Readings keep their time order within a band.
  const order = pairs.map((_, i) => i).sort((i, j) => pairs[i].ex - pairs[j].ex);
  const bandOf = new Int32Array(pairs.length);
  order.forEach((i, rank) => (bandOf[i] = Math.min(X_BANDS - 1, Math.floor((rank * X_BANDS) / pairs.length))));
  const bands: { sum: number; vals: number[] }[] = Array.from({ length: X_BANDS }, () => ({ sum: 0, vals: [] }));
  pairs.forEach((p, i) => {
    bands[bandOf[i]].sum += p.ex;
    bands[bandOf[i]].vals.push(p.x);
  });
  const groups: Group[] = bands.filter((b) => b.vals.length >= 3).map((b) => ({ c: b.sum / b.vals.length, vals: b.vals }));
  return groups.length >= 4 ? axisMapFrom(groups) : undefined;
}

/** Lowest allowed slope of the bend, relative to the straight line (see `bent` above). */
const MIN_RELATIVE_SLOPE = 0.2;

/** Corrected position for a measured one, on one axis: through the knots if any, else the line. */
export function correctY(fit: AxisMap, y: number): number {
  const k = fit.knots;
  if (!k || k.y.length < 2) return fit.a * y + fit.b;
  const n = k.y.length;
  if (y <= k.y[0]) return k.c[0] + fit.a * (y - k.y[0]);
  if (y >= k.y[n - 1]) return k.c[n - 1] + fit.a * (y - k.y[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k.y[mid] <= y) lo = mid;
    else hi = mid;
  }
  const f = (y - k.y[lo]) / (k.y[hi] - k.y[lo]);
  return k.c[lo] + f * (k.c[hi] - k.c[lo]);
}

/** Apply the reading calibration's corrections (vertical, and horizontal when learned) to any estimator. */
export function withReadingCorrection(est: GazeEstimator, fit: Pick<ReadingFit, "a" | "b" | "knots" | "x">): GazeEstimator {
  return {
    predict: (f) => {
      const g = est.predict(f);
      return g ? { x: fit.x ? correctY(fit.x, g.x) : g.x, y: correctY(fit, g.y) } : null;
    },
  };
}

// ---------- personal reading pace ----------

/** Plausible range for a normal read-through; outside it we don't trust the measurement. */
export const PACE_MIN_WPM = 80;
export const PACE_MAX_WPM = 700;
const PACE_KEY = "ra-pace";

/** Reading pace from one read-through, or null if it's implausible (e.g. they just skimmed it). */
export function paceFrom(words: number, seconds: number): { wpm: number; secPerWord: number } | null {
  if (words <= 0 || seconds <= 0) return null;
  const wpm = words / (seconds / 60);
  if (wpm < PACE_MIN_WPM || wpm > PACE_MAX_WPM) return null;
  return { wpm: Math.round(wpm), secPerWord: 60 / wpm };
}

/** The last measured pace on this browser (used when the reading step is skipped). */
export function loadPace(): { wpm: number; secPerWord: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PACE_KEY) ?? "null") as { wpm?: number } | null;
    if (!p?.wpm || p.wpm < PACE_MIN_WPM || p.wpm > PACE_MAX_WPM) return null;
    return { wpm: p.wpm, secPerWord: 60 / p.wpm };
  } catch {
    return null;
  }
}

export function savePace(wpm: number) {
  try {
    localStorage.setItem(PACE_KEY, JSON.stringify({ wpm, at: new Date().toISOString() }));
  } catch {
    /* storage unavailable: the pace still applies to this session */
  }
}
