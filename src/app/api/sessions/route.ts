import { getCurrentUser } from "@/lib/auth";
import { canViewReading, closePausedSessions, createSession, getReading, getSession, updateSession } from "@/lib/db";
import { generateSessionAi } from "@/lib/gemini";
import type { ResumeState, SessionReport } from "@/lib/types";

// Saves a reading session. status "paused" keeps the progress (and the state needed to resume);
// status "done" finishes it and builds the AI summary. Resuming a paused session updates the
// same row, so a long reading done in several sittings ends up as ONE report.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json()) as {
    readingId: string;
    sessionId?: string | null;
    startedAt: string;
    endedAt: string;
    status?: "paused" | "done";
    report: SessionReport;
    resume?: ResumeState | null;
  };
  const reading = await getReading(body.readingId);
  if (!reading || !(await canViewReading(user, reading))) return Response.json({ error: "Reading not found." }, { status: 404 });
  if (!body.report || !Array.isArray(body.report.paragraphs))
    return Response.json({ error: "Missing session report." }, { status: 400 });
  const status = body.status === "paused" ? "paused" : "done";
  if (status === "paused" && !body.resume) return Response.json({ error: "Missing progress to save." }, { status: 400 });

  const ai = status === "done" ? await generateSessionAi(reading, body.report) : null;
  const resume = status === "paused" ? body.resume! : null;

  if (body.sessionId) {
    const existing = await getSession(body.sessionId);
    if (existing && existing.userId === user.id && existing.readingId === reading.id && existing.status === "paused") {
      await updateSession(existing.id, { endedAt: body.endedAt, status, sittings: existing.sittings + 1, report: body.report, ai, resume });
      return Response.json({ id: existing.id });
    }
  }
  await closePausedSessions(user.id, reading.id);
  const session = await createSession({
    readingId: reading.id,
    userId: user.id,
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    status,
    sittings: 1,
    report: body.report,
    ai,
    resume,
  });
  return Response.json({ id: session.id });
}
