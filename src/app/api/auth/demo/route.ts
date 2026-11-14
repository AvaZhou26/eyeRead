import { startSession } from "@/lib/auth";
import { getUser } from "@/lib/db";

// One-click sign-in for the seeded demo accounts (and accounts carried over from the old demo).
export async function POST(req: Request) {
  const { userId } = (await req.json()) as { userId?: string };
  const user = userId ? await getUser(userId) : null;
  if (!user?.demo) return Response.json({ error: "That isn't a demo account." }, { status: 403 });
  await startSession(user.id);
  return Response.json({ ok: true });
}
