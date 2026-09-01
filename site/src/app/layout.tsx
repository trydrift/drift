import type { Metadata, Viewport } from "next";
import { inter, instrumentSerif } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drift — did that dependency update break your code?",
  description:
    "Drift checks dependency updates against the code that uses them, shows the evidence, and prepares a fix you can review.",
  openGraph: {
    title: "Drift",
    description:
      "Your dependency updated. Drift checks whether it broke your code and shows the evidence.",
    type: "website",
  },
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#07100c",
};

/**
 * Theme before paint.
 *
 * Reading the stored preference in an effect means one frame of the wrong
 * background, which on a dark-mode machine is a white flash on every
 * navigation. This runs synchronously in `<head>`'s shadow before the body
 * renders, and tints the browser chrome to match so the status bar on a phone
 * does not sit as a bright seam above a dark page.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('drift:theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.setAttribute('name','theme-color');document.head.appendChild(m);}m.setAttribute('content',d?'#07100c':'#f4faf6');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
