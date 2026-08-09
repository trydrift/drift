import { Inter, Instrument_Serif } from "next/font/google";

// Body / UI. Self-hosted by next/font at build time: no layout shift, no
// request to Google at runtime.
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Editorial display, for the hero and section headings — the same voice the
// reference site uses, which is what keeps a technical page from reading like
// a spec sheet.
export const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});
