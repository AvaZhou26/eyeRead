import { getCurrentUser } from "@/lib/auth";
import { pdfToText } from "@/lib/pdf";
import { cleanExtractedText } from "@/lib/gemini";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const form = await req.formData();
  const file = form.get("file");
  const useAi = form.get("ai") === "1";
  if (!(file instanceof File)) return Response.json({ error: "No file uploaded." }, { status: 400 });
  if (file.size > 25 * 1024 * 1024) return Response.json({ error: "PDF is too large (25 MB max)." }, { status: 400 });
  try {
    const { text, pages } = await pdfToText(await file.arrayBuffer());
    if (!text.trim())
      return Response.json(
        { error: "Couldn't find any text in that PDF. It may be a scanned image; try copying the text in instead." },
        { status: 422 },
      );
    let finalText = text;
    let cleanedByAi = false;
    if (useAi) {
      const cleaned = await cleanExtractedText(text);
      if (cleaned) {
        finalText = cleaned;
        cleanedByAi = true;
      }
    }
    const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
    return Response.json({ text: finalText, pages, title, cleanedByAi });
  } catch (err) {
    console.error("[pdf] extraction failed:", err);
    return Response.json({ error: "Couldn't read that PDF." }, { status: 500 });
  }
}
