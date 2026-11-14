import { getCurrentUser } from "@/lib/auth";
import { joinCourse } from "@/lib/db";
import { readJsonBody, strField } from "@/lib/validate";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  // Teachers run courses; they don't enrol in them (they would show up in the class list and CSV).
  if (user.role !== "student") return Response.json({ error: "Only student accounts can join a course." }, { status: 403 });
  const body = await readJsonBody(req);
  const joinCode = body ? strField(body, "joinCode") : undefined;
  const course = joinCode ? await joinCourse(user.id, joinCode) : null;
  if (!course) return Response.json({ error: "No course found with that code." }, { status: 404 });
  return Response.json({ course });
}
