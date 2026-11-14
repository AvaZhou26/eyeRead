"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Removes an imported article from the account. The extension keeps its own copy. */
export function RemoveWebReading({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      onClick={async () => {
        if (!confirm("Remove this article from your account? It comes back only if you read it again with the extension.")) return;
        setBusy(true);
        const res = await fetch(`/api/web-readings/${id}`, { method: "DELETE" });
        if (res.ok) {
          router.push("/dashboard");
          router.refresh();
        } else setBusy(false);
      }}
    >
      Remove
    </button>
  );
}
