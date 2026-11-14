import { cookies } from "next/headers";
import { findOrCreateUser } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const { name, email, role } = (await req.json()) as { name?: string; email?: string; role?: string };
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Enter a valid email." }, { status: 400 });
  if (role !== "student" && role !== "professor") return Response.json({ error: "Pick a role." }, { status: 400 });
  const user = findOrCreateUser(name?.trim() || email.split("@")[0], email, role);
  const store = await cookies();
  store.set(SESSION_COOKIE, user.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return Response.json({ user });
}
