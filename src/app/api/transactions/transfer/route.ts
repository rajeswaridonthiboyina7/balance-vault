import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  handleIdempotency,
  finalizeIdempotency,
  releaseIdempotencyOnFailure,
} from "@/lib/idempotency";
import {
  executeDoubleEntryMovement,
  LedgerEngineError,
} from "@/lib/ledger-service";
import { TransactionType } from "@prisma/client";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const session = auth.session;

  try {
    const body = await req.json();
    const { receiverAccountNumber, amount, reference } = body;
    const idempotencyKey = req.headers.get("idempotency-key") || undefined;

    // Validation
    if (!receiverAccountNumber || typeof receiverAccountNumber !== "string") {
      return NextResponse.json(
        { error: "receiverAccountNumber is required" },
        { status: 400 }
      );
    }

    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive number" },
        { status: 400 }
      );
    }

    // Resolve sender account owned by caller
    const senderAccount = await prisma.account.findFirst({
      where: { userId: session.sub, status: "ACTIVE" },
    });

    if (!senderAccount) {
      return NextResponse.json(
        { error: "No active account found for authenticated user" },
        { status: 404 }
      );
    }

    // Resolve receiver account
    const receiverAccount = await prisma.account.findUnique({
      where: { accountNumber: receiverAccountNumber.trim() },
    });

    if (!receiverAccount) {
      return NextResponse.json(
        { error: "Receiver account not found" },
        { status: 404 }
      );
    }

    // Handle idempotency
    let idempotencyRecordId: string | undefined;
    if (idempotencyKey) {
      const payload = {
        receiverAccountNumber,
        amount: parsedAmount,
        reference,
      };
      const idempResult = await handleIdempotency(
        session.sub,
        idempotencyKey,
        "/api/transactions/transfer",
        "POST",
        payload
      );

      if (idempResult.cachedResponse) return idempResult.cachedResponse;
      if (idempResult.errorResponse) return idempResult.errorResponse;
      idempotencyRecordId = idempResult.recordId;
    }

    let result;
    try {
      result = await executeDoubleEntryMovement({
        senderAccountId: senderAccount.id,
        receiverAccountId: receiverAccount.id,
        amount: parsedAmount,
        type: TransactionType.TRANSFER,
        reference: reference || undefined,
        callerUserId: session.sub,
        idempotencyKey,
      });
    } catch (err) {
      if (idempotencyRecordId) {
        await releaseIdempotencyOnFailure(idempotencyRecordId);
      }
      throw err;
    }

    const responseBody = {
      message: "Transfer completed successfully",
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
    console.error("Transfer error:", err);
    return NextResponse.json(
      { error: "Internal server error during transfer" },
      { status: 500 }
    );
  }
}

