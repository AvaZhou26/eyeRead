import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCourse, getDigest, getReading, sessionsForReading, studentsInCourse } from "@/lib/db";
import { aggregateParagraphs, attemptsPerStudent, bestPerStudent } from "@/lib/insights";
import { formatDate, formatDuration, isHeading } from "@/lib/text";
import { PageHeader } from "@/components/AppShell";
import { EmptyState, Section, Stat, StatusPill } from "@/components/ui";
import { DigestCard } from "@/components/report/DigestCard";

export default async function InsightsPage({ params }: PageProps<"/readings/[id]/insights">) {
  const { id } = await params;
  const user = await requireUser();
  const reading = getReading(id);
  const course = reading?.courseId ? getCourse(reading.courseId) : null;
  if (!reading || !course || course.professorId !== user.id) notFound();

  const students = studentsInCourse(course.id);
  // One session per student: their BEST attempt (highest coverage), so a short re-read
  // doesn't drag the class numbers down. All stats below are labelled accordingly.
  const allSessions = sessionsForReading(reading.id);
  const best = bestPerStudent(allSessions);
  const attempts = attemptsPerStudent(allSessions);
  const sessions = [...best.values()];
  const digest = getDigest(reading.id);
  const agg = aggregateParagraphs(reading, sessions);
  const avg = (f: (s: (typeof sessions)[number]) => number | null) => {
    const vals = sessions.map(f).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgCoverage = avg((s) => s.report.coveragePct);
  const avgFocus = avg((s) => s.report.focusPct);
  const avgWpm = avg((s) => s.report.avgWpm);
  const maxRereads = Math.max(0.0001, ...agg.map((a) => a.avgRereads));

  return (
    <div className="max-w-5xl">
      <PageHeader
        eyebrow={
          <Link href={`/courses/${course.id}`} className="hover:text-fg">
            {course.code} · {course.name}
          </Link>
        }
        title={reading.title}
        subtitle={`Class insights · ${best.size} of ${students.length} students have read it · averages use each student's best session`}
        actions={
          <Link href={`/readings/${reading.id}`} className="btn btn-ghost">
            Try it yourself
          </Link>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="Completed" value={`${best.size}/${students.length}`} hint={`students · ${allSessions.length} session${allSessions.length === 1 ? "" : "s"} total`} />
        <Stat label="Avg coverage" value={avgCoverage === null ? "–" : `${Math.round(avgCoverage)}%`} hint="best session per student" />
        <Stat label="Avg focus" value={avgFocus === null ? "–" : `${Math.round(avgFocus)}%`} hint="best session per student" />
        <Stat label="Avg speed" value={avgWpm === null ? "–" : `${Math.round(avgWpm)}`} hint={avgWpm === null ? "best session per student" : "wpm · best session per student"} />
      </div>

      <div className="mb-10">
        <DigestCard
          readingId={reading.id}
          initial={digest}
          hasSessions={sessions.length > 0}
          newSessions={digest ? allSessions.filter((s) => s.endedAt > digest.createdAt).length : 0}
        />
      </div>

      <Section
        title="Students"
        action={
          students.length > 0 && (
            <a href={`/api/readings/${reading.id}/export`} download className="btn btn-ghost !py-1.5 text-sm">
              Download CSV
            </a>
          )
        }
      >
        {students.length === 0 ? (
          <EmptyState>No students enrolled yet. Share the join code {course.joinCode}.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-border">
                  <th className="font-medium px-5 py-3">Student</th>
                  <th className="font-medium px-3 py-3">Status</th>
                  <th className="font-medium px-3 py-3">Focus</th>
                  <th className="font-medium px-3 py-3">Speed</th>
                  <th className="font-medium px-3 py-3">Time</th>
                  <th className="font-medium px-3 py-3">Distractions</th>
                  <th className="font-medium px-3 py-3">Sessions</th>
                  <th className="font-medium px-5 py-3 text-right">Best session</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {students.map((st) => {
                  const s = best.get(st.id) ?? null;
                  return (
                    <tr key={st.id} className="hover:bg-surface-2/60">
                      <td className="px-5 py-3 font-medium">{st.name}</td>
                      <td className="px-3 py-3"><StatusPill session={s} /></td>
                      <td className="px-3 py-3 tabular-nums">{s ? `${Math.round(s.report.focusPct)}%` : "–"}</td>
                      <td className="px-3 py-3 tabular-nums">{s?.report.avgWpm ? `${s.report.avgWpm} wpm` : "–"}</td>
                      <td className="px-3 py-3 tabular-nums">{s ? formatDuration(s.report.durationSec) : "–"}</td>
                      <td className="px-3 py-3 tabular-nums">{s ? s.report.distractions.length : "–"}</td>
                      <td className="px-3 py-3 tabular-nums">{attempts.get(st.id) ?? 0}</td>
                      <td className="px-5 py-3 text-right">
                        {s ? (
                          <Link href={`/reports/${s.id}`} className="text-accent hover:underline">
                            {formatDate(s.endedAt)} →
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Class reading map"
        action={
          <div className="flex gap-4 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded" style={{ background: "var(--skip-soft)" }} />Skipped by many</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-3.5 w-[3px] rounded-full" style={{ background: "var(--reread)" }} />Re-read</span>
          </div>
        }
      >
        {sessions.length === 0 ? (
          <EmptyState>The class map appears after the first student finishes.</EmptyState>
        ) : (
          <div className="card p-6 sm:p-8 space-y-4">
            {agg.map((a) => {
              const heading = isHeading(a.text);
              const skipShade = Math.min(1, (a.skippedPct + a.skimmedPct * 0.5) / 100);
              const rereadW = a.avgRereads / maxRereads;
              return (
                <div key={a.index} className="grid grid-cols-[1fr_150px] gap-6 items-start">
                  <div className="relative pl-4">
                    <div
                      className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                      style={{ background: "var(--reread)", opacity: a.avgRereads > 0 ? 0.25 + 0.75 * rereadW : 0 }}
                    />
                    <p
                      className={`font-serif leading-[1.85] rounded-md px-2 -mx-2 ${heading ? "font-semibold" : "text-[15.5px]"}`}
                      style={{ background: `color-mix(in srgb, var(--skip) ${Math.round(skipShade * 22)}%, transparent)` }}
                    >
                      {a.text}
                    </p>
                  </div>
                  {!heading && (
                    <div className="text-xs text-muted space-y-1 pt-1 tabular-nums">
                      <div>¶{a.index + 1}</div>
                      <div>{Math.round(a.skippedPct)}% skipped</div>
                      <div>{Math.round(a.skimmedPct)}% skimmed</div>
                      <div style={{ color: a.avgRereads >= 1 ? "var(--reread)" : undefined }}>{a.avgRereads.toFixed(1)} re-reads/student</div>
                      <div>{a.avgDwellRatio.toFixed(1)}× expected time</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
