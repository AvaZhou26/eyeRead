import { getCurrentUser } from "@/lib/auth";
import { createReading, getCourse } from "@/lib/db";
import { dueDateFromInput, toParagraphs } from "@/lib/text";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json()) as {
    title?: string;
    text?: string;
    courseId?: string | null;
    dueDate?: string | null;
    instructions?: string;
    source?: "paste" | "pdf" | "image";
  };
  const paragraphs = toParagraphs(body.text ?? "");
  if (!body.title?.trim()) return Response.json({ error: "Give the reading a title." }, { status: 400 });
  if (paragraphs.length === 0) return Response.json({ error: "The reading has no text." }, { status: 400 });

  let courseId: string | null = null;
  if (body.courseId) {
    const course = await getCourse(body.courseId);
    if (!course || course.professorId !== user.id)
      return Response.json({ error: "Only the course's professor can post readings to it." }, { status: 403 });
    courseId = course.id;
  }

  const reading = await createReading({
    title: body.title.trim(),
    paragraphs,
    ownerId: user.id,
    courseId,
    dueDate: body.dueDate ? dueDateFromInput(body.dueDate) : null,
    instructions: body.instructions?.trim() ?? "",
    source: body.source === "pdf" || body.source === "image" ? body.source : "paste",
  });
  return Response.json({ reading });
}
