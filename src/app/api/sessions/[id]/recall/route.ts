import { getCurrentUser } from "@/lib/auth";
import { getSession, saveRecall } from "@/lib/db";

// Saves the student's "in your own words" recall for one missed section of their report.
export async function POST(req: Request, ctx: RouteContext<"/api/sessions/[id]/recall">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  const session = getSession(id);
  if (!user || !session || session.userId !== user.id) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { section, text } = (await req.json()) as { section?: number; text?: string };
  const sections = session.ai?.sections.length ?? 0;
  if (typeof section !== "number" || section < 0 || section >= sections)
    return Response.json({ error: "Unknown section." }, { status: 400 });
  if (typeof text !== "string" || text.length > 2000) return Response.json({ error: "Keep it under 2000 characters." }, { status: 400 });
  const saved = saveRecall(session.id, section, text);
  return Response.json({ recall: saved?.recall?.[String(section)] ?? null });
}
