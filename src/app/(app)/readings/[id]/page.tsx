import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewReading, getCourse, getReading, sessionsFor } from "@/lib/db";
import { estimateMinutes, formatDate, formatDueDate, formatDuration, isHeading } from "@/lib/text";
import { bestOf } from "@/lib/insights";
import { PageHeader } from "@/components/AppShell";
import { BestTag, EmptyState, isOverdue, OverduePill, RowLink, Section, StatusPill } from "@/components/ui";
import { IconCamera, IconEye, IconSun, IconUsers } from "@/components/icons";

export default async function ReadingPage({ params }: PageProps<"/readings/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const reading = getReading(id);
  if (!reading || !canViewReading(user, reading)) notFound();
  const course = reading.courseId ? getCourse(reading.courseId) : null;
  const isProf = course?.professorId === user.id;
  const sessions = sessionsFor(user.id, reading.id);
  const best = bestOf(sessions);
  // Only students get the overdue flag (it's about their own progress).
  const overdue = !isProf && !!course && isOverdue(reading.dueDate, best);
  const preview = reading.paragraphs.find((p) => !isHeading(p)) ?? reading.paragraphs[0];

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow={course ? `${course.code} · ${course.name}` : "Personal reading"}
        title={reading.title}
        subtitle={
          <>
            {reading.wordCount.toLocaleString()} words · about {estimateMinutes(reading.wordCount)} min
            {reading.dueDate && (
              <span className={overdue ? "text-skip font-medium" : ""}>
                {" · "}
                {overdue ? "Was due" : "Due"} {formatDueDate(reading.dueDate)}
              </span>
            )}
            {overdue && (
              <span className="ml-2 align-middle">
                <OverduePill />
              </span>
            )}
          </>
        }
        actions={
          isProf && (
            <Link href={`/readings/${reading.id}/insights`} className="btn btn-ghost">
              <IconUsers size={16} /> Class insights
            </Link>
          )
        }
      />

      {reading.instructions && (
        <div className="mb-6 rounded-xl border border-border bg-accent-soft px-5 py-4 text-[15px]">
          <span className="font-semibold">From your professor: </span>
          {reading.instructions}
        </div>
      )}

      <div className="card p-6 sm:p-8 mb-10">
        <div className="grid md:grid-cols-[1fr_auto] gap-8 items-center">
          <div>
            <h2 className="text-lg font-semibold">Start a reading session</h2>
            <p className="text-muted mt-1 text-[15px]">
              Takes about 30 seconds to set up. Your camera is processed on this device only, and no video is ever uploaded.
            </p>
            <ul className="mt-5 grid sm:grid-cols-3 gap-3 text-sm">
              <Tip icon={<IconSun size={16} />} text="Sit facing a light, not with a window behind you" />
              <Tip icon={<IconCamera size={16} />} text="Keep your face centered, about an arm's length away" />
              <Tip icon={<IconEye size={16} />} text="Try to keep your head still-ish while you read" />
            </ul>
          </div>
          <Link href={`/read/${reading.id}`} className="btn btn-primary !px-6 !py-3 text-base">
            Start reading
          </Link>
        </div>
      </div>

      <Section title="Preview">
        <p className="font-serif text-[17px] leading-8 text-muted line-clamp-4">{preview}</p>
      </Section>

      <Section title="Your sessions">
        {sessions.length === 0 ? (
          <EmptyState>No sessions yet. Your first report will appear here.</EmptyState>
        ) : (
          <div className="card divide-y divide-border">
            {sessions.map((s) => (
              <RowLink key={s.id} href={`/reports/${s.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{formatDate(s.endedAt)}</div>
                  <div className="text-sm text-muted">
                    {formatDuration(s.report.durationSec)} · focus {Math.round(s.report.focusPct)}%
                    {s.report.avgWpm ? ` · ${s.report.avgWpm} wpm` : ""}
                  </div>
                </div>
                {sessions.length > 1 && s.id === best?.id && <BestTag />}
                <StatusPill session={s} />
              </RowLink>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Tip({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-muted">
      <span className="text-accent mt-0.5">{icon}</span>
      {text}
    </li>
  );
}
