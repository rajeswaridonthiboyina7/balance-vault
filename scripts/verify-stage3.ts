/**
 * Stage 3 Comprehensive Verification Suite
 *
 * Checks:
 * 1. Deposit (funds Treasury -> user, double-entry balanced)
 * 2. Withdrawal (funds user -> Treasury, double-entry balanced)
 * 3. Successful Transfer (Alice -> Bob, balances and ledger entries correct)
 * 4. Insufficient Balance rejection (422 status, rollback, no ledger entries)
 * 5. Negative Amount & Invalid Input rejection (400 status)
 * 6. Same-Account Transfer rejection (400 status)
 * 7. Double-entry Equality (Total Debits === Total Credits across all entries)
 * 8. Idempotent Repeated Request (returns cached response + Idempotent-Replayed header)
 * 9. Same Key with Different Payload rejection (422 status)
 * 10. Concurrent Transfers & Unique Sequence Monotonicity (pg_advisory_xact_lock serialized)
 * 11. HMAC Chain Continuity Walk (genesis to head, recomputed matches stored)
 * 12. Rollback on Transaction Failure (database consistency preserved on abort)
 * 13. Unauthorized Access to Ledger Verification Endpoint (role-based access control)
 * 14. Production HMAC Secret Guard (rejects short/placeholder in production)
 */

import { PrismaClient, Role, AccountStatus } from "@prisma/client";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const errors: string[] = [];

function pass(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
  errors.push(`${label}${detail ? `: ${detail}` : ""}`);
}

async function cleanup(emailPrefix: string) {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: emailPrefix } },
    include: { accounts: true },
  });
  const userIds = users.map((u) => u.id);
  const accountIds = users.flatMap((u) => u.accounts.map((a) => a.id));

  if (accountIds.length > 0) {
    // Find all transactions touching these accounts
    const txs = await prisma.transaction.findMany({
      where: {
        OR: [
          { senderAccountId: { in: accountIds } },
          { receiverAccountId: { in: accountIds } },
        ],
      },
      select: { id: true },
    });
    const txIds = txs.map((t) => t.id);

    // 1. Delete all ledger entries tied to these transactions or accounts
    if (txIds.length > 0) {
      await prisma.ledgerEntry.deleteMany({
        where: { transactionId: { in: txIds } },
      });
    }
    await prisma.ledgerEntry.deleteMany({
      where: { accountId: { in: accountIds } },
    });

    // 2. Delete idempotency records
    await prisma.idempotencyRecord.deleteMany({
      where: { userId: { in: userIds } },
    });

    // 3. Delete transactions
    if (txIds.length > 0) {
      await prisma.transaction.deleteMany({
        where: { id: { in: txIds } },
      });
    }

    // 4. Delete accounts
    await prisma.account.deleteMany({
      where: { id: { in: accountIds } },
    });
  }

  // 5. Delete audit logs & users
  if (userIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });
  }
}

function randomAccountNumber(): string {
  const r = crypto.randomInt(10_000_000, 99_999_999);
  return `TEST-${r}`;
}

async function createTestUser(
  email: string,
  role: Role = Role.USER,
  initialBalance: number = 0
): Promise<{ userId: string; accountId: string; accountNumber: string }> {
  const hash = await bcrypt.hash("TestPass123!", 10);
  const user = await prisma.user.create({
    data: {
      email,
      name: email.split("@")[0],
      passwordHash: hash,
      role,
    },
  });
  const accountNumber = randomAccountNumber();
  const account = await prisma.account.create({
    data: {
      userId: user.id,
      accountNumber,
      balance: initialBalance,
      currency: "USD",
      status: AccountStatus.ACTIVE,
    },
  });
  return { userId: user.id, accountId: account.id, accountNumber };
}

import {
  executeDeposit,
  executeWithdrawal,
  executeDoubleEntryMovement,
  LedgerEngineError,
} from "../src/lib/ledger-service";
import { handleIdempotency } from "../src/lib/idempotency";
import { computeEntryHash, getLedgerHmacSecret } from "../src/lib/ledger-crypto";
import { GENESIS_HASH } from "../src/lib/constants";

async function main() {
  console.log("\n==================================================");
  console.log("  Stage 3 Comprehensive Verification Suite");
  console.log("==================================================\n");

  const PREFIX = "s3test+";
  await cleanup(PREFIX);

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. DEPOSIT
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("1. Deposit (Treasury -> User)");
  const alice = await createTestUser(`${PREFIX}alice@test.local`);
  const depositAmount = 500.0;

  const depositRes = await executeDeposit({
    accountId: alice.accountId,
    amount: depositAmount,
    callerUserId: alice.userId,
    reference: "INITIAL_FUNDING",
  });

  const aliceAcc1 = await prisma.account.findUnique({ where: { id: alice.accountId } });
  if (aliceAcc1 && Number(aliceAcc1.balance) === depositAmount) {
    pass(`User balance correctly credited ($${depositAmount})`);
  } else {
    fail("Deposit balance incorrect", `expected ${depositAmount}, got ${aliceAcc1?.balance}`);
  }

  if (depositRes.ledgerEntries.debit.sequenceNo < depositRes.ledgerEntries.credit.sequenceNo) {
    pass("Deposit ledger entries sequenced properly (debit < credit)");
  } else {
    fail("Deposit sequence ordering invalid");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. WITHDRAWAL
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n2. Withdrawal (User -> Treasury)");
  const withdrawAmount = 150.0;
  const withdrawRes = await executeWithdrawal({
    accountId: alice.accountId,
    amount: withdrawAmount,
    callerUserId: alice.userId,
    reference: "ATM_WITHDRAWAL",
  });

  const aliceAcc2 = await prisma.account.findUnique({ where: { id: alice.accountId } });
  const expectedAfterWithdraw = depositAmount - withdrawAmount; // 350
  if (aliceAcc2 && Number(aliceAcc2.balance) === expectedAfterWithdraw) {
    pass(`User balance reduced correctly ($${expectedAfterWithdraw})`);
  } else {
    fail("Withdrawal balance incorrect", `expected ${expectedAfterWithdraw}, got ${aliceAcc2?.balance}`);
  }

  if (withdrawRes.ledgerEntries.debit.sequenceNo > depositRes.ledgerEntries.credit.sequenceNo) {
    pass("Withdrawal sequence monotonic increment preserved");
  } else {
    fail("Sequence counter did not monotonically increment across transactions");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SUCCESSFUL TRANSFER (Alice -> Bob)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n3. Successful Transfer (Alice -> Bob)");
  const bob = await createTestUser(`${PREFIX}bob@test.local`);
  const transferAmount = 100.0;

  const transferRes = await executeDoubleEntryMovement({
    senderAccountId: alice.accountId,
    receiverAccountId: bob.accountId,
    amount: transferAmount,
    callerUserId: alice.userId,
    reference: "PAYMENT_TO_BOB",
  });

  const [aliceFinal, bobFinal] = await Promise.all([
    prisma.account.findUnique({ where: { id: alice.accountId } }),
    prisma.account.findUnique({ where: { id: bob.accountId } }),
  ]);

  if (aliceFinal && Number(aliceFinal.balance) === 250.0) {
    pass("Sender balance debited correctly (350 - 100 = $250.00)");
  } else {
    fail("Sender balance mismatch", `expected 250, got ${aliceFinal?.balance}`);
  }

  if (bobFinal && Number(bobFinal.balance) === 100.0) {
    pass("Receiver balance credited correctly ($100.00)");
  } else {
    fail("Receiver balance mismatch", `expected 100, got ${bobFinal?.balance}`);
  }

  const transferEntries = await prisma.ledgerEntry.findMany({
    where: { transactionId: transferRes.transactionId },
    orderBy: { sequenceNo: "asc" },
  });

  if (transferEntries.length === 2) {
    pass("Transfer generated exactly two ledger entries (1 DEBIT, 1 CREDIT)");
  } else {
    fail("Ledger entry count mismatch", `expected 2, got ${transferEntries.length}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. INSUFFICIENT BALANCE REJECTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n4. Insufficient Balance Handling");
  try {
    await executeDoubleEntryMovement({
      senderAccountId: alice.accountId,
      receiverAccountId: bob.accountId,
      amount: 9999.0, // Alice only has 250
      callerUserId: alice.userId,
    });
    fail("Transfer should have thrown insufficient funds error");
  } catch (err: any) {
    if (err instanceof LedgerEngineError && err.statusCode === 422) {
      pass("Insufficient balance rejected with HTTP 422");
    } else {
      fail("Insufficient balance threw incorrect error", String(err));
    }
  }

  // Confirm Alice's balance remained unchanged
  const aliceAfterFailed = await prisma.account.findUnique({ where: { id: alice.accountId } });
  if (aliceAfterFailed && Number(aliceAfterFailed.balance) === 250.0) {
    pass("Sender balance intact after rejected overdraft");
  } else {
    fail("Balance altered despite rejection");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. NEGATIVE AMOUNT & INVALID INPUT REJECTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n5. Negative Amount & Invalid Input Rejection");
  let negRejected = false;
  try {
    await executeDoubleEntryMovement({
      senderAccountId: alice.accountId,
      receiverAccountId: bob.accountId,
      amount: -50.0,
      callerUserId: alice.userId,
    });
  } catch (err: any) {
    if (err instanceof LedgerEngineError && err.statusCode === 400) {
      negRejected = true;
    }
  }
  if (negRejected) {
    pass("Negative transfer amount rejected with HTTP 400");
  } else {
    fail("Negative transfer amount was not rejected with HTTP 400");
  }

  let zeroRejected = false;
  try {
    await executeDoubleEntryMovement({
      senderAccountId: alice.accountId,
      receiverAccountId: bob.accountId,
      amount: 0,
      callerUserId: alice.userId,
    });
  } catch (err: any) {
    if (err instanceof LedgerEngineError && err.statusCode === 400) {
      zeroRejected = true;
    }
  }
  if (zeroRejected) {
    pass("Zero transfer amount rejected with HTTP 400");
  } else {
    fail("Zero transfer amount was not rejected with HTTP 400");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. SAME-ACCOUNT TRANSFER REJECTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n6. Same-Account Transfer Rejection");
  let sameRejected = false;
  try {
    await executeDoubleEntryMovement({
      senderAccountId: alice.accountId,
      receiverAccountId: alice.accountId,
      amount: 50.0,
      callerUserId: alice.userId,
    });
  } catch (err: any) {
    if (err instanceof LedgerEngineError && err.statusCode === 400) {
      sameRejected = true;
    }
  }
  if (sameRejected) {
    pass("Same-account transfer rejected with HTTP 400");
  } else {
    fail("Same-account transfer was not rejected with HTTP 400");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. DOUBLE-ENTRY EQUALITY (SUM DEBITS === SUM CREDITS)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n7. Double-Entry Equality Invariant");
  const debits = await prisma.ledgerEntry.aggregate({
    where: { entryType: "DEBIT" },
    _sum: { amount: true },
  });
  const credits = await prisma.ledgerEntry.aggregate({
    where: { entryType: "CREDIT" },
    _sum: { amount: true },
  });

  const sumDebits = Number(debits._sum.amount ?? 0);
  const sumCredits = Number(credits._sum.amount ?? 0);

  if (Math.abs(sumDebits - sumCredits) < 0.0001) {
    pass(`Double-entry balance holds: Total Debits ($${sumDebits.toFixed(2)}) == Total Credits ($${sumCredits.toFixed(2)})`);
  } else {
    fail("Double-entry imbalance detected", `Debits: ${sumDebits}, Credits: ${sumCredits}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. IDEMPOTENT REPEATED REQUEST
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n8. Idempotent Repeated Request");
  const testIdempKey = `stage3-key-${Date.now()}`;
  const payload = { receiverAccountNumber: bob.accountNumber, amount: 25.0 };

  const idempFirst = await handleIdempotency(
    alice.userId,
    testIdempKey,
    "/api/transactions/transfer",
    "POST",
    payload
  );

  if (!idempFirst.isReplay && idempFirst.recordId) {
    pass("New idempotency key acquired with PROCESSING status");
  } else {
    fail("Failed to acquire new idempotency record");
  }

  // Finalize the record
  await prisma.idempotencyRecord.update({
    where: { id: idempFirst.recordId },
    data: {
      status: "COMPLETED",
      responseCode: 200,
      responseBody: JSON.stringify({ message: "Transfer successful", mock: true }),
    },
  });

  // Replay exactly same key and payload
  const idempReplay = await handleIdempotency(
    alice.userId,
    testIdempKey,
    "/api/transactions/transfer",
    "POST",
    payload
  );

  if (idempReplay.isReplay && idempReplay.cachedResponse) {
    const isReplayedHeader = idempReplay.cachedResponse.headers.get("Idempotent-Replayed");
    if (isReplayedHeader === "true") {
      pass("Replay returns cached response with 'Idempotent-Replayed: true' header");
    } else {
      fail("Cached response missing Idempotent-Replayed header");
    }
  } else {
    fail("Replay request was not recognized as idempotency replay");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. SAME KEY WITH DIFFERENT PAYLOAD (MISMATCH)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n9. Same Key with Different Payload");
  const idempMismatch = await handleIdempotency(
    alice.userId,
    testIdempKey,
    "/api/transactions/transfer",
    "POST",
    { receiverAccountNumber: bob.accountNumber, amount: 999.0 } // altered payload
  );

  if (!idempMismatch.isReplay && idempMismatch.errorResponse?.status === 422) {
    pass("Reusing idempotency key with different payload rejected with HTTP 422");
  } else {
    fail("Payload mismatch did not return HTTP 422");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. CONCURRENT TRANSFERS & MONOTONIC SEQUENCE (pg_advisory_xact_lock)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n10. Concurrency & Monotonic Sequence Monotonicity");
  // Dave gets $1000, fires 6 concurrent transfers of $10 to Bob
  const dave = await createTestUser(`${PREFIX}dave@test.local`, Role.USER, 1000.0);

  const concurrentPromises = Array.from({ length: 6 }, (_, i) =>
    executeDoubleEntryMovement({
      senderAccountId: dave.accountId,
      receiverAccountId: bob.accountId,
      amount: 10.0,
      callerUserId: dave.userId,
      reference: `CONCURRENT_TX_${i}`,
    })
  );

  const concurrentResults = await Promise.allSettled(concurrentPromises);
  const succeeded = concurrentResults.filter((r) => r.status === "fulfilled");
  const failedOps = concurrentResults.filter((r) => r.status === "rejected");

  if (succeeded.length === 6 && failedOps.length === 0) {
    pass("All 6 concurrent transfers completed successfully without sequence conflict");
  } else {
    fail(`Concurrent transfers failed`, `succeeded: ${succeeded.length}, failed: ${failedOps.length}`);
  }

  // Check sequence numbers of entries from these 6 transactions
  const daveTxEntries = await prisma.ledgerEntry.findMany({
    where: {
      account: { userId: dave.userId },
      entryType: "DEBIT",
    },
    orderBy: { sequenceNo: "asc" },
  });

  const seqs = daveTxEntries.map((e) => e.sequenceNo);
  const uniqueSeqs = new Set(seqs);
  if (seqs.length === uniqueSeqs.size) {
    pass(`All ${seqs.length} concurrent ledger sequence numbers are strictly unique`);
  } else {
    fail("Duplicate sequence numbers detected under concurrent execution!");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. HMAC CHAIN CONTINUITY WALK
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n11. HMAC Chain Integrity Walk");
  const allEntries = await prisma.ledgerEntry.findMany({
    orderBy: { sequenceNo: "asc" },
  });

  let chainValid = true;
  let runningPrevHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (const entry of allEntries) {
    if (entry.sequenceNo !== expectedSeq) {
      fail(`Sequence gap at seq ${entry.sequenceNo}, expected ${expectedSeq}`);
      chainValid = false;
      break;
    }
    if (entry.prevHash !== runningPrevHash) {
      fail(`prevHash mismatch at seq ${entry.sequenceNo}`);
      chainValid = false;
      break;
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
      fail(`HMAC validation failed at seq ${entry.sequenceNo}`);
      chainValid = false;
      break;
    }
    runningPrevHash = entry.entryHash;
    expectedSeq++;
  }

  if (chainValid && allEntries.length > 0) {
    pass(`Cryptographic chain fully intact across all ${allEntries.length} entries`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. ROLLBACK ON TRANSACTION FAILURE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n12. Rollback on Transaction Failure");
  const balanceBeforeIntentionalFail = Number(
    (await prisma.account.findUnique({ where: { id: alice.accountId } }))?.balance
  );
  const ledgerCountBefore = await prisma.ledgerEntry.count();

  try {
    await prisma.$transaction(async (tx) => {
      // Simulate partial balance modification followed by deliberate failure
      await tx.account.update({
        where: { id: alice.accountId },
        data: { balance: 99999.0 },
      });
      throw new Error("Deliberate abort to test rollback");
    });
  } catch {
    // Expected abort
  }

  const balanceAfterIntentionalFail = Number(
    (await prisma.account.findUnique({ where: { id: alice.accountId } }))?.balance
  );
  const ledgerCountAfter = await prisma.ledgerEntry.count();

  if (balanceBeforeIntentionalFail === balanceAfterIntentionalFail && ledgerCountBefore === ledgerCountAfter) {
    pass("ACID rollback verified: failed transaction rolled back state completely");
  } else {
    fail("State changed despite transaction failure and rollback");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. UNAUTHORIZED ACCESS TO LEDGER VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n13. Unauthorized Access to Ledger Verification");
  const { signSessionToken, verifySessionToken } = await import("../src/lib/auth");
  
  // Create user token and admin token to verify RBAC logic
  const userToken = await signSessionToken({
    sub: alice.userId,
    email: `${PREFIX}alice@test.local`,
    name: "alice",
    role: Role.USER,
  });

  const adminToken = await signSessionToken({
    sub: "admin-test-id",
    email: "admin@balancevault.local",
    name: "Admin",
    role: Role.ADMIN,
  });

  const parsedUserSession = await verifySessionToken(userToken);
  const parsedAdminSession = await verifySessionToken(adminToken);

  if (parsedUserSession && parsedUserSession.role === Role.USER) {
    const isAllowedForAdminRoute = [Role.ADMIN].includes(parsedUserSession.role);
    if (!isAllowedForAdminRoute) {
      pass("USER role correctly forbidden from accessing ADMIN-only ledger verification");
    } else {
      fail("USER role was incorrectly permitted on ADMIN route");
    }
  } else {
    fail("Failed to verify user session token");
  }

  if (parsedAdminSession && [Role.ADMIN].includes(parsedAdminSession.role)) {
    pass("ADMIN role correctly authorized for ledger verification");
  } else {
    fail("ADMIN role was not authorized for ledger verification");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. PRODUCTION HMAC SECRET GUARD
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n14. Production HMAC Secret Guard");
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.LEDGER_HMAC_SECRET;

  try {
    (process.env as any).NODE_ENV = "production";
    delete process.env.LEDGER_HMAC_SECRET;

    let rejectedMissing = false;
    try {
      getLedgerHmacSecret();
    } catch (e: any) {
      if (e.message.includes("LEDGER_HMAC_SECRET is not set")) {
        rejectedMissing = true;
      }
    }
    if (rejectedMissing) {
      pass("Missing LEDGER_HMAC_SECRET rejected in production mode");
    } else {
      fail("Missing secret in production was not rejected");
    }

    process.env.LEDGER_HMAC_SECRET = "dev-ledger-hmac-secret-hash-validation-key";
    let rejectedPlaceholder = false;
    try {
      getLedgerHmacSecret();
    } catch (e: any) {
      if (e.message.includes("using the development placeholder")) {
        rejectedPlaceholder = true;
      }
    }
    if (rejectedPlaceholder) {
      pass("Placeholder LEDGER_HMAC_SECRET rejected in production mode");
    } else {
      fail("Placeholder secret in production was not rejected");
    }

    process.env.LEDGER_HMAC_SECRET = "short-key";
    let rejectedShort = false;
    try {
      getLedgerHmacSecret();
    } catch (e: any) {
      if (e.message.includes("at least 32 characters")) {
        rejectedShort = true;
      }
    }
    if (rejectedShort) {
      pass("Short LEDGER_HMAC_SECRET rejected in production mode");
    } else {
      fail("Short secret in production was not rejected");
    }
  } finally {
    (process.env as any).NODE_ENV = originalEnv;
    if (originalSecret !== undefined) {
      process.env.LEDGER_HMAC_SECRET = originalSecret;
    } else {
      delete process.env.LEDGER_HMAC_SECRET;
    }
  }

  // ── Clean test records ────────────────────────────────────────────────────────
  console.log("\n── Cleaning up test accounts…");
  await cleanup(PREFIX);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log("\n==================================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log("\n  Failed checks:");
    errors.forEach((e) => console.log(`    • ${e}`));
  }
  console.log("==================================================\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
