import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewReading, getReading, pausedSession } from "@/lib/db";
import { ReaderApp } from "@/components/reader/ReaderApp";

export default async function ReadPage({ params, searchParams }: PageProps<"/read/[id]">) {
  const { id } = await params;
  const { fresh } = await searchParams;
  const user = await requireUser();
  const reading = await getReading(id);
  if (!reading || !(await canViewReading(user, reading))) notFound();
  // Continue a paused session unless the student chose "Start over".
  const paused = fresh ? null : await pausedSession(user.id, reading.id);
  return (
    <ReaderApp
      readingId={reading.id}
      title={reading.title}
      paragraphs={reading.paragraphs}
      backHref={`/readings/${reading.id}`}
      resume={paused?.resume ? { sessionId: paused.id, state: paused.resume } : null}
    />
  );
}
