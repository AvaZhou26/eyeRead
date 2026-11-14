import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  coursesForUser,
  getReading,
  personalReadings,
  readingsForCourse,
  sessionsFor,
  sessionsForReading,
  studentsInCourse,
} from "@/lib/db";
import { bestOf } from "@/lib/insights";
import { estimateMinutes, formatDate, formatDueDate, formatDuration } from "@/lib/text";
import type { User } from "@/lib/types";
import { PageHeader } from "@/components/AppShell";
import { CreateCourseForm, JoinCourseForm } from "@/components/CourseForms";
import { BestTag, EmptyState, OverduePill, RowLink, Section, StatusPill, isOverdue } from "@/components/ui";
import { IconBook, IconClock, IconPlus, IconUsers } from "@/components/icons";

export default async function Dashboard() {
  const user = await requireUser();
  return user.role === "professor" ? <ProfessorDashboard user={user} /> : <StudentDashboard user={user} />;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function StudentDashboard({ user }: { user: User }) {
  const courses = coursesForUser(user);
  const assignments = courses
    .flatMap((c) => readingsForCourse(c.id).map((r) => ({ reading: r, course: c })))
    .sort((a, b) => (a.reading.dueDate ?? "9").localeCompare(b.reading.dueDate ?? "9"));
  const mine = personalReadings(user.id);
  const allMine = sessionsFor(user.id);
  const recent = allMine.slice(0, 5);
  // id of the best session for each reading (only marked when there's more than one session)
  const bestIds = new Set<string>();
  for (const readingId of new Set(allMine.map((s) => s.readingId))) {
    const list = allMine.filter((s) => s.readingId === readingId);
    const b = bestOf(list);
    if (b && list.length > 1) bestIds.add(b.id);
  }

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user.name.split(" ")[0]}`}
        subtitle="Pick up a reading. Your report appears when you finish a session."
        actions={
          <>
            <JoinCourseForm />
            <Link href="/readings/new" className="btn btn-primary">
              <IconPlus size={16} /> Upload a reading
            </Link>
          </>
        }
      />

      <Section title="Assigned readings">
        {assignments.length === 0 ? (
          <EmptyState>No assigned readings yet. Join a course with the code your professor gave you.</EmptyState>
        ) : (
          <div className="card divide-y divide-border">
            {assignments.map(({ reading, course }) => {
              const mine = sessionsFor(user.id, reading.id);
              const best = bestOf(mine);
              return (
                <RowLink key={reading.id} href={`/readings/${reading.id}`}>
                  <div className="h-10 w-10 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0">
                    <IconBook size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{reading.title}</div>
                    <div className="text-sm text-muted">
                      {course.code} · {estimateMinutes(reading.wordCount)} min read
                      {reading.dueDate && (
                        <span className={isOverdue(reading.dueDate, best) ? "text-skip font-medium" : ""}>
                          {" · "}
                          {isOverdue(reading.dueDate, best) ? "Was due" : "Due"} {formatDueDate(reading.dueDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  {isOverdue(reading.dueDate, best) && <OverduePill />}
                  <StatusPill session={best} attempts={mine.length} />
                </RowLink>
              );
            })}
          </div>
        )}
      </Section>

      <div className="grid md:grid-cols-2 gap-8">
        <Section title="Your courses">
          {courses.length === 0 ? (
            <EmptyState>You&apos;re not in any courses yet.</EmptyState>
          ) : (
            <div className="grid gap-3">
              {courses.map((c) => (
                <Link key={c.id} href={`/courses/${c.id}`} className="card px-5 py-4 hover:border-accent transition">
                  <div className="text-xs font-semibold text-accent">{c.code}</div>
                  <div className="font-medium mt-0.5">{c.name}</div>
                  <div className="text-sm text-muted mt-1">
                    {c.term} · {readingsForCourse(c.id).length} readings
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Your own readings">
          {mine.length === 0 ? (
            <EmptyState>
              Paste text or upload a PDF to practice with your own material.{" "}
              <Link href="/readings/new" className="text-accent underline underline-offset-2">Upload one</Link>
            </EmptyState>
          ) : (
            <div className="card divide-y divide-border">
              {mine.map((r) => (
                <RowLink key={r.id} href={`/readings/${r.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{r.title}</div>
                    <div className="text-sm text-muted">{r.wordCount.toLocaleString()} words</div>
                  </div>
                  <StatusPill session={bestOf(sessionsFor(user.id, r.id))} attempts={sessionsFor(user.id, r.id).length} />
                </RowLink>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="Recent sessions">
        {recent.length === 0 ? (
          <EmptyState>Your session reports will show up here.</EmptyState>
        ) : (
          <div className="card divide-y divide-border">
            {recent.map((s) => (
              <RowLink key={s.id} href={`/reports/${s.id}`}>
                <IconClock size={18} className="text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{getReading(s.readingId)?.title ?? "Reading"}</div>
                  <div className="text-sm text-muted">
                    {formatDate(s.endedAt)} · {formatDuration(s.report.durationSec)} · focus {Math.round(s.report.focusPct)}%
                    {s.report.avgWpm ? ` · ${s.report.avgWpm} wpm` : ""}
                  </div>
                </div>
                {bestIds.has(s.id) && <BestTag />}
                <StatusPill session={s} />
              </RowLink>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function ProfessorDashboard({ user }: { user: User }) {
  const courses = coursesForUser(user);
  const activity = courses
    .flatMap((c) => readingsForCourse(c.id))
    .flatMap((r) => sessionsForReading(r.id).map((s) => ({ s, r })))
    .sort((a, b) => b.s.endedAt.localeCompare(a.s.endedAt))
    .slice(0, 6);

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user.name}`}
        subtitle="See how your students are engaging with the readings you assign."
        actions={<CreateCourseForm />}
      />
      <Section title="Your courses">
        {courses.length === 0 ? (
          <EmptyState>Create your first course to start assigning readings.</EmptyState>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {courses.map((c) => (
              <Link key={c.id} href={`/courses/${c.id}`} className="card p-5 hover:border-accent transition flex flex-col">
                <div className="text-xs font-semibold text-accent">{c.code}</div>
                <div className="font-medium mt-0.5 text-[17px]">{c.name}</div>
                <div className="text-sm text-muted mt-1">{c.term}</div>
                <div className="mt-5 pt-4 border-t border-border flex items-center gap-4 text-sm text-muted">
                  <span className="inline-flex items-center gap-1.5"><IconUsers size={15} /> {studentsInCourse(c.id).length}</span>
                  <span className="inline-flex items-center gap-1.5"><IconBook size={15} /> {readingsForCourse(c.id).length}</span>
                  <span className="ml-auto text-xs">
                    Join code <span className="font-mono tracking-widest text-fg">{c.joinCode}</span>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Latest student sessions">
        {activity.length === 0 ? (
          <EmptyState>When students finish a reading session, it will show up here.</EmptyState>
        ) : (
          <div className="card divide-y divide-border">
            {activity.map(({ s, r }) => (
              <RowLink key={s.id} href={`/readings/${r.id}/insights`}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{r.title}</div>
                  <div className="text-sm text-muted">
                    {formatDate(s.endedAt)} · {formatDuration(s.report.durationSec)} · focus {Math.round(s.report.focusPct)}%
                  </div>
                </div>
                <StatusPill session={s} />
              </RowLink>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
