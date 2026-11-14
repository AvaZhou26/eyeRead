// Runs Google's MediaPipe Face Landmarker on the webcam (in the browser, on-device)
// and turns its 478 face points into a compact "eye feature" vector each frame.
// The calibration model later maps these features to a point on the screen.
import type { FaceLandmarker, FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface FaceFrame {
  t: number; // seconds (performance.now / 1000)
  face: boolean; // was a face found?
  blink: boolean; // eyes (mostly) closed this frame
  features: number[] | null; // null if no face or blinking
  yaw: number; // head turn left/right, radians (approx)
  pitch: number; // head tilt up/down, radians (approx)
  faceSize: number; // eye-corner distance / image width (distance proxy)
  faceX: number; // 0..1 horizontal face position in the image
  faceY: number;
  brightness: number | null; // 0..255 average image brightness (sampled ~1/sec)
}

// MediaPipe landmark indices
const EYE_A = { c1: 33, c2: 133, top: 159, bottom: 145 };
const EYE_B = { c1: 362, c2: 263, top: 386, bottom: 374 };
const IRIS_1 = 468;
const IRIS_2 = 473;
const NOSE = 1;

type Listener = (f: FaceFrame) => void;
/** Raw per-frame MediaPipe output, for experimental feature sources (see /gaze-lab). */
export type RawListener = (r: FaceLandmarkerResult, video: HTMLVideoElement, f: FaceFrame) => void;

/**
 * MediaPipe's WebAssembly prints its own status lines (e.g. "INFO: Created TensorFlow Lite
 * XNNPACK delegate for CPU.", or glog lines like "W1113 ...") through console.error. They
 * aren't errors, but Next.js's dev overlay counts them as issues ("1 Issue" badge).
 * The WebAssembly grabs console.error ONCE when it loads, so this filter must be installed
 * before the model is loaded. It drops only MediaPipe's log lines; everything else passes.
 */
const MEDIAPIPE_LOG = /^(INFO|WARNING|VERBOSE):|^[IWV]\d{4} /;
let logFilterInstalled = false;
function installMediapipeLogFilter() {
  if (logFilterInstalled || typeof console === "undefined") return;
  logFilterInstalled = true;
  const original = console.error;
  console.error = function (...args: unknown[]) {
    if (typeof args[0] === "string" && MEDIAPIPE_LOG.test(args[0])) return;
    return original.apply(console, args);
  };
}
// Install as early as possible: as soon as this file loads in the browser.
if (typeof window !== "undefined") installMediapipeLogFilter();

interface Pt {
  x: number;
  y: number;
}

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private listeners = new Set<Listener>();
  private rawListeners = new Set<RawListener>();
  private apertureBaseline = 0;
  private smooth: number[] | null = null;
  private frameCount = 0;
  private lastBrightness: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastFrameAt = 0;
  private lastTimestamp = 0;
  fps = 0;

  /** Load the MediaPipe model (≈4 MB, cached by the browser after the first time). */
  async init(): Promise<void> {
    installMediapipeLogFilter();
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("CPU"));
    }
  }

  /** Ask for the camera and start processing frames. */
  async start(video: HTMLVideoElement): Promise<void> {
    if (!this.landmarker) await this.init();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 30 } },
      audio: false,
    });
    this.attach(video);
    this.loop();
  }

  /** Point the tracker at a (new) <video> element, keeping the same camera stream. */
  attach(video: HTMLVideoElement) {
    if (!this.stream) return;
    this.video = video;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {});
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeRaw(fn: RawListener): () => void {
    this.rawListeners.add(fn);
    return () => this.rawListeners.delete(fn);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const video = this.video;
    if (!video || !this.landmarker || video.readyState < 2) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    const nowMs = performance.now();
    if (this.lastFrameAt) this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, nowMs - this.lastFrameAt));
    this.lastFrameAt = nowMs;

    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(nowMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;

    let frame: FaceFrame;
    let res: FaceLandmarkerResult | null = null;
    try {
      res = this.landmarker.detectForVideo(video, ts);
      const lm = res.faceLandmarks?.[0];
      const matrix = res.facialTransformationMatrixes?.[0]?.data;
      frame = lm ? this.extract(lm, matrix, video, nowMs / 1000) : this.empty(nowMs / 1000);
    } catch {
      frame = this.empty(nowMs / 1000);
    }
    if (this.frameCount++ % 30 === 0) this.lastBrightness = this.sampleBrightness(video);
    frame.brightness = this.lastBrightness;
    if (res) for (const fn of this.rawListeners) fn(res, video, frame);
    for (const fn of this.listeners) fn(frame);
  };

  private empty(t: number): FaceFrame {
    return { t, face: false, blink: false, features: null, yaw: 0, pitch: 0, faceSize: 0, faceX: 0.5, faceY: 0.5, brightness: null };
  }

  private extract(lm: NormalizedLandmark[], matrix: number[] | undefined, video: HTMLVideoElement, t: number): FaceFrame {
    const W = video.videoWidth || 640;
    const H = video.videoHeight || 480;
    const P = (i: number): Pt => ({ x: lm[i].x * W, y: lm[i].y * H });

    // Each iris belongs to whichever eye's centre it's closer to (robust to index conventions).
    const eyeCenter = (e: typeof EYE_A) => {
      const a = P(e.c1), b = P(e.c2);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const i1 = P(IRIS_1), i2 = P(IRIS_2);
    const cA = eyeCenter(EYE_A);
    const d = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
    const [irisA, irisB] = d(i1, cA) < d(i2, cA) ? [i1, i2] : [i2, i1];

    const eye = (e: typeof EYE_A, iris: Pt) => {
      let p1 = P(e.c1), p2 = P(e.c2);
      if (p1.x > p2.x) [p1, p2] = [p2, p1]; // left-to-right in the image
      const ax = p2.x - p1.x, ay = p2.y - p1.y;
      const w = Math.hypot(ax, ay) || 1;
      const u = ((iris.x - p1.x) * ax + (iris.y - p1.y) * ay) / (w * w); // 0..1 along the eye
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const v = ((iris.x - mx) * -ay + (iris.y - my) * ax) / (w * w); // perpendicular offset
      const top = P(e.top), bottom = P(e.bottom);
      const aperture = d(top, bottom) / w;
      return { u, v, aperture, w };
    };
    const A = eye(EYE_A, irisA);
    const B = eye(EYE_B, irisB);

    // Head pose from the 4×4 facial transformation matrix (column-major).
    let fx = 0, fy = 0, tx = 0, ty = 0, tz = 0;
    if (matrix && matrix.length >= 16) {
      fx = matrix[8];
      fy = matrix[9];
      tx = matrix[12];
      ty = matrix[13];
      tz = matrix[14];
    }
    const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
    const yaw = Math.asin(clamp1(fx));
    const pitch = Math.asin(clamp1(-fy));

    const nose = P(NOSE);
    const outerA = P(33), outerB = P(263);
    const faceSize = d(outerA, outerB) / W;

    // Blink detection: eye opening far below this person's normal opening.
    const ap = (A.aperture + B.aperture) / 2;
    if (this.apertureBaseline === 0) this.apertureBaseline = ap;
    const blink = ap < this.apertureBaseline * 0.55;
    if (!blink) this.apertureBaseline = 0.97 * this.apertureBaseline + 0.03 * ap;

    const raw = [A.u, B.u, A.v, B.v, A.aperture, B.aperture, fx, fy, tx / 10, ty / 10, tz / 10, nose.x / W, nose.y / H, faceSize];
    let features: number[] | null = null;
    if (!blink) {
      // Light smoothing of landmark jitter before it reaches the gaze model.
      this.smooth = this.smooth ? this.smooth.map((s, i) => 0.55 * raw[i] + 0.45 * s) : raw;
      features = this.smooth;
    }
    return {
      t,
      face: true,
      blink,
      features,
      yaw,
      pitch,
      faceSize,
      faceX: nose.x / W,
      faceY: nose.y / H,
      brightness: null,
    };
  }

  private sampleBrightness(video: HTMLVideoElement): number | null {
    try {
      this.canvas ??= document.createElement("canvas");
      const c = this.canvas;
      c.width = 32;
      c.height = 24;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, 32, 24);
      const px = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      return sum / (px.length / 4);
    } catch {
      return null;
    }
  }
}
