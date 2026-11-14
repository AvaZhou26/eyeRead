import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { Logo } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-surface-2 border-r border-border">
        <Logo size={26} />
        <div className="max-w-md">
          <p className="font-serif text-[28px] leading-snug tracking-tight">
            A quiet reading coach that notices what you skipped, so you don&apos;t have to.
          </p>
          <ul className="mt-8 space-y-3 text-[15px] text-muted">
            <li className="flex gap-3"><Dot c="var(--read)" />Your webcam follows your reading line by line, entirely on your device.</li>
            <li className="flex gap-3"><Dot c="var(--skim)" />See what you read, skimmed or skipped, plus your focus and pace.</li>
            <li className="flex gap-3"><Dot c="var(--reread)" />Get AI summaries of anything you missed, with a quick check-in quiz.</li>
          </ul>
        </div>
        <p className="text-xs text-faint">Hackathon demo. Video never leaves your browser.</p>
      </div>
      <div className="flex flex-col">
        <div className="flex justify-between items-center p-5">
          <span className="lg:hidden"><Logo /></span>
          <span className="ml-auto"><ThemeToggle /></span>
        </div>
        <div className="flex-1 flex items-center justify-center px-6 pb-16">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome</h1>
            <p className="text-muted mt-1.5 mb-8 text-[15px]">Sign in with any name and email. This is a demo, so there are no passwords.</p>
            <LoginForm />
          </div>
        </div>
      </div>
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span className="mt-2 h-2 w-2 rounded-full shrink-0" style={{ background: c }} />;
}
