import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeEntryHash } from "@/lib/ledger-crypto";
import { GENESIS_HASH } from "@/lib/constants";
import { Role } from "@prisma/client";

/**
 * POST and GET /api/ledger/verify
 * ADMIN-only endpoint that walks every ledger entry in sequence order,
 * recomputes each HMAC and verifies the prevHash -> entryHash chain.
 *
 * Supports both POST and GET.
 */
async function handleLedgerVerification() {
  const auth = await requireRole([Role.ADMIN]);
  if (auth.response) return auth.response;

  try {
    // Fetch all entries ordered by sequence — no limit so we walk the full chain
    const entries = await prisma.ledgerEntry.findMany({
      orderBy: { sequenceNo: "asc" },
      select: {
        sequenceNo: true,
        accountId: true,
        entryType: true,
        amount: true,
        balanceAfter: true,
        prevHash: true,
        entryHash: true,
        createdAt: true,
      },
    });

    if (entries.length === 0) {
      return NextResponse.json({
        intact: true,
        verifiedCount: 0,
        totalEntries: 0,
        firstInvalidSequence: null,
        brokenReason: null,
        message: "Ledger is empty.",
      });
    }

    let expectedPrevHash = GENESIS_HASH;
    let expectedNextSeq = 1;
    let verifiedCount = 0;

    for (const entry of entries) {
      // 1. Check sequence monotonicity (no gaps)
      if (entry.sequenceNo !== expectedNextSeq) {
        return NextResponse.json({
          intact: false,
          verifiedCount,
          totalEntries: entries.length,
          firstInvalidSequence: entry.sequenceNo,
          brokenReason: `Sequence gap: expected seq ${expectedNextSeq}, found ${entry.sequenceNo}.`,
        });
      }

      // 2. Verify stored prevHash matches what we expected from the previous entry
      if (entry.prevHash !== expectedPrevHash) {
        return NextResponse.json({
          intact: false,
          verifiedCount,
          totalEntries: entries.length,
          firstInvalidSequence: entry.sequenceNo,
          brokenReason: `prevHash mismatch at seq ${entry.sequenceNo}: stored prevHash does not match previous entry's entryHash.`,
        });
      }

      // 3. Recompute the HMAC and compare
      const recomputed = computeEntryHash({
        prevHash: entry.prevHash,
        sequenceNo: entry.sequenceNo,
        accountId: entry.accountId,
        entryType: entry.entryType as "DEBIT" | "CREDIT",
        amount: Number(entry.amount).toFixed(4),
        balanceAfter: Number(entry.balanceAfter).toFixed(4),
        timestamp: entry.createdAt.toISOString(),
      });

      if (recomputed !== entry.entryHash) {
        return NextResponse.json({
          intact: false,
          verifiedCount,
          totalEntries: entries.length,
          firstInvalidSequence: entry.sequenceNo,
          brokenReason: `HMAC mismatch at seq ${entry.sequenceNo}: stored hash does not match recomputed hash. The entry may have been tampered with.`,
        });
      }

      expectedPrevHash = entry.entryHash;
      expectedNextSeq += 1;
      verifiedCount += 1;
    }

    // 4. Verify checkpoint consistency
    const checkpoint = await prisma.ledgerCheckpoint.findFirst({
      orderBy: { sequenceNo: "desc" },
    });

    const lastEntry = entries[entries.length - 1];

    return NextResponse.json({
      intact: true,
      verifiedCount,
      totalEntries: entries.length,
      firstInvalidSequence: null,
      brokenReason: null,
      chainTip: {
        sequenceNo: lastEntry.sequenceNo,
        entryHash: lastEntry.entryHash,
      },
      latestCheckpoint: checkpoint
        ? {
            sequenceNo: checkpoint.sequenceNo,
            checkpointHash: checkpoint.checkpointHash,
            verifiedAt: checkpoint.createdAt,
          }
        : null,
    });
  } catch (err) {
    console.error("Ledger verify error:", err);
    return NextResponse.json(
      { error: "Internal server error during ledger verification" },
      { status: 500 }
    );
  }
}

export async function POST() {
  return handleLedgerVerification();
}

export async function GET() {
  return handleLedgerVerification();
}

