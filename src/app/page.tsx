export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <div className="max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 shadow-sm">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          BalanceVault
        </h1>
        <p className="mt-3 text-slate-600 dark:text-slate-400">
          Money Movement with a Ledger You Can Prove.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 text-xs font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 py-2 px-4 rounded-full border border-emerald-200 dark:border-emerald-800">
          <span>● Stage 1: Core Database & Verification Schema Initialized</span>
        </div>
      </div>
    </main>
  );
}

