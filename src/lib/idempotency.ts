import * as crypto from "crypto";
import { prisma } from "./prisma";
import { NextResponse } from "next/server";

export interface IdempotencyCheckResult {
  isReplay: boolean;
  cachedResponse?: NextResponse;
  recordId?: string;
  errorResponse?: NextResponse;
}

/**
 * Computes SHA-256 hash of endpoint, method, and request payload
 */
export function computeRequestHash(
  endpoint: string,
  method: string,
  payload: any
): string {
  const content = `${method.toUpperCase()}:${endpoint}:${JSON.stringify(
    payload ?? {}
  )}`;
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Evaluates an idempotency key for a given user and payload.
 *
 * Scenarios:
 * 1. New key: Creates record with status "PROCESSING".
 * 2. Key exists with identical payload & COMPLETED status: Returns cached response.
 * 3. Key exists with identical payload & PROCESSING status: Returns 409 Conflict (in flight).
 * 4. Key exists with different payload: Returns 422 Unprocessable Entity (mismatch).
 */
export async function handleIdempotency(
  userId: string,
  key: string,
  endpoint: string,
  method: string,
  payload: any
): Promise<IdempotencyCheckResult> {
  const requestHash = computeRequestHash(endpoint, method, payload);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h retention

  return prisma.$transaction(async (tx) => {
    const existing = await tx.idempotencyRecord.findUnique({
      where: {
        userId_key: {
          userId,
          key,
        },
      },
    });

    if (existing) {
      // Scenario 4: Key reuse with different payload
      if (existing.requestHash !== requestHash) {
        return {
          isReplay: false,
          errorResponse: NextResponse.json(
            {
              error:
                "Idempotency key conflict: This key was already used with a different request payload.",
            },
            { status: 422 }
          ),
        };
      }

      // Scenario 3: Request still in flight
      if (existing.status === "PROCESSING") {
        return {
          isReplay: false,
          errorResponse: NextResponse.json(
            {
              error:
                "A transaction with this idempotency key is currently processing. Please wait.",
            },
            { status: 409 }
          ),
        };
      }

      // Scenario 2: Successful previous request replay
      if (existing.status === "COMPLETED" && existing.responseBody) {
        const body = JSON.parse(existing.responseBody);
        const headers = new Headers();
        headers.set("Idempotent-Replayed", "true");
        headers.set("Content-Type", "application/json");

        return {
          isReplay: true,
          cachedResponse: new NextResponse(JSON.stringify(body), {
            status: existing.responseCode || 200,
            headers,
          }),
        };
      }
    }

    // Scenario 1: New request - claim idempotency key
    const created = await tx.idempotencyRecord.create({
      data: {
        userId,
        key,
        requestHash,
        status: "PROCESSING",
        expiresAt,
      },
    });

    return {
      isReplay: false,
      recordId: created.id,
    };
  });
}

/**
 * Saves completed transaction response to the claimed idempotency record
 */
export async function finalizeIdempotency(
  recordId: string,
  responseCode: number,
  responseBody: any
): Promise<void> {
  try {
    await prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        status: "COMPLETED",
        responseCode,
        responseBody: JSON.stringify(responseBody),
      },
    });
  } catch (err) {
    console.error("Failed to finalize idempotency record:", err);
  }
}

/**
 * Marks idempotency record as failed or deletes it if the transaction aborted
 */
export async function releaseIdempotencyOnFailure(
  recordId: string
): Promise<void> {
  try {
    await prisma.idempotencyRecord.delete({
      where: { id: recordId },
    });
  } catch {
    // Record might already be gone
  }
}

