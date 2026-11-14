"use client";
// Calibrate by reading: after the dots, the student reads a short passage laid out exactly
// like the reader. We learn (1) a vertical gaze correction and the real reading jitter, and
// (2) their reading pace, so read vs skimmed is judged against how fast *they* read.
// The maths lives in lib/gaze/readingCalibration.ts.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FaceTracker } from "@/lib/gaze/faceTracker";
import {
  fitReadingCalibration,
  paceFrom,
  savePace,
  withReadingCorrection,
  type CalibLine,
  type ReadingFit,
  type ReadingSample,
} from "@/lib/gaze/readingCalibration";
import type { CalibrationResult } from "./Calibration";
import { FONT_VAR, readerGeometry, type ReaderPrefs } from "./ReaderView";

/**
 * ~200 everyday words: more than fills one reader page at the usual sizes. The passage must
 * cover the WHOLE page height: gaze tends to get squashed toward the bottom of the screen
 * (eyelids cover more of the iris when you look down), and a correction learned only on the
 * top lines can't fix the bottom ones. Words past the page bottom are hidden and not counted.
 */
const PASSAGE =
  "Honeybees find their way home by using the sun as a compass. Before a bee leaves the hive, it notes the angle " +
  "between the sun and the path it plans to fly. On the way back, it simply reverses that angle. Thin clouds do not " +
  "confuse it much, because bees can sense patterns in the light that passes through them. The harder problem is " +
  "time. The sun moves across the sky, so an angle that worked in the morning would lead a bee astray by afternoon. " +
  "Bees solve this with an internal clock that shifts the angle as the hours pass, even when every landmark around " +
  "them is new. Scientists noticed this by moving a hive a long way overnight. The next morning, the bees left at the " +
  "angle that would have been right at home, and flew off in the wrong direction. Within a few days, though, they had " +
  "learned the new area and adjusted. Bees also share what they find. A forager that discovers flowers returns and " +
  "performs a short dance on the comb. The direction of the dance tells the others which way to fly, measured against " +
  "the sun, and its length tells them roughly how far to go.";
const WORDS = PASSAGE.split(/\s+/);

export interface ReadingCalibrationOutcome {
  fit: ReadingFit | null;
  pace: { wpm: number; secPerWord: number } | null;
}

/** Fold the reading step's results into the dot calibration's result. */
export function applyReadingCalibration(cal: CalibrationResult, o: ReadingCalibrationOutcome): CalibrationResult {
  const out: CalibrationResult = { ...cal };
  if (o.fit?.ok) {
    out.estimator = withReadingCorrection(cal.estimator, o.fit);
    // Scatter during real reading is what the line model faces; keep the larger estimate.
    out.validation = { ...cal.validation, jitterDyPx: Math.max(cal.validation.jitterDyPx ?? 0, o.fit.jitterPx) };
    out.readingFit = o.fit;
  }
  if (o.pace) out.secPerWord = o.pace.secPerWord;
  return out;
}

type Phase = "intro" | "reading" | "result";

export function ReadingCalibration({
  tracker,
  calibration,
  prefs,
  onDone,
  onSkip,
}: {
  tracker: FaceTracker;
  /** The dot calibration we're refining (its estimator gives the raw gaze). */
  calibration: CalibrationResult;
  prefs: ReaderPrefs;
  onDone: (o: ReadingCalibrationOutcome) => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [outcome, setOutcome] = useState<(ReadingCalibrationOutcome & { tooFast: boolean; seconds: number }) | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const lines = useRef<CalibLine[]>([]);
  const samples = useRef<ReadingSample[]>([]);
  /** Words actually shown (the passage is cut at the bottom of the page). */
  const shownWords = useRef(WORDS.length);
  const startedAt = useRef(0);

  useEffect(() => {
    const upd = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  const g = readerGeometry(vp.w, vp.h, prefs);

  // Once the passage is on screen: find its lines, then start the clock and the recording.
  useLayoutEffect(() => {
    if (phase !== "reading" || !textRef.current) return;
    const rows: { center: number; words: number; left: number; right: number }[] = [];
    const pageBottom = g.pageTop + g.pageH;
    let shown = 0;
    for (const el of Array.from(textRef.current.querySelectorAll<HTMLElement>("[data-w]"))) {
      const r = el.getBoundingClientRect();
      // Same page height as the reader: hide whatever doesn't fit.
      const fits = r.bottom <= pageBottom;
      el.style.visibility = fits ? "" : "hidden";
      if (!fits) continue;
      shown++;
      const c = (r.top + r.bottom) / 2;
      const row = rows.find((x) => Math.abs(x.center - c) < g.lineH / 2);
      if (row) {
        row.words++;
        row.left = Math.min(row.left, r.left);
        row.right = Math.max(row.right, r.right);
      } else rows.push({ center: c, words: 1, left: r.left, right: r.right });
    }
    lines.current = rows.sort((a, b) => a.center - b.center);
    shownWords.current = shown;
    samples.current = [];
    startedAt.current = performance.now() / 1000;
  }, [phase, g.lineH, g.pageTop, g.pageH]);

  useEffect(() => {
    if (phase !== "reading") return;
    return tracker.subscribe((f) => {
      if (!f.features) return;
      const p = calibration.estimator.predict(f);
      if (p) samples.current.push({ t: f.t, x: p.x, y: p.y });
    });
  }, [phase, tracker, calibration]);

  function finish() {
    const end = performance.now() / 1000;
    const seconds = end - startedAt.current;
    const pace = paceFrom(shownWords.current, seconds);
    const tooFast = !pace && shownWords.current / (seconds / 60) > 700;
    // Leave out the eyes travelling to the first line (from the button you just clicked) and
    // any look down at the Done button at the end: neither is reading the first/last line,
    // and they would pull that line's level, and so the whole correction, off.
    const reading = samples.current.filter((s) => s.t >= startedAt.current + 0.6 && s.t <= end - 0.4);
    const fit = fitReadingCalibration(reading, lines.current, g.lineH);
    setOutcome({ fit, pace, tooFast, seconds });
    setPhase("result");
  }

  useEffect(() => {
    if (phase !== "reading") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function accept() {
    if (!outcome) return;
    if (outcome.pace) savePace(outcome.pace.wpm);
    onDone({ fit: outcome.fit, pace: outcome.pace });
  }

  return (
    <div className="fixed inset-0 z-50 reader-surface select-none">
      {phase === "intro" && (
        <CenterCard>
          <h2 className="text-xl font-semibold">One more step: read a short passage</h2>
          <p className="text-muted mt-2 leading-relaxed">
            <b className="text-fg">Read it once, at your normal pace</b>, the way you&apos;d read for class. Then press{" "}
            <b className="text-fg">Space</b> (or click Done).
          </p>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            This teaches Read Assist how your eyes move down real lines of text, and how fast <i>you</i> read, so
            skimming is judged against your own pace. About 45 seconds: the passage fills a whole page, so the
            tracker learns the bottom lines too.
          </p>
          <div className="mt-6 flex gap-2 justify-end">
            <button className="btn btn-ghost" onClick={onSkip}>
              Skip
            </button>
            <button className="btn btn-primary" onClick={() => setPhase("reading")}>
              Show the passage
            </button>
          </div>
        </CenterCard>
      )}

      {phase === "reading" && vp.w > 0 && (
        <>
          <div
            ref={textRef}
            className="absolute"
            style={{
              left: g.pageLeft,
              top: g.pageTop,
              width: g.pageW,
              fontSize: g.fontPx,
              lineHeight: g.lineHeightRatio,
              fontFamily: FONT_VAR[prefs.font],
            }}
          >
            {WORDS.map((w, i) => (
              <span key={i} data-w="">
                {w}{" "}
              </span>
            ))}
          </div>
          <div className="fixed left-0 right-0 bottom-6 flex justify-center">
            <button className="btn btn-primary" onClick={finish}>
              Done (Space)
            </button>
          </div>
        </>
      )}

      {phase === "result" && outcome && (
        <CenterCard>
          {outcome.tooFast ? (
            <>
              <h2 className="text-xl font-semibold">That was quicker than reading</h2>
              <p className="text-muted mt-2 leading-relaxed">
                {Math.round(outcome.seconds)} seconds is skimming pace for this passage. To learn your pace, please read it
                through normally.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold">Got it</h2>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed">
                <li>
                  {outcome.pace ? (
                    <>
                      Your reading pace: <b>{outcome.pace.wpm} words per minute</b>. Reading and skimming will be judged against
                      it.
                    </>
                  ) : (
                    <span className="text-muted">We couldn&apos;t measure a normal reading pace from that, so we&apos;ll use a typical one.</span>
                  )}
                </li>
                <li>
                  {outcome.fit?.ok ? (
                    <>
                      Your eyes followed the lines: the tracker is adjusted to how you read, with a jitter of about{" "}
                      <b>{(outcome.fit.jitterPx / g.lineH).toFixed(1)} lines</b>.
                    </>
                  ) : (
                    <span className="text-muted">
                      We couldn&apos;t follow your eyes line by line{outcome.fit?.reason ? ` (${outcome.fit.reason})` : ""}, so
                      we&apos;ll keep the dot calibration as it is.
                    </span>
                  )}
                </li>
              </ul>
            </>
          )}
          <div className="mt-6 flex flex-wrap gap-2 justify-end">
            <button className="btn btn-ghost" onClick={() => setPhase("reading")}>
              Read it again
            </button>
            {!outcome.tooFast && (
              <button className="btn btn-primary" onClick={accept}>
                Start reading
              </button>
            )}
            {outcome.tooFast && (
              <button className="btn btn-ghost" onClick={onSkip}>
                Skip
              </button>
            )}
          </div>
        </CenterCard>
      )}
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="card max-w-lg w-full p-7 fade-in">{children}</div>
    </div>
  );
}
