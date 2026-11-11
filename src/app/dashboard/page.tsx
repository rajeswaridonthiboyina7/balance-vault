"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";

interface Account {
  id: string;
  accountNumber: string;
  balance: string | number;
  currency: string;
  status: "ACTIVE" | "FROZEN" | "SUSPENDED";
}

interface LedgerProofEntry {
  sequenceNo: number;
  entryType: "DEBIT" | "CREDIT";
  amount: string | number;
  balanceAfter: string | number;
  prevHash: string;
  entryHash: string;
}

interface TransactionItem {
  id: string;
  type: "TRANSFER" | "DEPOSIT" | "WITHDRAWAL";
  status: string;
  amount: string | number;
  currency: string;
  direction: "INCOMING" | "OUTGOING";
  fromAccount: string;
  toAccount: string;
  reference?: string;
  timestamp: string;
  ledgerProof?: LedgerProofEntry[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [accountCopyStatus, setAccountCopyStatus] = useState<string | null>(null);
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  const [hashCopyState, setHashCopyState] = useState<{
    key: string;
    message: string;
    isError: boolean;
  } | null>(null);

  const copyHash = (text: string, key: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setHashCopyState({ key, message: "Copied", isError: false });
        setTimeout(() => setHashCopyState(null), 2000);
      })
      .catch(() => {
        setHashCopyState({
          key,
          message: "Copy failed. Please copy manually.",
          isError: true,
        });
        setTimeout(() => setHashCopyState(null), 3000);
      });
  };

  // Financial Action Modals
  const [modalType, setModalType] = useState<"DEPOSIT" | "WITHDRAW" | "TRANSFER" | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [receiverAccountInput, setReceiverAccountInput] = useState("");
  const [referenceInput, setReferenceInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Idempotency Key Management:
  // Active key is generated once when a form opens or is prepared.
  // It is preserved during retries of the exact same request payload,
  // and rotated only when a new operation is started.
  const idempotencyKeyRef = useRef<string>("");

  const generateNewIdempotencyKey = () => {
    idempotencyKeyRef.current = `idemp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  };

  // Authenticate session and redirect ADMIN / Unauthenticated
  useEffect(() => {
    async function verifyUserSession() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (!res.ok) {
          throw new Error("Failed to verify session");
        }
        const data = await res.json();
        if (data.user?.role === "ADMIN") {
          router.push("/admin");
          return;
        }
      } catch (err) {
        console.error("Session verification error:", err);
        router.push("/login");
      }
    }
    verifyUserSession();
  }, [router]);

  // Fetch Statement & Account (strictly non-optimistic source of truth)
  const fetchStatement = useCallback(async (targetPage = 1) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/statement?page=${targetPage}&limit=10`);
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to load account statement.");
      }
      const data = await res.json();
      if (data.accounts && data.accounts.length > 0) {
        setAccount(data.accounts[0]);
      }
      if (data.statement) {
        setTransactions(data.statement.transactions || []);
        setPage(data.statement.page || 1);
        setTotalPages(data.statement.totalPages || 1);
        setTotalCount(data.statement.total || 0);
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred while loading your account.");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchStatement(1);
  }, [fetchStatement]);

  const handleCopy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setAccountCopyStatus("Copied");
        setTimeout(() => setAccountCopyStatus(null), 2000);
      })
      .catch(() => {
        setAccountCopyStatus("Copy failed. Please copy manually.");
        setTimeout(() => setAccountCopyStatus(null), 3000);
      });
  };

  const openModal = (type: "DEPOSIT" | "WITHDRAW" | "TRANSFER") => {
    setModalType(type);
    setAmountInput("");
    setReceiverAccountInput("");
    setReferenceInput("");
    setActionError(null);
    setActionSuccess(null);
    generateNewIdempotencyKey();
  };

  const closeModal = () => {
    if (isSubmitting) return; // Prevent closing while processing
    setModalType(null);
    setAmountInput("");
    setReceiverAccountInput("");
    setReferenceInput("");
    setActionError(null);
    setActionSuccess(null);
  };

  const handleActionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // Prevent duplicate concurrent submissions

    setActionError(null);
    setActionSuccess(null);

    const parsedAmount = parseFloat(amountInput);
    if (!amountInput || isNaN(parsedAmount) || parsedAmount <= 0) {
      setActionError("Amount must be a positive number greater than 0.");
      return;
    }

    if (modalType === "DEPOSIT") {
      if (parsedAmount > 10000) {
        setActionError("Single deposit limit is $10,000.00.");
        return;
      }
    }

    if (modalType === "WITHDRAW") {
      const currentBalance = Number(account?.balance || 0);
      if (parsedAmount > currentBalance) {
        setActionError(
          `Insufficient balance. Available balance is $${currentBalance.toFixed(2)}, attempted to withdraw $${parsedAmount.toFixed(2)}.`
        );
        return;
      }
    }

    if (modalType === "TRANSFER") {
      if (!receiverAccountInput.trim()) {
        setActionError("Recipient account number is required.");
        return;
      }
      if (account && receiverAccountInput.trim() === account.accountNumber) {
        setActionError("Cannot transfer funds to the same account.");
        return;
      }
      const currentBalance = Number(account?.balance || 0);
      if (parsedAmount > currentBalance) {
        setActionError(
          `Insufficient balance. Available balance is $${currentBalance.toFixed(2)}, attempted to transfer $${parsedAmount.toFixed(2)}.`
        );
        return;
      }
    }

    setIsSubmitting(true);

    try {
      let endpoint = "";
      let payload: any = {
        amount: parsedAmount,
        reference: referenceInput.trim() || undefined,
      };

      if (modalType === "DEPOSIT") {
        endpoint = "/api/transactions/deposit";
      } else if (modalType === "WITHDRAW") {
        endpoint = "/api/transactions/withdraw";
      } else if (modalType === "TRANSFER") {
        endpoint = "/api/transactions/transfer";
        payload.receiverAccountNumber = receiverAccountInput.trim();
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": idempotencyKeyRef.current,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setActionError(data.error || "Transaction could not be completed.");
        setIsSubmitting(false);
        return;
      }

      setActionSuccess(data.message || "Transaction completed successfully!");

      // Strictly NON-OPTIMISTIC: refresh entire statement and balance directly from the database API
      await fetchStatement(1);

      // Rotate idempotency key after successful transaction
      generateNewIdempotencyKey();

      setTimeout(() => {
        closeModal();
      }, 1000);
    } catch (err: any) {
      setActionError("Network error occurred. The existing request key is preserved for safe retry.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
        {/* Error Notification */}
        {error && (
          <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-400 flex items-start gap-3">
            <svg
              className="w-5 h-5 flex-shrink-0 text-rose-400 mt-0.5"
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
            <div>
              <p className="font-semibold text-rose-300">Unable to load account</p>
              <p className="mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Account Overview Header */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Main Balance Card */}
          <div className="md:col-span-2 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-900/60 p-6 shadow-xl relative overflow-hidden flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
                  Primary Vault Account
                </span>
                {account ? (
                  <Badge
                    variant={
                      account.status === "ACTIVE"
                        ? "success"
                        : account.status === "FROZEN"
                        ? "warning"
                        : "danger"
                    }
                  >
                    {account.status}
                  </Badge>
                ) : (
                  <div className="h-5 w-16 bg-slate-800 rounded animate-pulse" />
                )}
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight">
                  {isLoading && !account
                    ? "..."
                    : `$${Number(account?.balance || 0).toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`}
                </span>
                <span className="text-sm font-semibold text-slate-400">
                  {account?.currency || "USD"}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-2 text-xs font-mono text-slate-400">
                <span>Account Number:</span>
                <span className="text-slate-200 font-semibold tracking-wider">
                  {account?.accountNumber || "—"}
                </span>
                {account && (
                  <button
                    onClick={() => handleCopy(account.accountNumber)}
                    className="ml-1 text-slate-400 hover:text-white transition-colors"
                    title="Copy Account Number"
                  >
                    {accountCopyStatus ? (
                      <span
                        className={`font-sans text-xs ${
                          accountCopyStatus === "Copied"
                            ? "text-emerald-400"
                            : "text-rose-400"
                        }`}
                      >
                        {accountCopyStatus}
                      </span>
                    ) : (
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Financial Action Buttons */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                onClick={() => openModal("DEPOSIT")}
                disabled={account?.status !== "ACTIVE"}
                className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-semibold text-white shadow-md transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Deposit
              </button>
              <button
                onClick={() => openModal("WITHDRAW")}
                disabled={account?.status !== "ACTIVE" || Number(account?.balance || 0) <= 0}
                className="rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs font-semibold text-white transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
                Withdraw
              </button>
              <button
                onClick={() => openModal("TRANSFER")}
                disabled={account?.status !== "ACTIVE" || Number(account?.balance || 0) <= 0}
                className="rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs font-semibold text-white transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Transfer
              </button>
            </div>
          </div>

          {/* Account Detail Information */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-emerald-400">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
                <h3 className="text-sm font-semibold text-white">Provable Ledger Backed</h3>
              </div>
              <p className="mt-2.5 text-xs text-slate-400 leading-relaxed">
                Your balances are computed directly from cryptographically linked, double-entry
                ledger sequences anchored to the Genesis checkpoint.
              </p>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800 text-[11px] font-mono text-slate-500 space-y-1.5">
              <div className="flex justify-between">
                <span>Account Status:</span>
                <span className="text-slate-200">{account?.status || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>Base Currency:</span>
                <span className="text-slate-200">{account?.currency || "USD"}</span>
              </div>
              <div className="flex justify-between">
                <span>Total Statements:</span>
                <span className="text-slate-200">{totalCount}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Transaction History & Statements */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-2">
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Transaction History
              </h2>
              <p className="text-xs text-slate-400">
                Live record of incoming and outgoing money movements.
              </p>
            </div>
            <div className="text-xs font-mono text-slate-400">
              Total Records: <span className="text-white font-semibold">{totalCount}</span>
            </div>
          </div>

          {isLoading ? (
            <div className="py-16 text-center text-sm text-slate-500">
              <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto mb-3" />
              Loading statement records...
            </div>
          ) : transactions.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">
              No transactions recorded for this account yet. Deposit funds to initiate your ledger.
            </div>
          ) : (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 uppercase font-mono tracking-wider text-[10px]">
                    <th className="py-3 px-3">Type</th>
                    <th className="py-3 px-3">Direction</th>
                    <th className="py-3 px-3">Amount</th>
                    <th className="py-3 px-3">Counterparty</th>
                    <th className="py-3 px-3">Reference</th>
                    <th className="py-3 px-3">Timestamp</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3 text-right">Ledger Proof</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-medium">
                  {transactions.map((tx) => (
                    <React.Fragment key={tx.id}>
                      <tr className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3.5 px-3">
                          <Badge
                            variant={
                              tx.type === "TRANSFER"
                                ? "info"
                                : tx.type === "DEPOSIT"
                                ? "success"
                                : "warning"
                            }
                          >
                            {tx.type}
                          </Badge>
                        </td>
                        <td className="py-3.5 px-3 font-mono">
                          <span
                            className={
                              tx.direction === "INCOMING"
                                ? "text-emerald-400"
                                : "text-amber-400"
                            }
                          >
                            {tx.direction === "INCOMING" ? "↓ IN" : "↑ OUT"}
                          </span>
                        </td>
                        <td className="py-3.5 px-3 font-mono font-semibold text-white">
                          {tx.direction === "INCOMING" ? "+" : "-"}$
                          {Number(tx.amount).toFixed(2)}
                        </td>
                        <td className="py-3.5 px-3 font-mono text-slate-400">
                          {tx.direction === "INCOMING" ? tx.fromAccount : tx.toAccount}
                        </td>
                        <td className="py-3.5 px-3 text-slate-400 truncate max-w-[180px]">
                          {tx.reference || "—"}
                        </td>
                        <td className="py-3.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                          {new Date(tx.timestamp).toLocaleString("en-US", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="py-3.5 px-3">
                          <Badge
                            variant={
                              tx.status === "COMPLETED"
                                ? "success"
                                : tx.status === "PENDING"
                                ? "warning"
                                : "danger"
                            }
                          >
                            {tx.status}
                          </Badge>
                        </td>
                        <td className="py-3.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedTxId(expandedTxId === tx.id ? null : tx.id)
                            }
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium transition-all ${
                              expandedTxId === tx.id
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/60"
                            }`}
                          >
                            <svg
                              className={`w-3.5 h-3.5 transition-transform duration-200 ${
                                expandedTxId === tx.id
                                  ? "rotate-180 text-emerald-400"
                                  : "text-slate-400"
                              }`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                            <span>
                              {expandedTxId === tx.id ? "Hide Proof" : "Inspect Proof"}
                            </span>
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Proof Viewer */}
                      {expandedTxId === tx.id && (
                        <tr className="bg-slate-900/80 border-b border-slate-800">
                          <td colSpan={8} className="p-4 sm:p-5">
                            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-4">
                              {/* Proof Header with actual Reference & Timestamp */}
                              <div className="flex flex-wrap items-center justify-between pb-3 border-b border-slate-800 gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs text-emerald-400 font-semibold">
                                    Cryptographic Proof Explorer
                                  </span>
                                  <span className="text-slate-600">|</span>
                                  <span className="font-mono text-xs text-slate-300">
                                    Tx #{tx.id}
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400">
                                  {tx.reference && (
                                    <span>
                                      Ref: <span className="text-slate-200">{tx.reference}</span>
                                    </span>
                                  )}
                                  <span>
                                    Timestamp:{" "}
                                    <span className="text-slate-200">
                                      {new Date(tx.timestamp).toLocaleString("en-US")}
                                    </span>
                                  </span>
                                </div>
                              </div>

                              {/* Proof Entries or Empty State */}
                              {!tx.ledgerProof || tx.ledgerProof.length === 0 ? (
                                <div className="py-4 text-center text-xs text-slate-500 font-mono">
                                  No cryptographic ledger proof returned for this transaction.
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  {tx.ledgerProof.map((proof) => (
                                    <div
                                      key={proof.sequenceNo}
                                      className="rounded-lg border border-slate-800/80 bg-slate-900/60 p-3.5 space-y-3"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/60 pb-2.5">
                                        <div className="flex items-center gap-2.5">
                                          <span className="text-xs font-mono font-bold text-white">
                                            Ledger Sequence #{proof.sequenceNo}
                                          </span>
                                          <Badge
                                            variant={
                                              proof.entryType === "CREDIT"
                                                ? "success"
                                                : "warning"
                                            }
                                          >
                                            {proof.entryType === "CREDIT"
                                              ? "CREDIT (+)"
                                              : "DEBIT (-)"}
                                          </Badge>
                                        </div>
                                        <div className="flex items-center gap-3 text-xs font-mono">
                                          <span className="text-slate-400">Amount:</span>
                                          <span className="text-white font-semibold">
                                            ${Number(proof.amount).toFixed(2)}
                                          </span>
                                          <span className="text-slate-600">|</span>
                                          <span className="text-slate-400">Balance After:</span>
                                          <span className="text-emerald-400 font-semibold">
                                            ${Number(proof.balanceAfter).toFixed(2)}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Hash Chain Records with Copy Buttons */}
                                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-[11px] font-mono">
                                        <div className="space-y-1">
                                          <div className="flex items-center justify-between text-slate-400">
                                            <span>Previous Hash (prevHash):</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                copyHash(
                                                  proof.prevHash,
                                                  `prev-${proof.sequenceNo}`
                                                )
                                              }
                                              className={`text-[10px] font-sans transition-colors ${
                                                hashCopyState?.key === `prev-${proof.sequenceNo}` && hashCopyState.isError
                                                  ? "text-rose-400"
                                                  : "text-emerald-400 hover:text-emerald-300"
                                              }`}
                                            >
                                              {hashCopyState?.key === `prev-${proof.sequenceNo}`
                                                ? hashCopyState.message
                                                : "Copy Full Hash"}
                                            </button>
                                          </div>
                                          <div className="rounded bg-slate-950 border border-slate-800/90 px-3 py-2 text-slate-300 break-all select-all leading-relaxed">
                                            {proof.prevHash}
                                          </div>
                                        </div>

                                        <div className="space-y-1">
                                          <div className="flex items-center justify-between text-slate-400">
                                            <span>Entry HMAC-SHA256 (entryHash):</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                copyHash(
                                                  proof.entryHash,
                                                  `entry-${proof.sequenceNo}`
                                                )
                                              }
                                              className={`text-[10px] font-sans transition-colors ${
                                                hashCopyState?.key === `entry-${proof.sequenceNo}` && hashCopyState.isError
                                                  ? "text-rose-400"
                                                  : "text-emerald-400 hover:text-emerald-300"
                                              }`}
                                            >
                                              {hashCopyState?.key === `entry-${proof.sequenceNo}`
                                                ? hashCopyState.message
                                                : "Copy Full Hash"}
                                            </button>
                                          </div>
                                          <div className="rounded bg-slate-950 border border-slate-800/90 px-3 py-2 text-emerald-300 break-all select-all leading-relaxed">
                                            {proof.entryHash}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Cryptographic Link Assurance Note */}
                              <div className="flex items-center gap-2 pt-1 text-[11px] text-slate-500 font-mono">
                                <svg
                                  className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                                <span>
                                  Cryptographically verified double-entry sequence linked to the
                                  Genesis Checkpoint.
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 mt-2 border-t border-slate-800 text-xs">
              <button
                onClick={() => fetchStatement(page - 1)}
                disabled={page <= 1}
                className="px-3.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800 transition-colors"
              >
                Previous
              </button>
              <span className="text-slate-400 font-mono">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => fetchStatement(page + 1)}
                disabled={page >= totalPages}
                className="px-3.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Financial Action Modal */}
      <Modal
        isOpen={modalType !== null}
        onClose={closeModal}
        title={
          modalType === "DEPOSIT"
            ? "Deposit Funds"
            : modalType === "WITHDRAW"
            ? "Withdraw Funds"
            : "Transfer Funds"
        }
        description={
          modalType === "DEPOSIT"
            ? "Deposit funds directly into your vault account from the Operating Treasury reserve."
            : modalType === "WITHDRAW"
            ? "Withdraw available funds from your vault account to the Operating Treasury reserve."
            : "Atomically move funds to another active BalanceVault account."
        }
      >
        <form onSubmit={handleActionSubmit} className="space-y-4">
          {actionError && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
              {actionError}
            </div>
          )}

          {actionSuccess && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-400">
              {actionSuccess}
            </div>
          )}

          {modalType === "TRANSFER" && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Recipient Account Number
              </label>
              <input
                type="text"
                required
                disabled={isSubmitting}
                value={receiverAccountInput}
                onChange={(e) => setReceiverAccountInput(e.target.value)}
                placeholder="ACC-XXXXXXXX"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white font-mono placeholder-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Amount (USD)
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={modalType === "DEPOSIT" ? 10000 : undefined}
              required
              disabled={isSubmitting}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white font-mono placeholder-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
            />
            {modalType === "DEPOSIT" && (
              <p className="mt-1 text-[11px] text-slate-400 font-mono">
                Maximum single deposit: $10,000.00
              </p>
            )}
            {modalType === "WITHDRAW" && account && (
              <p className="mt-1 text-[11px] text-slate-400 font-mono">
                Available balance: ${Number(account.balance).toFixed(2)}
              </p>
            )}
            {modalType === "TRANSFER" && account && (
              <p className="mt-1 text-[11px] text-slate-400 font-mono">
                Available balance: ${Number(account.balance).toFixed(2)}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Reference / Memo (Optional)
            </label>
            <input
              type="text"
              disabled={isSubmitting}
              value={referenceInput}
              onChange={(e) => setReferenceInput(e.target.value)}
              placeholder="e.g. Savings deposit, rent split"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeModal}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg border border-slate-700 bg-slate-800 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white shadow-sm transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                "Confirm & Execute"
              )}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
