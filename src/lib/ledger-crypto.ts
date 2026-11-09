import * as crypto from "crypto";
import { GENESIS_HASH } from "./constants";

const HMAC_SECRET =
  process.env.LEDGER_HMAC_SECRET ||
  "dev-ledger-hmac-secret-hash-validation-key";

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
  const content = [
    payload.prevHash,
    payload.sequenceNo.toString(),
    payload.accountId,
    payload.entryType,
    payload.amount,
    payload.balanceAfter,
    payload.timestamp,
  ].join("|");

  return crypto.createHmac("sha256", HMAC_SECRET).update(content).digest("hex");
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
  const content = [
    sequenceNo.toString(),
    entryHash,
    verifiedEntriesCount.toString(),
    timestamp,
  ].join("|");

  return crypto.createHmac("sha256", HMAC_SECRET).update(content).digest("hex");
}

