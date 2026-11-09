import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeEntryHash, computeCheckpointHash } from "@/lib/ledger-crypto";
import { GENESIS_HASH } from "@/lib/constants";
import { Role } from "@prisma/client";

/**
 * GET /api/admin/checkpoints
 * Lists all recorded checkpoints in chronological/sequence order.
 */
export async function GET() {
  const auth = await requireRole([Role.ADMIN]);
  if (auth.response) return auth.response;

  try {
    const checkpoints = await prisma.ledgerCheckpoint.findMany({
      orderBy: { sequenceNo: "desc" },
    });

    return NextResponse.json({
      total: checkpoints.length,
      checkpoints,
    });
  } catch (err) {
    console.error("List checkpoints error:", err);
    return NextResponse.json(
      { error: "Internal server error fetching checkpoints" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/checkpoints
 * Verifies the ledger hash chain up to the tip and creates a new cryptographic checkpoint.
 *
 * Guarantees:
 * 1. Concurrency-Safe: Uses `pg_advisory_xact_lock(hashtext('global_ledger_sequence'))`
 *    so no concurrent financial transaction can append or alter entries while the chain is verified and checkpointed.
 * 2. Pre-verification: Every entry from sequence 1 up to the current tip is verified (continuity & HMAC).
 * 3. Atomicity: Checkpoint record and AuditLog are written within the same transaction.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole([Role.ADMIN]);
  if (auth.response) return auth.response;
  const session = auth.session;

  try {
    const checkpointResult = await prisma.$transaction(
      async (tx) => {
        // 1. Acquire global ledger advisory lock held until transaction commits
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext('global_ledger_sequence'))`
        );

        // 2. Fetch all entries ordered by sequence number
        const entries = await tx.ledgerEntry.findMany({
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
          throw new Error("Cannot create checkpoint on an empty ledger.");
        }

        // 3. Verify complete chain integrity from sequence 1 to tip
        let expectedPrevHash = GENESIS_HASH;
        let expectedSeq = 1;

        for (const entry of entries) {
          if (entry.sequenceNo !== expectedSeq) {
            throw new Error(
              `Ledger sequence gap detected: expected ${expectedSeq}, got ${entry.sequenceNo}. Checkpoint aborted.`
            );
          }

          if (entry.prevHash !== expectedPrevHash) {
            throw new Error(
              `Ledger prevHash mismatch at sequence ${entry.sequenceNo}. Checkpoint aborted.`
            );
          }

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
            throw new Error(
              `Ledger HMAC mismatch at sequence ${entry.sequenceNo}. Ledger may have been tampered with. Checkpoint aborted.`
            );
          }

          expectedPrevHash = entry.entryHash;
          expectedSeq += 1;
        }

        // 4. Get the chain tip
        const lastEntry = entries[entries.length - 1];

        // Check if a checkpoint already exists for this exact sequence
        const existingCheckpoint = await tx.ledgerCheckpoint.findUnique({
          where: { sequenceNo: lastEntry.sequenceNo },
        });

        if (existingCheckpoint) {
          return {
            alreadyExists: true,
            checkpoint: existingCheckpoint,
          };
        }

        // 5. Compute cryptographic checkpoint hash
        const nowIso = new Date().toISOString();
        const checkpointHash = computeCheckpointHash(
          lastEntry.sequenceNo,
          lastEntry.entryHash,
          entries.length,
          nowIso
        );

        // 6. Create the checkpoint record
        const createdCheckpoint = await tx.ledgerCheckpoint.create({
          data: {
            sequenceNo: lastEntry.sequenceNo,
            entryHash: lastEntry.entryHash,
            checkpointHash,
            verifiedEntriesCount: entries.length,
          },
        });

        // 7. Atomic AuditLog creation
        await tx.auditLog.create({
          data: {
            actorId: session.sub,
            action: "CHECKPOINT_CREATED",
            entity: "LEDGER_CHECKPOINT",
            entityId: createdCheckpoint.id,
            details: `Created ledger checkpoint at sequence ${lastEntry.sequenceNo} anchoring ${entries.length} verified entries. Hash: ${checkpointHash.substring(0, 16)}...`,
          },
        });

        return {
          alreadyExists: false,
          checkpoint: createdCheckpoint,
        };
      },
      {
        maxWait: 5000,
        timeout: 15000,
      }
    );

    if (checkpointResult.alreadyExists) {
      return NextResponse.json(
        {
          message: "Checkpoint already exists for current chain tip.",
          checkpoint: checkpointResult.checkpoint,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        message: "Cryptographic checkpoint created successfully.",
        checkpoint: checkpointResult.checkpoint,
      },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("Create checkpoint error:", err);
    const message = err.message || "Failed to create checkpoint";
    const statusCode = message.includes("aborted") || message.includes("tampered") ? 422 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}

