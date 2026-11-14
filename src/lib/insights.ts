// Combines many students' sessions into class-level numbers for the professor view.
import type { Reading, Session, User } from "./types";
import type { ClassParagraphAggregate } from "./gemini";

/**
 * A student's progress on a reading is their BEST session (highest coverage; ties go to the
 * most recent). A short re-read later shouldn't make progress look like it went backwards.
 */
export function bestOf(sessions: Session[]): Session | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (
      !best ||
      s.report.coveragePct > best.report.coveragePct ||
      (s.report.coveragePct === best.report.coveragePct && s.endedAt > best.endedAt)
    )
      best = s;
  }
  return best;
}

/** Each student's best session for a reading (see bestOf). */
export function bestPerStudent(sessions: Session[]): Map<string, Session> {
  const byUser = new Map<string, Session[]>();
  for (const s of sessions) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  const map = new Map<string, Session>();
  byUser.forEach((list, user) => {
    const b = bestOf(list);
    if (b) map.set(user, b);
  });
  return map;
}

/** Number of sessions each student has done for a reading. */
export function attemptsPerStudent(sessions: Session[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of sessions) map.set(s.userId, (map.get(s.userId) ?? 0) + 1);
  return map;
}

export function aggregateParagraphs(reading: Reading, sessions: Session[]): ClassParagraphAggregate[] {
  const n = sessions.length || 1;
  return reading.paragraphs.map((text, index) => {
    let skipped = 0, skimmed = 0, rereads = 0, ratio = 0;
    for (const s of sessions) {
      const p = s.report.paragraphs[index];
      if (!p) continue;
      if (p.status === "skipped") skipped++;
      if (p.status === "skimmed") skimmed++;
      rereads += p.rereads;
      ratio += p.expectedSec > 0 ? p.dwellSec / p.expectedSec : 0;
    }
    return {
      index,
      text,
      skippedPct: (skipped / n) * 100,
      skimmedPct: (skimmed / n) * 100,
      avgRereads: rereads / n,
      avgDwellRatio: ratio / n,
    };
  });
}

export interface StudentRow {
  user: User;
  session: Session | null;
  attempts: number;
}
