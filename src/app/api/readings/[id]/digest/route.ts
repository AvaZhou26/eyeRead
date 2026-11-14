import { getCurrentUser } from "@/lib/auth";
import { getCourse, getReading, saveDigest, sessionsForReading } from "@/lib/db";
import { generateClassDigest } from "@/lib/gemini";
import { aggregateParagraphs, bestPerStudent } from "@/lib/insights";

export async function POST(_req: Request, ctx: RouteContext<"/api/readings/[id]/digest">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  const reading = getReading(id);
  const course = reading?.courseId ? getCourse(reading.courseId) : null;
  if (!user || !reading || !course || course.professorId !== user.id)
    return Response.json({ error: "Not allowed." }, { status: 403 });

  const latest = [...bestPerStudent(sessionsForReading(reading.id)).values()];
  if (latest.length === 0) return Response.json({ error: "No student sessions yet." }, { status: 400 });

  const result = await generateClassDigest(reading, latest.length, aggregateParagraphs(reading, latest));
  const digest = { readingId: reading.id, text: result.text, generatedBy: result.generatedBy, createdAt: new Date().toISOString() };
  saveDigest(digest);
  return Response.json({ digest });
}
