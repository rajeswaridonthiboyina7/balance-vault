"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { Badge } from "@/components/Badge";

// ─── Types ───────────────────────────────────────────────────────────────────

interface VerifyResult {
  intact: boolean;
  verifiedCount: number;
  totalEntries: number;
  firstInvalidSequence: number | null;
  brokenReason: string | null;
  chainTip?: { sequenceNo: number; entryHash: string };
  latestCheckpoint?: { sequenceNo: number; checkpointHash: string; verifiedAt: string } | null;
}

interface Checkpoint {
  id: string;
  sequenceNo: number;
  entryHash: string;
  checkpointHash: string;
  verifiedEntriesCount: number;
  createdAt: string;
}

interface AdminAccount {
  id: string;
  accountNumber: string;
  balance: string | number;
  status: string;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  accounts: AdminAccount[];
}

interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  ipAddress: string | null;
  details: string | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtBalance(val: string | number): string {
  return Number(val).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncHash(hash: string, len = 16): string {
  return hash.length > len ? `${hash.slice(0, len)}…` : hash;
}

function statusBadge(status: string) {
  const v =
    status === "ACTIVE"
      ? "success"
      : status === "FROZEN"
      ? "warning"
      : status === "SUSPENDED"
      ? "danger"
      : "neutral";
  return <Badge variant={v}>{status}</Badge>;
}

function roleBadge(role: string) {
  return (
    <Badge variant={role === "ADMIN" ? "purple" : "info"}>{role}</Badge>
  );
}

// ─── Copy Button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");

  const handleCopy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyStatus("success");
        setTimeout(() => setCopyStatus("idle"), 2000);
      })
      .catch(() => {
        setCopyStatus("error");
        setTimeout(() => setCopyStatus("idle"), 3000);
      });
  };

  return (
    <button
      onClick={handleCopy}
      title={
        copyStatus === "error"
          ? "Copy failed. Please copy manually."
          : "Copy full value"
      }
      className={`ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs transition-colors ${
        copyStatus === "error"
          ? "text-rose-400 bg-rose-500/10 font-sans"
          : copyStatus === "success"
          ? "text-emerald-400 bg-emerald-500/10 font-sans"
          : "text-slate-400 hover:text-emerald-400 hover:bg-slate-800"
      }`}
    >
      {copyStatus === "success"
        ? "Copied"
        : copyStatus === "error"
        ? "Copy failed. Please copy manually."
        : "⎘"}
    </button>
  );
}

// ─── Tab 1: Ledger Integrity ──────────────────────────────────────────────────

function LedgerIntegrityTab() {
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(true);
  const [checkpointsError, setCheckpointsError] = useState<string | null>(null);

  const [cpLoading, setCpLoading] = useState(false);
  const [cpMsg, setCpMsg] = useState<{ type: "success" | "info" | "error"; text: string } | null>(null);

  const fetchCheckpoints = useCallback(async () => {
    setCheckpointsLoading(true);
    setCheckpointsError(null);
    try {
      const res = await fetch("/api/admin/checkpoints");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCheckpoints(data.checkpoints ?? []);
    } catch (err: any) {
      setCheckpointsError(err.message || "Failed to load checkpoints");
    } finally {
      setCheckpointsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCheckpoints();
  }, [fetchCheckpoints]);

  const handleVerify = async () => {
    setVerifyLoading(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/ledger/verify", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setVerifyResult(data);
    } catch (err: any) {
      setVerifyError(err.message || "Verification failed");
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleCreateCheckpoint = async () => {
    setCpLoading(true);
    setCpMsg(null);
    try {
      const res = await fetch("/api/admin/checkpoints", { method: "POST" });
      const data = await res.json();
      if (res.status === 201) {
        setCpMsg({ type: "success", text: "Checkpoint created successfully." });
        await fetchCheckpoints();
      } else if (res.status === 200) {
        setCpMsg({ type: "info", text: data.message || "Checkpoint already exists for current chain tip." });
      } else {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      setCpMsg({ type: "error", text: err.message || "Failed to create checkpoint" });
    } finally {
      setCpLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Verify & Checkpoint Actions */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-base font-semibold text-white mb-4">Chain Verification</h2>
        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={handleVerify}
            disabled={verifyLoading}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {verifyLoading ? "Verifying…" : "Verify Ledger"}
          </button>
          <button
            onClick={handleCreateCheckpoint}
            disabled={cpLoading}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {cpLoading ? "Creating…" : "Create Checkpoint"}
          </button>
        </div>

        {/* Verify error */}
        {verifyError && (
          <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-3 text-rose-400 text-sm mb-3">
            {verifyError}
          </div>
        )}

        {/* Verify result */}
        {verifyResult && (
          <div
            className={`rounded-lg border p-4 text-sm ${
              verifyResult.intact
                ? "bg-emerald-500/10 border-emerald-500/20"
                : "bg-rose-500/10 border-rose-500/20"
            }`}
          >
            <div className="flex items-center gap-2 mb-3">
              <Badge variant={verifyResult.intact ? "success" : "danger"}>
                {verifyResult.intact ? "✓ INTACT" : "✗ COMPROMISED"}
              </Badge>
              <span className="text-slate-300">
                {verifyResult.verifiedCount} / {verifyResult.totalEntries} entries verified
              </span>
            </div>

            {verifyResult.intact && verifyResult.chainTip && (
              <div className="space-y-1.5 text-slate-400">
                <div>
                  <span className="text-slate-500">Chain Tip Seq:</span>{" "}
                  <span className="text-slate-200 font-mono">#{verifyResult.chainTip.sequenceNo}</span>
                </div>
                <div className="flex items-center">
                  <span className="text-slate-500 mr-1">Tip Hash:</span>
                  <span className="font-mono text-slate-200">
                    {truncHash(verifyResult.chainTip.entryHash, 24)}
                  </span>
                  <CopyButton text={verifyResult.chainTip.entryHash} />
                </div>
                {verifyResult.latestCheckpoint && (
                  <div>
                    <span className="text-slate-500">Latest Checkpoint:</span>{" "}
                    <span className="text-slate-200 font-mono">
                      seq #{verifyResult.latestCheckpoint.sequenceNo}
                    </span>{" "}
                    <span className="text-slate-500">
                      (anchored {fmtDate(verifyResult.latestCheckpoint.verifiedAt)})
                    </span>
                  </div>
                )}
                {!verifyResult.latestCheckpoint && (
                  <div className="text-amber-400">No checkpoint exists yet.</div>
                )}
              </div>
            )}

            {!verifyResult.intact && (
              <div className="text-rose-300 mt-2">
                <span className="font-medium">First invalid at seq:</span>{" "}
                #{verifyResult.firstInvalidSequence}
                {verifyResult.brokenReason && (
                  <p className="mt-1 text-xs">{verifyResult.brokenReason}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Checkpoint action message */}
        {cpMsg && (
          <div
            className={`mt-3 rounded-lg border p-3 text-sm ${
              cpMsg.type === "success"
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : cpMsg.type === "info"
                ? "bg-sky-500/10 border-sky-500/20 text-sky-400"
                : "bg-rose-500/10 border-rose-500/20 text-rose-400"
            }`}
          >
            {cpMsg.text}
          </div>
        )}
      </div>

      {/* Checkpoint Registry */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-base font-semibold text-white mb-4">Checkpoint Registry</h2>

        {checkpointsLoading ? (
          <div className="text-slate-400 text-sm">Loading checkpoints…</div>
        ) : checkpointsError ? (
          <div className="text-rose-400 text-sm">{checkpointsError}</div>
        ) : checkpoints.length === 0 ? (
          <div className="text-slate-500 text-sm">No checkpoints recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Seq #
                  </th>
                  <th className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Entries
                  </th>
                  <th className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Checkpoint Digest
                  </th>
                  <th className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Anchored Tip Hash
                  </th>
                  <th className="pb-2 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Timestamp
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {checkpoints.map((cp) => (
                  <tr key={cp.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 pr-4 font-mono text-slate-200">#{cp.sequenceNo}</td>
                    <td className="py-3 pr-4 text-slate-300">{cp.verifiedEntriesCount}</td>
                    <td className="py-3 pr-4">
                      <span className="font-mono text-slate-300">{truncHash(cp.checkpointHash)}</span>
                      <CopyButton text={cp.checkpointHash} />
                    </td>
                    <td className="py-3 pr-4">
                      <span className="font-mono text-slate-300">{truncHash(cp.entryHash)}</span>
                      <CopyButton text={cp.entryHash} />
                    </td>
                    <td className="py-3 text-slate-400 whitespace-nowrap">{fmtDate(cp.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab 2: Users & Accounts ──────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/users");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setUsers(data.users ?? []);
      } catch (err: any) {
        setError(err.message || "Failed to load users");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading)
    return <div className="text-slate-400 text-sm mt-4">Loading users…</div>;
  if (error)
    return <div className="text-rose-400 text-sm mt-4">{error}</div>;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-base font-semibold text-white mb-4">
        Users & Accounts{" "}
        <span className="text-slate-500 font-normal text-sm">({users.length} total)</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              {["Name", "Email", "Role", "Account #", "Balance", "Acct Status", "Joined"].map((h) => (
                <th
                  key={h}
                  className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {users.map((user) => {
              const acct = user.accounts[0];
              return (
                <tr key={user.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 pr-4 text-slate-200 font-medium whitespace-nowrap">
                    {user.name}
                  </td>
                  <td className="py-3 pr-4 text-slate-300">{user.email}</td>
                  <td className="py-3 pr-4">{roleBadge(user.role)}</td>
                  <td className="py-3 pr-4 font-mono text-slate-300 text-xs">
                    {acct ? acct.accountNumber : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-3 pr-4 text-slate-200 whitespace-nowrap">
                    {acct ? (
                      <span className="font-mono">${fmtBalance(acct.balance)}</span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {acct ? statusBadge(acct.status) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-3 text-slate-400 whitespace-nowrap">
                    {fmtDate(user.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Tab 3: Audit Trail ───────────────────────────────────────────────────────

function AuditTrailTab() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const LIMIT = 15;

  // Filters
  const [actionFilter, setActionFilter] = useState("");
  const [appliedAction, setAppliedAction] = useState("");

  const fetchLogs = useCallback(
    async (pg: number, action: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(pg),
          limit: String(LIMIT),
        });
        if (action) params.set("action", action);
        const res = await fetch(`/api/admin/audit-logs?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
        setTotalPages(data.totalPages ?? 1);
      } catch (err: any) {
        setError(err.message || "Failed to load audit logs");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchLogs(page, appliedAction);
  }, [fetchLogs, page, appliedAction]);

  const handleApplyFilter = () => {
    setPage(1);
    setAppliedAction(actionFilter.trim());
  };

  const handleClearFilter = () => {
    setActionFilter("");
    setPage(1);
    setAppliedAction("");
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">
          Audit Trail{" "}
          <span className="text-slate-500 font-normal text-sm">({total} records)</span>
        </h2>
        <div className="flex items-center gap-2 ml-auto">
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleApplyFilter()}
            placeholder="Filter by action…"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50 w-48"
          />
          <button
            onClick={handleApplyFilter}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
          >
            Apply
          </button>
          {appliedAction && (
            <button
              onClick={handleClearFilter}
              className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-3 text-rose-400 text-sm mb-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : logs.length === 0 ? (
        <div className="text-slate-500 text-sm">
          {appliedAction ? `No audit logs matching "${appliedAction}".` : "No audit logs found."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                {["Action", "Entity", "Actor", "Details", "Timestamp"].map((h) => (
                  <th
                    key={h}
                    className="pb-2 pr-4 text-left text-xs font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 pr-4">
                    <span className="font-mono text-xs text-sky-400">{log.action}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant="neutral">{log.entity}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-slate-300 text-xs whitespace-nowrap">
                    {log.actorEmail ?? (
                      <span className="text-slate-600">{log.actorId ?? "—"}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-slate-400 max-w-xs">
                    <span
                      className="block truncate"
                      title={log.details ?? undefined}
                    >
                      {log.details ?? <span className="text-slate-600">—</span>}
                    </span>
                  </td>
                  <td className="py-3 text-slate-400 whitespace-nowrap text-xs">
                    {fmtDate(log.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ← Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────

type TabKey = "ledger" | "users" | "audit";

const TABS: { key: TabKey; label: string }[] = [
  { key: "ledger", label: "Ledger Integrity" },
  { key: "users", label: "Users & Accounts" },
  { key: "audit", label: "Audit Trail" },
];

export default function AdminPage() {
  const router = useRouter();
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("ledger");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const data = await res.json();
        if (data.user?.role !== "ADMIN") {
          router.replace("/dashboard");
          return;
        }
        setAuthLoading(false);
      } catch {
        router.replace("/login");
      }
    })();
  }, [router]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Verifying access…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* Page Header */}
        <div className="mb-6 flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Console</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              Ledger integrity, user management, and audit trail
            </p>
          </div>
          <Badge variant="purple" className="ml-auto">
            ADMIN
          </Badge>
        </div>

        {/* Tab Nav */}
        <div className="mb-6 border-b border-slate-800">
          <nav className="flex gap-1" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                  activeTab === tab.key
                    ? "text-white border-b-2 border-emerald-500 -mb-px"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Panels */}
        {activeTab === "ledger" && <LedgerIntegrityTab />}
        {activeTab === "users" && <UsersTab />}
        {activeTab === "audit" && <AuditTrailTab />}
      </main>
    </div>
  );
}

