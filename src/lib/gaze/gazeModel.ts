// Calibration: learn a personal mapping from eye features → screen position.
// You look at ~13 dots; we fit ridge regression (a regularised linear model with a
// few curved terms) separately for x and y, choosing the regularisation strength by
// leave-one-dot-out cross-validation so it generalises to places between the dots.
import { dot, median, ridge } from "./linalg";

export interface CalibSample {
  features: number[];
  x: number; // target position (CSS px, viewport coordinates)
  y: number;
  point: number; // which calibration dot this sample belongs to
}

/**
 * Smallest scale (standard deviation) each raw head input is given when fitting, in its own
 * units. Inputs 6-13 are head pose and position (see faceTracker.ts). People hold their head
 * very still while looking at calibration dots, then move it normally while reading. Scaled by
 * the tiny calibration spread, a normal head movement looked like a huge change, and the
 * model's head weights threw the gaze thousands of pixels off the screen. These floors are
 * roughly how much each input varies during ordinary reading (measured in real sessions,
 * 2026-11-14), so the fit can only lean on head position as far as such movement justifies.
 */
const HEAD_SCALE_FLOOR: Record<number, number> = { 6: 0.015, 7: 0.03, 8: 0.05, 9: 0.05, 10: 0.08, 11: 0.012, 12: 0.02, 13: 0.006 };
/**
 * When predicting, each raw input is kept within its calibration range widened by this share
 * of the range (plus the head floor): beyond what calibration saw, a linear model's output is
 * a guess, and a wild one.
 */
const CLAMP_MARGIN = 0.25;

export interface FitOptions {
  /** Apply HEAD_SCALE_FLOOR (default true). */
  headFloor?: boolean;
  /** Clamp inputs to the calibration range when predicting (default true). */
  clamp?: boolean;
}

function expand(f: number[]): number[] {
  const u = (f[0] + f[1]) / 2;
  const v = (f[2] + f[3]) / 2;
  const ap = (f[4] + f[5]) / 2;
  // raw features + a few interaction terms that capture curvature and head/eye coupling
  return [...f, u * u, v * v, u * v, ap * ap, u * f[6], v * f[7], ap * f[7]];
}

/** Everything a fitted GazeModel needs to predict, as plain JSON (for saving a calibration). */
export interface GazeModelState {
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  lambda: number;
  range: { lo: number[]; hi: number[] } | null;
}

const finiteArray = (v: unknown, n?: number): v is number[] =>
  Array.isArray(v) && (n === undefined || v.length === n) && v.every((x) => typeof x === "number" && Number.isFinite(x));

export class GazeModel {
  private constructor(
    private mean: number[],
    private std: number[],
    private wx: number[],
    private wy: number[],
    public readonly lambda: number,
    /** Allowed range of each raw input when predicting (null: no clamping). */
    private range: { lo: number[]; hi: number[] } | null,
  ) {}

  toJSON(): GazeModelState {
    return { mean: this.mean, std: this.std, wx: this.wx, wy: this.wy, lambda: this.lambda, range: this.range };
  }

  /** Rebuild a saved model, or null if the data isn't a consistent model. */
  static fromJSON(v: unknown): GazeModel | null {
    if (!v || typeof v !== "object") return null;
    const s = v as Partial<GazeModelState>;
    const d = Array.isArray(s.mean) ? s.mean.length : 0;
    if (d === 0 || d > 64 || !finiteArray(s.mean, d) || !finiteArray(s.std, d) || !finiteArray(s.wx, d + 1) || !finiteArray(s.wy, d + 1)) return null;
    if (s.std.some((x) => x <= 0) || typeof s.lambda !== "number" || !Number.isFinite(s.lambda)) return null;
    let range: GazeModelState["range"] = null;
    if (s.range) {
      if (!finiteArray(s.range.lo) || !finiteArray(s.range.hi, s.range.lo.length)) return null;
      range = { lo: s.range.lo, hi: s.range.hi };
    }
    return new GazeModel(s.mean, s.std, s.wx, s.wy, s.lambda, range);
  }

  private row(features: number[]): number[] {
    const r = this.range;
    const f = r ? features.map((v, i) => Math.max(r.lo[i], Math.min(r.hi[i], v))) : features;
    const e = expand(f);
    return [1, ...e.map((v, i) => (v - this.mean[i]) / this.std[i])];
  }

  predict(features: number[]): { x: number; y: number } {
    const r = this.row(features);
    return { x: dot(r, this.wx), y: dot(r, this.wy) };
  }

  static fit(samples: CalibSample[], fixedLambda?: number, opts: FitOptions = {}): GazeModel {
    if (samples.length < 10) throw new Error("Not enough calibration data");
    const headFloor = opts.headFloor ?? true, clamp = opts.clamp ?? true;
    const nRaw = samples[0].features.length;
    let range: { lo: number[]; hi: number[] } | null = null;
    if (clamp) {
      const lo = Array.from({ length: nRaw }, (_, i) => Math.min(...samples.map((s) => s.features[i])));
      const hi = Array.from({ length: nRaw }, (_, i) => Math.max(...samples.map((s) => s.features[i])));
      const m = lo.map((l, i) => CLAMP_MARGIN * (hi[i] - l) + (headFloor ? (HEAD_SCALE_FLOOR[i] ?? 0) : 0));
      range = { lo: lo.map((l, i) => l - m[i]), hi: hi.map((h, i) => h + m[i]) };
    }
    const E = samples.map((s) => expand(s.features));
    const d = E[0].length;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const e of E) e.forEach((v, i) => (mean[i] += v / E.length));
    for (const e of E) e.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / E.length));
    const floors = headFloor ? scaleFloors(mean, nRaw) : new Array(d).fill(0);
    for (let i = 0; i < d; i++) std[i] = Math.max(Math.sqrt(std[i]) || 1, floors[i]);

    const X = E.map((e) => [1, ...e.map((v, i) => (v - mean[i]) / std[i])]);
    const xs = samples.map((s) => s.x);
    const ys = samples.map((s) => s.y);

    const fitWith = (lambda: number, keep?: boolean[]) => {
      const idx = keep ? X.map((_, i) => i).filter((i) => keep[i]) : X.map((_, i) => i);
      const Xk = idx.map((i) => X[i]);
      return new GazeModel(mean, std, ridge(Xk, idx.map((i) => xs[i]), lambda), ridge(Xk, idx.map((i) => ys[i]), lambda), lambda, range);
    };

    // Choose λ with leave-one-dot-out cross-validation.
    let lambda = fixedLambda ?? 3;
    if (fixedLambda === undefined) {
      const points = [...new Set(samples.map((s) => s.point))];
      let best = Infinity;
      for (const lam of [0.3, 1, 3, 10, 30, 100]) {
        let err = 0;
        for (const p of points) {
          const keep = samples.map((s) => s.point !== p);
          const m = fitWith(lam, keep);
          samples.forEach((s, i) => {
            if (!keep[i]) {
              const g = m.predict(s.features);
              err += Math.hypot(g.x - s.x, g.y - s.y);
            }
          });
        }
        if (err < best) {
          best = err;
          lambda = lam;
        }
      }
    }

    // Fit, drop outlier samples (moments you glanced away from the dot), refit.
    const first = fitWith(lambda);
    const resid = samples.map((s) => {
      const g = first.predict(s.features);
      return Math.hypot(g.x - s.x, g.y - s.y);
    });
    const cut = Math.max(40, median(resid) * 2.5);
    const keep = resid.map((r) => r <= cut);
    return keep.filter(Boolean).length > samples.length * 0.6 ? fitWith(lambda, keep) : first;
  }
}

/**
 * Scale floors for every expanded input (see expand()): the raw head floors, and for the three
 * terms that multiply a head input by an eye input, that floor times the eye input's typical size.
 */
function scaleFloors(mean: number[], nRaw: number): number[] {
  const f = new Array(mean.length).fill(0);
  for (const [i, v] of Object.entries(HEAD_SCALE_FLOOR)) f[Number(i)] = v;
  // expand() appends to the raw inputs: u², v², u·v, ap², then u·f6, v·f7, ap·f7.
  const u = (mean[0] + mean[1]) / 2, v = (mean[2] + mean[3]) / 2, ap = (mean[4] + mean[5]) / 2;
  f[nRaw + 4] = Math.abs(u) * HEAD_SCALE_FLOOR[6];
  f[nRaw + 5] = Math.abs(v) * HEAD_SCALE_FLOOR[7];
  f[nRaw + 6] = Math.abs(ap) * HEAD_SCALE_FLOOR[7];
  return f;
}

export interface ValidationResult {
  meanErrorPx: number;
  meanAbsDyPx: number;
  meanDyPx: number; // signed: positive = predictions land below the target
  /**
   * Typical vertical error of a single reading (median |dy|), after removing the constant
   * offset the reader corrects by itself. This is what decides whether line tracking works:
   * the per-dot averages above smooth it away. Optional: older saved results lack it.
   */
  jitterDyPx?: number;
  quality: "good" | "fair" | "poor";
}

/**
 * How much vertical scatter the reader's line model should expect (px). Uses the per-reading
 * jitter when known (×1.5: median |error| → standard deviation), never less than the old
 * averaged-error rule, and clamped to a sane range.
 */
export function sigmaYFor(v: ValidationResult, lineH: number): number {
  const fromAvg = v.meanAbsDyPx * 1.3;
  const fromJitter = (v.jitterDyPx ?? 0) * 1.5;
  return Math.min(lineH * 5, Math.max(lineH * 0.7, fromAvg, fromJitter));
}

/** Compare predictions to known dot positions the user looked at. */
export function validate(model: Pick<GazeModel, "predict">, samples: CalibSample[], lineHeightPx: number): ValidationResult {
  // Average predictions per dot first (that's what matters for reading, which is smoothed too).
  const byPoint = new Map<number, { gx: number; gy: number; n: number; x: number; y: number }>();
  for (const s of samples) {
    const g = model.predict(s.features);
    const acc = byPoint.get(s.point) ?? { gx: 0, gy: 0, n: 0, x: s.x, y: s.y };
    acc.gx += g.x;
    acc.gy += g.y;
    acc.n++;
    byPoint.set(s.point, acc);
  }
  let err = 0, absDy = 0, dy = 0;
  for (const a of byPoint.values()) {
    const gx = a.gx / a.n, gy = a.gy / a.n;
    err += Math.hypot(gx - a.x, gy - a.y);
    absDy += Math.abs(gy - a.y);
    dy += gy - a.y;
  }
  const n = Math.max(1, byPoint.size);
  const meanErrorPx = err / n;
  const meanAbsDyPx = absDy / n;
  const meanDyPx = dy / n;
  // Per-reading vertical error, minus the constant offset (the reader learns that offset).
  const jitterDyPx = samples.length ? median(samples.map((s) => Math.abs(model.predict(s.features).y - s.y - meanDyPx))) : 0;
  const lines = meanAbsDyPx / lineHeightPx;
  const jitterLines = jitterDyPx / lineHeightPx;
  // "good" must also mean single readings usually land within ~1 line, or the reader can't
  // tell lines apart, however good the averages look. Jitter thresholds are first guesses.
  const quality =
    meanErrorPx < 140 && lines < 2.2 && jitterLines < 1.2
      ? "good"
      : meanErrorPx < 260 && lines < 4.5 && jitterLines < 2.5
        ? "fair"
        : "poor";
  return { meanErrorPx, meanAbsDyPx, meanDyPx, jitterDyPx, quality };
}
