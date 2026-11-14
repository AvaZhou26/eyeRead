// One Euro filter (Casiez et al. 2012): smooths jittery signals heavily when they're
// still, but lightly when they move fast, so the gaze point is steady yet responsive.
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset() {
    this.y = null;
  }
}

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;
  constructor(
    private minCutoff = 1.0,
    private beta = 0.007,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, tSec: number): number {
    const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, tSec - this.lastT);
    this.lastT = tSec;
    const prev = this.x.last();
    const deriv = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(deriv, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, this.alpha(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}
