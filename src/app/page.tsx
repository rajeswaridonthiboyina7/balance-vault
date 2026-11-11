import Link from "next/link";
import { Navbar } from "@/components/Navbar";

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Navbar />

      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 text-xs font-mono mb-6">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            HMAC-SHA256 Cryptographic Chain
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white">
            Money Movement with a{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
              Ledger You Can Prove
            </span>
          </h1>

          <p className="mt-6 text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            BalanceVault guarantees immutable financial integrity. Built with atomic
            double-entry accounting, serial advisory locking, and continuous cryptographic
            tamper detection.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/register"
              className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition-all hover:scale-105"
            >
              Get Started — Open Account
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800 hover:border-slate-700 px-6 py-3.5 text-sm font-semibold text-slate-200 transition-all"
            >
              Sign In to Vault
            </Link>
          </div>

          {/* Pillars feature grid */}
          <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-6 text-left">
            <div className="p-6 rounded-2xl border border-slate-800/80 bg-slate-900/40">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4 font-mono font-bold">
                01
              </div>
              <h3 className="text-base font-semibold text-white">
                Atomic Double-Entry
              </h3>
              <p className="mt-2 text-sm text-slate-400 leading-normal">
                Every transaction balances: debits strictly equal credits across
                deterministic ascending row locks.
              </p>
            </div>

            <div className="p-6 rounded-2xl border border-slate-800/80 bg-slate-900/40">
              <div className="h-8 w-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 mb-4 font-mono font-bold">
                02
              </div>
              <h3 className="text-base font-semibold text-white">
                Cryptographic Proofs
              </h3>
              <p className="mt-2 text-sm text-slate-400 leading-normal">
                HMAC-chained entries linked to genesis. Tampering with any historical record
                breaks the proof immediately.
              </p>
            </div>

            <div className="p-6 rounded-2xl border border-slate-800/80 bg-slate-900/40">
              <div className="h-8 w-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-4 font-mono font-bold">
                03
              </div>
              <h3 className="text-base font-semibold text-white">
                Advisory-Locked Monotonicity
              </h3>
              <p className="mt-2 text-sm text-slate-400 leading-normal">
                Transaction-level serial advisory locking guarantees strictly contiguous
                sequence numbers under high concurrency.
              </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-500 font-mono">
        BalanceVault • Snovasys Hiring Challenge 2026 • Provable Ledger System
      </footer>
    </div>
  );
}
