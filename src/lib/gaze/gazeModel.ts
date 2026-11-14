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

function expand(f: number[]): number[] {
  const u = (f[0] + f[1]) / 2;
  const v = (f[2] + f[3]) / 2;
  const ap = (f[4] + f[5]) / 2;
  // raw features + a few interaction terms that capture curvature and head/eye coupling
  return [...f, u * u, v * v, u * v, ap * ap, u * f[6], v * f[7], ap * f[7]];
}

export class GazeModel {
  private constructor(
    private mean: number[],
    private std: number[],
    private wx: number[],
    private wy: number[],
    public readonly lambda: number,
  ) {}

  private row(features: number[]): number[] {
    const e = expand(features);
    return [1, ...e.map((v, i) => (v - this.mean[i]) / this.std[i])];
  }

  predict(features: number[]): { x: number; y: number } {
    const r = this.row(features);
    return { x: dot(r, this.wx), y: dot(r, this.wy) };
  }

  static fit(samples: CalibSample[], fixedLambda?: number): GazeModel {
    if (samples.length < 10) throw new Error("Not enough calibration data");
    const E = samples.map((s) => expand(s.features));
    const d = E[0].length;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const e of E) e.forEach((v, i) => (mean[i] += v / E.length));
    for (const e of E) e.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / E.length));
    for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]) || 1;

    const X = E.map((e) => [1, ...e.map((v, i) => (v - mean[i]) / std[i])]);
    const xs = samples.map((s) => s.x);
    const ys = samples.map((s) => s.y);

    const fitWith = (lambda: number, keep?: boolean[]) => {
      const idx = keep ? X.map((_, i) => i).filter((i) => keep[i]) : X.map((_, i) => i);
      const Xk = idx.map((i) => X[i]);
      return new GazeModel(mean, std, ridge(Xk, idx.map((i) => xs[i]), lambda), ridge(Xk, idx.map((i) => ys[i]), lambda), lambda);
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

export interface ValidationResult {
  meanErrorPx: number;
  meanAbsDyPx: number;
  meanDyPx: number; // signed: positive = predictions land below the target
  quality: "good" | "fair" | "poor";
}

/** Compare predictions to known dot positions the user looked at. */
export function validate(model: GazeModel, samples: CalibSample[], lineHeightPx: number): ValidationResult {
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
  const lines = meanAbsDyPx / lineHeightPx;
  const quality = meanErrorPx < 140 && lines < 2.2 ? "good" : meanErrorPx < 260 && lines < 4.5 ? "fair" : "poor";
  return { meanErrorPx, meanAbsDyPx, meanDyPx: dy / n, quality };
}
