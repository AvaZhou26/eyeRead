"use client";
import { useRouter } from "next/navigation";
import { IconLogout } from "./icons";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-ghost !px-2.5 !py-1.5 text-muted hover:text-fg"
      title="Sign out"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
    >
      <IconLogout size={16} />
    </button>
  );
}
