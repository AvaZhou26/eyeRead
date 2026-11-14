import Link from "next/link";
import type { ReactNode } from "react";
import type { Session } from "@/lib/types";
import { isPastDue } from "@/lib/text";

/** Coverage at which a reading counts as finished (same threshold as the green pill). */
export const FINISHED_PCT = 85;

/** Past due and not finished yet. */
export function isOverdue(dueDate: string | null, best: Session | null | undefined): boolean {
  return isPastDue(dueDate) && (!best || best.report.coveragePct < FINISHED_PCT);
}

/** Marks the session that counts as the student's progress (see bestOf). */
export function BestTag() {
  return (
    <span className="pill" style={{ color: "var(--accent)", background: "var(--accent-soft)" }} title="Your best session: this is what your progress shows">
      Best
    </span>
  );
}

export function OverduePill() {
  return (
    <span className="pill" style={{ color: "var(--skip)", background: "var(--skip-soft)" }}>
      Overdue
    </span>
  );
}

/** Progress pill. Pass the student's BEST session for a reading (see bestOf). */
/** "Read N%" pill, colored like StatusPill (for readings without a Session, e.g. web articles). */
export function CoveragePill({ pct }: { pct: number }) {
  const v = Math.round(pct);
  const color = v >= FINISHED_PCT ? "var(--read)" : v >= 50 ? "var(--skim)" : "var(--skip)";
  return (
    <span className="pill" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      Read {v}%
    </span>
  );
}

export function StatusPill({ session, attempts }: { session: Session | null | undefined; attempts?: number }) {
  if (!session) return <span className="pill">Not started</span>;
  const pct = Math.round(session.report.coveragePct);
  if (session.status === "paused")
    return (
      <span className="pill" style={{ color: "var(--accent)", background: "var(--accent-soft)" }} title="Paused partway; progress so far is saved">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        Paused · {pct}%
      </span>
    );
  const color = pct >= FINISHED_PCT ? "var(--read)" : pct >= 50 ? "var(--skim)" : "var(--skip)";
  return (
    <span
      className="pill"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      title={attempts && attempts > 1 ? `Best of ${attempts} sessions` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      Read {pct}%
    </span>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted">{children}</div>;
}

export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-2 transition first:rounded-t-[14px] last:rounded-b-[14px]">
      {children}
    </Link>
  );
}

export function Stat({ label, value, hint, color }: { label: string; value: ReactNode; hint?: ReactNode; color?: string }) {
  return (
    <div className="card px-5 py-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/** One reading-habit insight (see readingHabits). */
export function HabitCard({ title, detail, tone }: { title: string; detail: string; tone: "good" | "watch" | "neutral" }) {
  const color = tone === "good" ? "var(--read)" : tone === "watch" ? "var(--skim)" : "var(--accent)";
  return (
    <div className="card p-5 flex gap-3">
      <span className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <div>
        <div className="font-medium">{title}</div>
        <p className="text-sm text-muted mt-1 leading-relaxed">{detail}</p>
      </div>
    </div>
  );
}
