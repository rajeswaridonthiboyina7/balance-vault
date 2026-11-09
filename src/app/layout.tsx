import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BalanceVault - Provable Financial Ledger",
  description: "Secure money movement with tamper-evident cryptographic ledger",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}

