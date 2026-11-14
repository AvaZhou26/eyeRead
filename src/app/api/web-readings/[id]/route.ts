import { getCurrentUser } from "@/lib/auth";
import { deleteWebReading } from "@/lib/db";

export async function DELETE(_req: Request, { params }: RouteContext<"/api/web-readings/[id]">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  const ok = await deleteWebReading(id, user.id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "Not found." }, { status: 404 });
}
