import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewCourse, getCourse, readingsForCourse, sessionsFor, sessionsForReading, studentsInCourse } from "@/lib/db";
import { bestOf, bestPerStudent } from "@/lib/insights";
import { estimateMinutes, formatDueDate } from "@/lib/text";
import { PageHeader } from "@/components/AppShell";
import { EmptyState, OverduePill, RowLink, Section, StatusPill, isOverdue } from "@/components/ui";
import { JoinCodeCard } from "@/components/CourseForms";
import { IconBook, IconPlus } from "@/components/icons";

export default async function CoursePage({ params }: PageProps<"/courses/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const course = getCourse(id);
  if (!course || !canViewCourse(user, course)) notFound();
  const isProf = course.professorId === user.id;
  const readings = readingsForCourse(course.id);
  const students = studentsInCourse(course.id);

  return (
    <>
      <PageHeader
        eyebrow={`${course.code} · ${course.term}`}
        title={course.name}
        subtitle={isProf ? `Course code ${course.code}` : undefined}
        actions={
          isProf && (
            <Link href={`/readings/new?courseId=${course.id}`} className="btn btn-primary">
              <IconPlus size={16} /> Post a reading
            </Link>
          )
        }
      />

      {isProf && <JoinCodeCard code={course.joinCode} />}

      <div className={isProf ? "grid lg:grid-cols-[1fr_280px] gap-8" : ""}>
        <Section title="Readings">
          {readings.length === 0 ? (
            <EmptyState>No readings posted yet.</EmptyState>
          ) : (
            <div className="card divide-y divide-border">
              {readings.map((r) => {
                const completed = isProf ? bestPerStudent(sessionsForReading(r.id)).size : 0;
                const myBest = isProf ? null : bestOf(sessionsFor(user.id, r.id));
                const overdue = !isProf && isOverdue(r.dueDate, myBest);
                return (
                  <RowLink key={r.id} href={isProf ? `/readings/${r.id}/insights` : `/readings/${r.id}`}>
                    <div className="h-10 w-10 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0">
                      <IconBook size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{r.title}</div>
                      <div className="text-sm text-muted">
                        {r.wordCount.toLocaleString()} words · ~{estimateMinutes(r.wordCount)} min
                        {r.dueDate && (
                          <span className={overdue ? "text-skip font-medium" : ""}>
                            {" · "}
                            {overdue ? "Was due" : "Due"} {formatDueDate(r.dueDate)}
                          </span>
                        )}
                      </div>
                    </div>
                    {isProf ? (
                      <span className="pill">
                        {completed}/{students.length} read
                      </span>
                    ) : (
                      <>
                        {overdue && <OverduePill />}
                        <StatusPill session={myBest} attempts={sessionsFor(user.id, r.id).length} />
                      </>
                    )}
                  </RowLink>
                );
              })}
            </div>
          )}
        </Section>

        {isProf && (
          <Section title={`Students (${students.length})`}>
            {students.length === 0 ? (
              <EmptyState>Share the join code with your class.</EmptyState>
            ) : (
              <div className="card divide-y divide-border">
                {students.map((s) => (
                  <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-surface-2 flex items-center justify-center text-xs font-semibold text-muted">
                      {s.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted truncate">{s.email}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
      </div>
    </>
  );
}
