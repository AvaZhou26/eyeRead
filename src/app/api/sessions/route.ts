import { getCurrentUser } from "@/lib/auth";
import { canViewReading, createSession, getReading } from "@/lib/db";
import { generateSessionAi } from "@/lib/gemini";
import type { SessionReport } from "@/lib/types";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json()) as { readingId: string; startedAt: string; endedAt: string; report: SessionReport };
  const reading = getReading(body.readingId);
  if (!reading || !canViewReading(user, reading)) return Response.json({ error: "Reading not found." }, { status: 404 });
  if (!body.report || !Array.isArray(body.report.paragraphs))
    return Response.json({ error: "Missing session report." }, { status: 400 });

  const ai = await generateSessionAi(reading, body.report);
  const session = createSession({
    readingId: reading.id,
    userId: user.id,
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    report: body.report,
    ai,
  });
  return Response.json({ id: session.id });
}
