import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "did we ship today?",
  description: "Shipping tracker — GitHub + X heatmaps and streaks.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-mono bg-nerv-bg text-nerv-text antialiased">
        {children}
      </body>
    </html>
  );
}
