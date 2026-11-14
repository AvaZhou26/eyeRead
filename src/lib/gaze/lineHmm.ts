// Which line is the reader on? A Hidden Markov Model answers that from noisy gaze.
//
// Webcam gaze is only accurate to a few lines vertically, so we don't trust any single
// point. Instead we combine two things:
//   1. Where the gaze *roughly* is (a Gaussian around each line's centre), and
//   2. How reading works: you usually stay on a line, and after a "return sweep"
//      (the big leftward jump at the end of a line) you're almost always on the NEXT line.
// The result is a probability for every line on the page (plus "off the text").
// This is the online cousin of the Warp/Attach drift-correction algorithms used in
// reading research (Carr et al., 2021).

export interface LineBox {
  index: number; // global line index across the whole layout
  page: number;
  top: number; // viewport px when this page is showing
  bottom: number;
  left: number;
  right: number;
  firstWord: number; // global word indices (inclusive)
  lastWord: number;
  paragraph: number;
}

/** Roughly how many seconds of webcam gaze make one independent observation. */
const EVIDENCE_SEC = 0.35;
/** Bias learning: default time constant (s). */
const BIAS_TAU = 4;
/**
 * Noise of a jump's measured vertical size, relative to sigmaY. The jump is the difference of
 * two short averages of lightly smoothed gaze, so it is noisier than one line's position
 * estimate is per second, yet much less noisy than a single frame. Tuned in
 * scripts/simulate-reread.ts.
 */
const JUMP_DY_SIGMA = 0.6;
const JUMP_DY_SCALE = 0.65;
/** Where a big leftward jump lands, before its dy is weighed (see predict()). Sums to 1. */
const JUMP_NEXT = 0.65;
const JUMP_SAME = 0.15;
const JUMP_BACK = 0.15;
const JUMP_SKIP = 0.05;
const JUMP_OFF = 1 - JUMP_NEXT - JUMP_SAME - JUMP_BACK - JUMP_SKIP;

export interface HmmObservation {
  x: number;
  y: number;
}

export class LineHmm {
  lines: LineBox[] = [];
  /** posterior over [line 0..N-1, OFF] */
  p: Float64Array = new Float64Array(1);
  biasY = 0;
  /** Time constant (s) of the offset learning (see learnBias). */
  readonly biasTau = BIAS_TAU;
  /**
   * Vertical stretch of the gaze relative to the page (1 = none). A webcam calibration is
   * often right near the top of the page but squashed or stretched further down; a single
   * offset (biasY) can't fix that. Measured across the first line, which is where biasY is
   * learned: seen y = gainRef + gain × (true y − gainRef) + biasY.
   */
  gain = 1;
  private gainRef = 0;

  constructor(
    public sigmaY: number,
    private sigmaX: number,
  ) {}

  setLines(lines: LineBox[], start: "top" | "spread" = "top") {
    this.lines = lines;
    const n = lines.length;
    this.p = new Float64Array(n + 1);
    if (n === 0) {
      this.p[0] = 1;
      return;
    }
    this.gainRef = (lines[0].top + lines[0].bottom) / 2;
    if (start === "top") {
      // A new page: you most likely start at the first line.
      for (let i = 0; i < n; i++) this.p[i] = Math.exp(-i / 1.5);
    } else {
      this.p.fill(1);
    }
    this.p[n] = 0.05;
    this.normalize();
  }

  private normalize() {
    let s = 0;
    for (let i = 0; i < this.p.length; i++) s += this.p[i];
    if (s <= 0 || !Number.isFinite(s)) {
      this.p.fill(1 / this.p.length);
      return;
    }
    for (let i = 0; i < this.p.length; i++) this.p[i] /= s;
  }

  /** Where the camera's gaze should land (raw y) when the reader looks at page height `y`. */
  private seenY(y: number): number {
    return this.gainRef + this.gain * (y - this.gainRef) + this.biasY;
  }

  /** Turn a raw gaze y into a page y, undoing the learned offset and stretch. */
  correctY(rawY: number): number {
    return this.gainRef + (rawY - this.biasY - this.gainRef) / this.gain;
  }

  /**
   * Advance time by dt seconds. `jump` = a big leftward jump of the gaze was just detected:
   * usually the return sweep to the next line, but it may also be a hop back within the line
   * or a jump back to re-read. When its vertical size `dy` (raw px) is known, it is evidence
   * for where it landed: each move i → j is weighted by how well `dy` matches the distance
   * between those lines. Normalising over all moves together (not per starting line) also
   * lets the jump tell us about the line it started from.
   */
  predict(dt: number, jump: boolean | { dy: number }) {
    const n = this.lines.length;
    if (n === 0) return;
    const rate = (r: number) => 1 - Math.exp(-r * dt);
    const next = new Float64Array(n + 1);
    const dy = typeof jump === "object" ? jump.dy : null;
    const sJ = this.sigmaY * JUMP_DY_SIGMA;
    const centre = (i: number) => (this.lines[i].top + this.lines[i].bottom) / 2;
    // Likelihood of the jump's dy for a move i → j (1 when dy is unknown or no jump).
    const fit = (i: number, j: number) => (dy === null ? 1 : Math.exp(-0.5 * ((dy - JUMP_DY_SCALE * this.gain * (centre(j) - centre(i))) / sJ) ** 2));
    const offFit = dy === null ? 1 : Math.exp(-0.5 * 2.6 * 2.6);

    if (jump) {
      // Where a big leftward jump lands: usually the next line; sometimes a hop back within the
      // line, a jump back to re-read (nearer lines likelier) or a skip ahead. The backward share
      // must be real: if it is tiny, no measured dy can make the model believe a jump back.
      for (let i = 0; i < n; i++) {
        const m = this.p[i];
        if (m === 0) continue;
        let same = JUMP_SAME;
        if (i + 1 < n) next[i + 1] += m * JUMP_NEXT * fit(i, i + 1);
        else same += JUMP_NEXT;
        if (i > 0) {
          let h = 0;
          for (let k = 1; k <= i; k++) h += 1 / k;
          for (let k = 1; k <= i; k++) next[i - k] += (m * JUMP_BACK * fit(i, i - k)) / k / h;
        } else same += JUMP_BACK;
        if (i + 2 < n) {
          let wsum = 0;
          for (let j = i + 2; j < n; j++) wsum += 1 / Math.sqrt(1 + j - i);
          for (let j = i + 2; j < n; j++) next[j] += (m * JUMP_SKIP * fit(i, j)) / Math.sqrt(1 + j - i) / wsum;
        } else same += JUMP_SKIP;
        next[n] += m * JUMP_OFF * offFit;
        next[i] += m * same * fit(i, i);
      }
    } else {
      const pNext = rate(0.1), pPrev = rate(0.04), pJump = rate(0.2), pOff = rate(0.15);
      this.wander(next, pNext, pPrev, pJump, pOff);
    }
    // From OFF you come back to any line (the gaze decides which).
    const off = this.p[n];
    const back = rate(1.5);
    for (let j = 0; j < n; j++) next[j] += (off * back) / n;
    next[n] += off * (1 - back);
    this.p = next;
    this.normalize();
  }

  /** Between jumps: mostly stay; occasionally move a line, jump anywhere, or leave the text. */
  private wander(next: Float64Array, pNext: number, pPrev: number, pJump: number, pOff: number) {
    const n = this.lines.length;
    for (let i = 0; i < n; i++) {
      const m = this.p[i];
      if (m === 0) continue;
      let stay = 1 - pNext - pPrev - pJump - pOff;
      if (i + 1 < n) next[i + 1] += m * pNext;
      else stay += pNext;
      if (i > 0) next[i - 1] += m * pPrev;
      else stay += pPrev;
      // Jumps can land anywhere (mildly preferring nearby lines), so a real skip is
      // followed quickly instead of the model "walking" through the skipped lines.
      let wsum = 0;
      for (let j = 0; j < n; j++) if (j !== i) wsum += 1 / Math.sqrt(1 + Math.abs(j - i));
      for (let j = 0; j < n; j++) if (j !== i) next[j] += (m * pJump * (1 / Math.sqrt(1 + Math.abs(j - i)))) / (wsum || 1);
      next[n] += m * pOff;
      next[i] += m * stay;
    }
  }

  /**
   * Update with a gaze point, or with `null` + faceMissing when the reader looked away.
   * Consecutive webcam frames are highly correlated (and smoothed), so each frame only
   * counts as a fraction of an independent observation: weight = dt / EVIDENCE_SEC.
   * Without this, 30 noisy frames/sec would overpower the reading-order logic.
   */
  observe(obs: HmmObservation | null, faceMissing: boolean, dt = 1 / 30) {
    const n = this.lines.length;
    if (n === 0) return;
    const w = Math.min(1, dt / EVIDENCE_SEC);
    if (faceMissing) {
      const k = Math.pow(0.05, w);
      for (let i = 0; i < n; i++) this.p[i] *= k;
      this.normalize();
      return;
    }
    if (!obs) return;
    const colLeft = this.lines[0].left;
    const colRight = Math.max(...this.lines.map((l) => l.right));
    for (let i = 0; i < n; i++) {
      const L = this.lines[i];
      const cy = (L.top + L.bottom) / 2;
      const z = (obs.y - this.seenY(cy)) / this.sigmaY;
      // Horizontal fit: gaze far right of a SHORT line (e.g. a paragraph's last line)
      // makes that line less likely. This gives the model landmarks to lock onto.
      const right = Math.max(L.right, colLeft + (colRight - colLeft) * 0.15);
      const dxOut = obs.x < colLeft ? colLeft - obs.x : obs.x > right ? obs.x - right : 0;
      const hx = Math.exp(-0.5 * (dxOut / this.sigmaX) ** 2);
      this.p[i] *= Math.pow(Math.exp(-0.5 * z * z) * hx + 1e-6, w);
    }
    // "Off the text" is a flat likelihood: wins only when the gaze is far from every line.
    this.p[n] *= Math.pow(Math.exp(-0.5 * 2.6 * 2.6), w);
    this.normalize();
  }

  /** Pin the posterior to one line (used while we know where the reader is). */
  pin(index: number) {
    this.p.fill(0);
    this.p[Math.max(0, Math.min(this.lines.length - 1, index))] = 1;
  }

  /** The offset this gaze y implies if the reader is on line `index` (gain applied, bias not). */
  offsetFor(y: number, index: number): number {
    const L = this.lines[index];
    return y - (this.seenY((L.top + L.bottom) / 2) - this.biasY);
  }

  /**
   * Move the offset toward `target`, as if `sec` seconds of reading had shown it (time constant
   * biasTau), limited to `lo`..`hi`. The caller decides which moments are trustworthy evidence.
   */
  learnBias(target: number, sec: number, lo: number, hi: number) {
    const alpha = 1 - Math.exp(-sec / this.biasTau);
    this.biasY = Math.max(lo, Math.min(hi, this.biasY + alpha * (target - this.biasY)));
  }

  best(): { index: number; prob: number; off: number } {
    const n = this.lines.length;
    let bi = -1, bp = 0;
    for (let i = 0; i < n; i++) if (this.p[i] > bp) { bp = this.p[i]; bi = i; }
    return { index: bi, prob: bp, off: n ? this.p[n] : 1 };
  }
}
