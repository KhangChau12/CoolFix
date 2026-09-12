import type { Metadata } from "next";
import "./globals.css";
import ClockSync from "@/components/ClockSync";

export const metadata: Metadata = {
  title: "CoolFix — Multi-Agent Technician Scheduling",
  description:
    "A multi-agent system that dispatches aircon-servicing technicians and handles schedule disruptions — Show Me Your Agents Hackathon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ClockSync>{children}</ClockSync>
      </body>
    </html>
  );
}
