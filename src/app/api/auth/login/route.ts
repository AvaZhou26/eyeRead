import { checkPassword, startSession } from "@/lib/auth";
import { getUserByEmail } from "@/lib/db";
import { readJsonBody, strField } from "@/lib/validate";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return Response.json({ error: "That request wasn't understood. Reload the page and try again." }, { status: 400 });
  const email = strField(body, "email");
  const password = strField(body, "password");
  if (!email?.trim()) return Response.json({ error: "Enter your email." }, { status: 400 });
  const user = await getUserByEmail(email);
  // Demo accounts have no password and sign in from the demo buttons.
  const ok = !!user && (user.passwordHash ? !!password && (await checkPassword(password, user.passwordHash)) : user.demo === true);
  if (!user || !ok) return Response.json({ error: "Wrong email or password." }, { status: 401 });
  await startSession(user.id);
  return Response.json({ ok: true });
}
