// The student's own reading pace, measured by timing them on a short passage after the dot
// calibration (components/reader/ReadingCalibration.tsx). Read vs skimmed is judged against
// it, rather than against an assumed 240 wpm. Remembered on this browser for when that step
// is skipped.

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
