import { hashPassword, startSession } from "@/lib/auth";
import { createUser, getUserByEmail } from "@/lib/db";
import { readJsonBody, strField } from "@/lib/validate";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (!body) return Response.json({ error: "That request wasn't understood. Reload the page and try again." }, { status: 400 });
  const [name, email, password, role] = ["name", "email", "password", "role"].map((k) => strField(body, k));
  if (!name?.trim()) return Response.json({ error: "Enter your name." }, { status: 400 });
  if (!email || !/^\S+@\S+\.\S+$/.test(email.trim())) return Response.json({ error: "Enter a valid email." }, { status: 400 });
  if (!password || password.length < 8) return Response.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  if (role !== "student" && role !== "professor") return Response.json({ error: "Pick student or teacher." }, { status: 400 });
  if (await getUserByEmail(email)) return Response.json({ error: "An account with that email already exists. Sign in instead." }, { status: 409 });
  const user = await createUser(name, email, role, await hashPassword(password));
  await startSession(user.id);
  return Response.json({ ok: true });
}
