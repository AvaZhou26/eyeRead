import { getCurrentUser } from "@/lib/auth";
import { createCourse } from "@/lib/db";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "professor") return Response.json({ error: "Only professors can create courses." }, { status: 403 });
  const { name, code, term } = (await req.json()) as { name?: string; code?: string; term?: string };
  if (!name?.trim() || !code?.trim()) return Response.json({ error: "Course name and code are required." }, { status: 400 });
  const course = createCourse(user.id, name, code, term ?? "");
  return Response.json({ course });
}
