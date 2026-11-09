import * as crypto from "crypto";
import { GENESIS_HASH } from "./constants";

export function getLedgerHmacSecret(): string {
  const secret = process.env.LEDGER_HMAC_SECRET;
  if (!secret || secret.trim() === "") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "LEDGER_HMAC_SECRET is not set. Cannot start in production without a valid HMAC secret."
      );
    }
    // Development fallback — never use in production
    return "dev-ledger-hmac-secret-hash-validation-key";
  }
  if (secret === "dev-ledger-hmac-secret-hash-validation-key") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "LEDGER_HMAC_SECRET is using the development placeholder. Set a real secret in production."
      );
    }
  }
  if (secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "LEDGER_HMAC_SECRET must be at least 32 characters in production."
      );
    }
  }
  return secret;
}

export interface LedgerHashPayload {
  prevHash: string;
  sequenceNo: number;
  accountId: string;
  entryType: "DEBIT" | "CREDIT";
  amount: string;
  balanceAfter: string;
  timestamp: string;
}

/**
 * Computes an HMAC-SHA256 hash for a ledger entry.
 * Uses a server-side HMAC secret not stored in the database.
 */
export function computeEntryHash(payload: LedgerHashPayload): string {
  const hmacSecret = getLedgerHmacSecret();
  const content = [
    payload.prevHash,
    payload.sequenceNo.toString(),
    payload.accountId,
    payload.entryType,
    payload.amount,
    payload.balanceAfter,
    payload.timestamp,
  ].join("|");

  return crypto.createHmac("sha256", hmacSecret).update(content).digest("hex");
}

/**
 * Computes a checkpoint hash anchoring a verified sequence number and entry hash.
 */
export function computeCheckpointHash(
  sequenceNo: number,
  entryHash: string,
  verifiedEntriesCount: number,
  timestamp: string
): string {
  const hmacSecret = getLedgerHmacSecret();
  const content = [
    sequenceNo.toString(),
    entryHash,
    verifiedEntriesCount.toString(),
    timestamp,
  ].join("|");

  return crypto.createHmac("sha256", hmacSecret).update(content).digest("hex");
}

