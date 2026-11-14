// The signed-in student's eye-tracking calibration: saved after they calibrate, so later
// readings can start without calibrating again (see lib/gaze/savedCalibration.ts).
import { getCurrentUser } from "@/lib/auth";
import { saveCalibration } from "@/lib/db";
import { parseSavedCalibration } from "@/lib/gaze/savedCalibration";

/** A saved calibration is a few kB; anything far bigger isn't one. */
const MAX_BODY = 100_000;

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  const calibration = parseSavedCalibration((body as { calibration?: unknown } | null)?.calibration);
  if (!calibration) return Response.json({ error: "Not a valid calibration." }, { status: 400 });
  await saveCalibration(user.id, calibration);
  return Response.json({ ok: true });
}
