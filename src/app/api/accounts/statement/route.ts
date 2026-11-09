import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const session = auth.session;

  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20", 10));
    const skip = (page - 1) * limit;

    // Fetch user's accounts
    const accounts = await prisma.account.findMany({
      where: { userId: session.sub },
      select: {
        id: true,
        accountNumber: true,
        balance: true,
        currency: true,
        status: true,
      },
    });

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: "No accounts found" },
        { status: 404 }
      );
    }

    const accountIds = accounts.map((a) => a.id);

    // Fetch transactions involving user's accounts
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          OR: [
            { senderAccountId: { in: accountIds } },
            { receiverAccountId: { in: accountIds } },
          ],
        },
        include: {
          senderAccount: {
            select: { accountNumber: true, userId: true },
          },
          receiverAccount: {
            select: { accountNumber: true, userId: true },
          },
          ledgerEntries: {
            where: { accountId: { in: accountIds } },
            select: {
              sequenceNo: true,
              entryType: true,
              amount: true,
              balanceAfter: true,
              prevHash: true,
              entryHash: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
      }),
      prisma.transaction.count({
        where: {
          OR: [
            { senderAccountId: { in: accountIds } },
            { receiverAccountId: { in: accountIds } },
          ],
        },
      }),
    ]);

    return NextResponse.json({
      accounts,
      statement: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        transactions: transactions.map((tx) => ({
          id: tx.id,
          type: tx.type,
          status: tx.status,
          amount: tx.amount,
          currency: tx.currency,
          direction:
            accountIds.includes(tx.senderAccountId) ? "OUTGOING" : "INCOMING",
          fromAccount: tx.senderAccount.accountNumber,
          toAccount: tx.receiverAccount.accountNumber,
          reference: tx.reference,
          timestamp: tx.createdAt,
          ledgerProof: tx.ledgerEntries,
        })),
      },
    });
  } catch (err) {
    console.error("Statement error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

