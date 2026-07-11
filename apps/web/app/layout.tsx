import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Beacon",
  description:
    "Monitor anything you ship — a self-hosted dashboard for the services I run.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `dynamic` is required for our Content-Security-Policy: it routes Clerk
    // through DynamicClerkScripts, which stamps the per-request CSP nonce onto
    // clerk.browser.js. Without it, Clerk injects its script client-side with no
    // nonce and our strict-dynamic script-src blocks it. Do not remove without
    // re-validating the CSP. See docs/superpowers/specs/2026-07-11-csp-report-only-design.md.
    <ClerkProvider dynamic>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full`}
      >
        <body className="min-h-screen bg-zinc-50 font-sans text-zinc-900 antialiased">
          {children}
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}
