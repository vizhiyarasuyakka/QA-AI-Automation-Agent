import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = { title: "QA Workflow", description: "Run the QA workflow from PRD to sign-off, with gates, execution, bugs and reports." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <header className="topbar">
          <Link href="/releases" className="brand">
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><path d="M8 3v14" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="3" r="2.5" fill="currentColor" /><circle cx="8" cy="10" r="2.5" fill="currentColor" /><circle cx="8" cy="17" r="2.5" fill="var(--panel)" stroke="currentColor" strokeWidth="1.5" /></svg>
            QA Workflow
          </Link>
          <nav>
            <Link href="/releases">Releases</Link>
            <Link href="/settings">Settings</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
