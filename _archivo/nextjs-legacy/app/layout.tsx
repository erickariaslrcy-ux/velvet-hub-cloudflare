import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VELVET HUB +18 | Streaming Privado & Cómics",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <meta name="referrer" content="no-referrer" />
        <link rel="icon" href="/velvet_logo.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
