import type { Metadata } from "next";
import { Atkinson_Hyperlegible, Inter, Literata } from "next/font/google";
import "./globals.css";

const ui = Inter({ variable: "--font-ui", subsets: ["latin"] });
const serif = Literata({ variable: "--font-reader-serif", subsets: ["latin"] });
const hyper = Atkinson_Hyperlegible({ variable: "--font-reader-hyper", subsets: ["latin"], weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Read Assist",
  description: "A reading coach that notices what you skipped, so you don't have to.",
};

// Runs before the first paint so the saved theme never "flashes".
const themeScript = `try{var t=localStorage.getItem('ra-theme');if(t&&t!=='system')document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${serif.variable} ${hyper.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* Browser extensions often insert their own <script> at the top of <head> before React
            hydrates. React then pairs that tag with this one (same tag type) and reports
            "attributes didn't match". This script has already run and never changes, so it's
            safe to tell React to accept whatever it finds here. */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      {/* Extensions like Grammarly or custom-cursor tools add attributes to <body> before React
          hydrates. suppressHydrationWarning only ignores attribute mismatches on this one element,
          not its children. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
