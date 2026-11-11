"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rateLimitCountdown, setRateLimitCountdown] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          const seconds = retryAfter ? parseInt(retryAfter, 10) : 60;
          setRateLimitCountdown(seconds);
          setError(
            data.error ||
              "Rate limit exceeded. Too many login attempts. Please wait before retrying."
          );

          // Countdown timer
          const interval = setInterval(() => {
            setRateLimitCountdown((prev) => {
              if (!prev || prev <= 1) {
                clearInterval(interval);
                return null;
              }
              return prev - 1;
            });
          }, 1000);
        } else {
          setError(data.error || "Authentication failed. Please verify credentials.");
        }
        setIsLoading(false);
        return;
      }

      // Check user role from actual response payload or /api/auth/me
      const userRole = data.user?.role;
      if (userRole === "ADMIN") {
        router.push("/admin");
      } else {
        router.push("/dashboard");
      }
      router.refresh();
    } catch (err: any) {
      setError("An unexpected network error occurred. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Navbar />

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl backdrop-blur-md">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Sign In to BalanceVault
            </h1>
            <p className="mt-1.5 text-sm text-slate-400">
              Access your accounts and inspect cryptographic ledger records.
            </p>
          </div>

          {error && (
            <div className="mb-5 rounded-lg border border-rose-500/20 bg-rose-500/10 p-3.5 text-sm text-rose-400">
              <div className="flex items-start gap-2.5">
                <svg
                  className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div className="flex-1">
                  <span>{error}</span>
                  {rateLimitCountdown !== null && (
                    <div className="mt-1 font-mono text-xs text-rose-300">
                      Retry enabled in: {rateLimitCountdown}s
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@domain.com"
                className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                disabled={isLoading || rateLimitCountdown !== null}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                disabled={isLoading || rateLimitCountdown !== null}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading || rateLimitCountdown !== null}
              className="w-full mt-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 py-3 text-sm font-semibold text-white shadow-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-slate-400">
            Don&apos;t have an account yet?{" "}
            <Link
              href="/register"
              className="text-emerald-400 hover:text-emerald-300 font-medium underline underline-offset-4"
            >
              Open an Account
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

