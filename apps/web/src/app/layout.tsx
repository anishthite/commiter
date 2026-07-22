import "./globals.css";
import type { Metadata } from "next";

const title = "did we ship today?";
const description = "Shipping tracker — GitHub + X heatmaps and streaks.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    siteName: title,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

// Runs before paint to apply the persisted theme. Light is the default
// for both first-visit users and when localStorage is unavailable; the
// dark theme is opt-in via the ThemeToggle. Kept tiny + sync so there's
// no flash of the wrong theme.
const themeBootstrap = `(() => {
  try {
    var t = localStorage.getItem("nerv-theme");
    document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="font-mono bg-nerv-bg text-nerv-text antialiased">
        {children}
      </body>
    </html>
  );
}
