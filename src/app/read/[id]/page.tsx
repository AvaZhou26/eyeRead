import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewReading, getReading } from "@/lib/db";
import { ReaderApp } from "@/components/reader/ReaderApp";

export default async function ReadPage({ params }: PageProps<"/read/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const reading = getReading(id);
  if (!reading || !canViewReading(user, reading)) notFound();
  return <ReaderApp readingId={reading.id} title={reading.title} paragraphs={reading.paragraphs} backHref={`/readings/${reading.id}`} />;
}
