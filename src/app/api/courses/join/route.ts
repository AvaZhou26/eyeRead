import { getCurrentUser } from "@/lib/auth";
import { joinCourse } from "@/lib/db";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { joinCode } = (await req.json()) as { joinCode?: string };
  const course = joinCode ? joinCourse(user.id, joinCode) : null;
  if (!course) return Response.json({ error: "No course found with that code." }, { status: 404 });
  return Response.json({ course });
}
