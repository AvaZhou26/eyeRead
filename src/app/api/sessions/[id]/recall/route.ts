import { getCurrentUser } from "@/lib/auth";
import { getSession, saveRecall } from "@/lib/db";
import { readJsonBody } from "@/lib/validate";

// Saves the student's "in your own words" recall for one missed section of their report.
export async function POST(req: Request, ctx: RouteContext<"/api/sessions/[id]/recall">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  const session = await getSession(id);
  if (!user || !session || session.userId !== user.id) return Response.json({ error: "Not allowed." }, { status: 403 });
  const body = await readJsonBody(req);
  const section = body?.section;
  const text = body?.text;
  const sections = session.ai?.sections.length ?? 0;
  if (typeof section !== "number" || !Number.isInteger(section) || section < 0 || section >= sections)
    return Response.json({ error: "Unknown section." }, { status: 400 });
  if (typeof text !== "string" || text.length > 2000) return Response.json({ error: "Keep it under 2000 characters." }, { status: 400 });
  const saved = await saveRecall(session.id, section, text);
  return Response.json({ recall: saved?.recall?.[String(section)] ?? null });
}
