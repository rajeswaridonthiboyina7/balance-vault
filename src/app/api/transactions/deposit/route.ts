import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  handleIdempotency,
  finalizeIdempotency,
  releaseIdempotencyOnFailure,
} from "@/lib/idempotency";
import { executeDeposit, LedgerEngineError } from "@/lib/ledger-service";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const session = auth.session;

  try {
    const body = await req.json();
    const { amount, reference } = body;
    const idempotencyKey = req.headers.get("idempotency-key") || undefined;

    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive number" },
        { status: 400 }
      );
    }

    if (parsedAmount > 10000) {
      return NextResponse.json(
        { error: "Single deposit limit is $10,000.00" },
        { status: 422 }
      );
    }

    const account = await prisma.account.findFirst({
      where: { userId: session.sub, status: "ACTIVE" },
    });

    if (!account) {
      return NextResponse.json(
        { error: "No active account found" },
        { status: 404 }
      );
    }

    let idempotencyRecordId: string | undefined;
    if (idempotencyKey) {
      const idempResult = await handleIdempotency(
        session.sub,
        idempotencyKey,
        "/api/transactions/deposit",
        "POST",
        { amount: parsedAmount, reference }
      );
      if (idempResult.cachedResponse) return idempResult.cachedResponse;
      if (idempResult.errorResponse) return idempResult.errorResponse;
      idempotencyRecordId = idempResult.recordId;
    }

    let result;
    try {
      result = await executeDeposit({
        accountId: account.id,
        amount: parsedAmount,
        callerUserId: session.sub,
        reference: reference || "DEPOSIT",
        idempotencyKey,
      });
    } catch (err) {
      if (idempotencyRecordId) {
        await releaseIdempotencyOnFailure(idempotencyRecordId);
      }
      throw err;
    }

    const responseBody = {
      message: "Deposit completed successfully",
      transaction: result,
    };

    if (idempotencyRecordId) {
      await finalizeIdempotency(idempotencyRecordId, 200, responseBody);
    }

    return NextResponse.json(responseBody);
  } catch (err) {
    if (err instanceof LedgerEngineError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode }
      );
    }
    console.error("Deposit error:", err);
    return NextResponse.json(
      { error: "Internal server error during deposit" },
      { status: 500 }
    );
  }
}

