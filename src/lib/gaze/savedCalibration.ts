// A student's eye-tracking calibration, saved to their account so they calibrate once rather
// than before every reading. Used by the server (to store and hand it back) and the reader.
//
// Once saved, it's reused for every reading until the student presses Recalibrate. Only the
// default engine (MediaPipe features → ridge GazeModel) can be saved: WebEyeTrack's
// calibration lives in a neural network inside a web worker.
import { GazeModel, type GazeModelState, type ValidationResult } from "./gazeModel";
import type { GazeEstimator } from "./webEyeTrackSource";

export interface SavedCalibration {
  version: 1;
  engine: "mediapipe";
  model: GazeModelState;
  validation: ValidationResult;
  /** Reading pace from the reading-pace passage (seconds per word), when it was measured. */
  secPerWord: number | null;
  /** Browser zoom (devicePixelRatio) at calibration; older saves lack it. See modelEstimator. */
  dpr?: number;
  /** Screen size (CSS px) the calibration was made on (kept for diagnosis; not checked). */
  screen: { w: number; h: number };
  savedAt: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Check untrusted data (a request body, a database row) is a usable saved calibration. */
export function parseSavedCalibration(v: unknown): SavedCalibration | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<SavedCalibration>;
  if (s.version !== 1 || s.engine !== "mediapipe" || !GazeModel.fromJSON(s.model)) return null;
  const val = s.validation;
  if (!val || !num(val.meanErrorPx) || !num(val.meanAbsDyPx) || !num(val.meanDyPx) || !["good", "fair", "poor"].includes(val.quality)) return null;
  if (val.jitterDyPx !== undefined && !num(val.jitterDyPx)) return null;
  if (s.secPerWord !== null && !(num(s.secPerWord) && s.secPerWord > 0)) return null;
  if (!s.screen || !num(s.screen.w) || !num(s.screen.h) || typeof s.savedAt !== "string") return null;
  if (s.dpr !== undefined && !(num(s.dpr) && s.dpr > 0)) return null;
  return {
    version: 1,
    engine: "mediapipe",
    model: s.model as GazeModelState,
    validation: { meanErrorPx: val.meanErrorPx, meanAbsDyPx: val.meanAbsDyPx, meanDyPx: val.meanDyPx, jitterDyPx: val.jitterDyPx, quality: val.quality },
    secPerWord: s.secPerWord ?? null,
    ...(s.dpr !== undefined ? { dpr: s.dpr } : {}),
    screen: { w: s.screen.w, h: s.screen.h },
    savedAt: s.savedAt,
  };
}

/** This browser's screen size (CSS px). Reading is full screen, so this is the reading area. */
export function currentScreen(): { w: number; h: number } {
  return { w: window.screen.width, h: window.screen.height };
}

/** The browser's current zoom, as device pixels per CSS pixel. */
export const currentDpr = () => (typeof window !== "undefined" && window.devicePixelRatio) || 1;

/**
 * The frame → screen estimator for a saved (or freshly fitted) model, calibrated at zoom
 * `dpr`. The model maps the eyes to CSS pixels as they were at calibration; browser zoom
 * changes how many CSS pixels the same physical spot is from the corner of the (full) screen,
 * so each estimate is rescaled by the zoom then ÷ the zoom now: physical position kept.
 */
export function modelEstimator(model: GazeModel, dpr: number): GazeEstimator {
  return {
    predict: (f) => {
      if (!f.features) return null;
      const g = model.predict(f.features);
      const k = dpr / currentDpr();
      return k === 1 ? g : { x: g.x * k, y: g.y * k };
    },
  };
}

/** A live calibration (as the reader uses it), rebuilt from a saved one. */
export function fromSaved(s: SavedCalibration) {
  const model = GazeModel.fromJSON(s.model)!; // parseSavedCalibration already checked it
  return {
    engine: "mediapipe" as const,
    // A save from before zoom was recorded: assume the zoom hasn't changed.
    estimator: modelEstimator(model, s.dpr ?? currentDpr()),
    dpr: s.dpr ?? currentDpr(),
    validation: s.validation,
    secPerWord: s.secPerWord ?? undefined,
    model,
  };
}

/** The saveable form of a calibration, or null when its engine can't be saved. */
export function toSaved(c: { engine: string; model?: GazeModel; validation: ValidationResult; secPerWord?: number; dpr?: number }, fallbackSecPerWord: number | null): SavedCalibration | null {
  if (c.engine !== "mediapipe" || !c.model) return null;
  return {
    version: 1,
    engine: "mediapipe",
    model: c.model.toJSON(),
    validation: c.validation,
    secPerWord: c.secPerWord ?? fallbackSecPerWord,
    dpr: c.dpr ?? currentDpr(),
    screen: currentScreen(),
    savedAt: new Date().toISOString(),
  };
}
