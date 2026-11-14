import { checkPassword, startSession } from "@/lib/auth";
import { getUserByEmail } from "@/lib/db";

export async function POST(req: Request) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email?.trim()) return Response.json({ error: "Enter your email." }, { status: 400 });
  const user = await getUserByEmail(email);
  // Demo accounts have no password and sign in from the demo buttons.
  const ok = !!user && (user.passwordHash ? !!password && (await checkPassword(password, user.passwordHash)) : user.demo === true);
  if (!user || !ok) return Response.json({ error: "Wrong email or password." }, { status: 401 });
  await startSession(user.id);
  return Response.json({ ok: true });
}
