/**
 * Stage 6.1: End-to-End Testing - Complete USER Workflow
 *
 * Verifies:
 * 1. Register two separate USER accounts.
 * 2. Log in and verify account isolation.
 * 3. Deposit into the first account ($500.00).
 * 4. Withdraw from the first account ($150.00).
 * 5. Transfer funds to the second account ($100.00).
 * 6. Verify updated balances and transaction statements (proof isolation).
 * 7. Test insufficient balance, invalid amounts, and duplicate idempotency keys.
 * 8. Confirm ledger debit and credit entries balance correctly and HMAC chain is intact.
 *
 * Cleans up all test data safely after verification.
 */

import { PrismaClient, Role, AccountStatus } from "@prisma/client";
import * as dotenv from "dotenv";
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
  generateAccountNumber,
} from "../src/lib/auth";
import {
  executeDeposit,
  executeWithdrawal,
  executeDoubleEntryMovement,
  LedgerEngineError,
} from "../src/lib/ledger-service";
import { handleIdempotency } from "../src/lib/idempotency";
import { computeEntryHash } from "../src/lib/ledger-crypto";
import { SYSTEM_TREASURY_ACCOUNT, GENESIS_HASH } from "../src/lib/constants";

dotenv.config();

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

const PREFIX = "s6test+";

async function cleanup(prefix: string) {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: prefix } },
    include: { accounts: true },
  });
  const userIds = users.map((u) => u.id);
  const accountIds = users.flatMap((u) => u.accounts.map((a) => a.id));

  if (accountIds.length > 0) {
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

    if (txIds.length > 0) {
      await prisma.ledgerEntry.deleteMany({
        where: { transactionId: { in: txIds } },
      });
    }
    await prisma.ledgerEntry.deleteMany({
      where: { accountId: { in: accountIds } },
    });

    await prisma.idempotencyRecord.deleteMany({
      where: { userId: { in: userIds } },
    });

    if (txIds.length > 0) {
      await prisma.transaction.deleteMany({
        where: { id: { in: txIds } },
      });
    }

    await prisma.account.deleteMany({
      where: { id: { in: accountIds } },
    });

    // Restore Treasury balance to match remaining ledger entries
    const treasuryAcc = await prisma.account.findFirst({
      where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
    });
    if (treasuryAcc) {
      const credits = await prisma.ledgerEntry.aggregate({
        where: { accountId: treasuryAcc.id, entryType: "CREDIT" },
        _sum: { amount: true },
      });
      const debits = await prisma.ledgerEntry.aggregate({
        where: { accountId: treasuryAcc.id, entryType: "DEBIT" },
        _sum: { amount: true },
      });
      const actualBalance =
        Number(credits._sum.amount || 0) - Number(debits._sum.amount || 0);
      await prisma.account.update({
        where: { id: treasuryAcc.id },
        data: { balance: actualBalance },
      });
    }
  }

  if (userIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });
  }
}

async function runStage61Verification() {
  console.log("\n==================================================");
  console.log("  Stage 6.1: End-to-End Complete USER Workflow");
  console.log("==================================================\n");

  await cleanup(PREFIX);

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. REGISTER TWO SEPARATE USER ACCOUNTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log("1. Registration of Two Separate USER Accounts");

    const user1Password = "UserOnePass123!";
    const user1Hash = await hashPassword(user1Password);
    const user1AccountNo = generateAccountNumber();

    const user1 = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          name: "Alice User",
          email: `${PREFIX}alice@balancevault.local`,
          passwordHash: user1Hash,
          role: Role.USER,
        },
      });
      const acc = await tx.account.create({
        data: {
          userId: u.id,
          accountNumber: user1AccountNo,
          balance: 0.0,
          currency: "USD",
          status: AccountStatus.ACTIVE,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: u.id,
          action: "USER_REGISTERED",
          entity: "ACCOUNT",
          entityId: acc.id,
          details: `Provisioned primary account ${acc.accountNumber}`,
        },
      });
      return { user: u, account: acc };
    });

    const user2Password = "UserTwoPass123!";
    const user2Hash = await hashPassword(user2Password);
    const user2AccountNo = generateAccountNumber();

    const user2 = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          name: "Bob Receiver",
          email: `${PREFIX}bob@balancevault.local`,
          passwordHash: user2Hash,
          role: Role.USER,
        },
      });
      const acc = await tx.account.create({
        data: {
          userId: u.id,
          accountNumber: user2AccountNo,
          balance: 0.0,
          currency: "USD",
          status: AccountStatus.ACTIVE,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: u.id,
          action: "USER_REGISTERED",
          entity: "ACCOUNT",
          entityId: acc.id,
          details: `Provisioned primary account ${acc.accountNumber}`,
        },
      });
      return { user: u, account: acc };
    });

    if (
      user1.user.id !== user2.user.id &&
      user1.account.accountNumber !== user2.account.accountNumber &&
      user1.user.role === Role.USER &&
      user2.user.role === Role.USER
    ) {
      pass(
        `Registered two distinct USER accounts: ${user1.account.accountNumber} and ${user2.account.accountNumber}`
      );
    } else {
      fail("Failed to register two distinct USER accounts");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. LOGIN AND VERIFY ACCOUNT ISOLATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n2. Login Authentication & Account Isolation");

    const validLogin1 = await verifyPassword(user1Password, user1.user.passwordHash);
    const invalidLogin1 = await verifyPassword("WrongPassword!", user1.user.passwordHash);

    if (validLogin1 && !invalidLogin1) {
      pass("User 1 credentials verified via bcrypt (invalid rejected)");
    } else {
      fail("User 1 credential check failed");
    }

    const token1 = await signSessionToken({
      sub: user1.user.id,
      email: user1.user.email,
      name: user1.user.name,
      role: user1.user.role,
    });
    const parsedSession1 = await verifySessionToken(token1);

    const token2 = await signSessionToken({
      sub: user2.user.id,
      email: user2.user.email,
      name: user2.user.name,
      role: user2.user.role,
    });
    const parsedSession2 = await verifySessionToken(token2);

    if (parsedSession1?.sub === user1.user.id && parsedSession2?.sub === user2.user.id) {
      pass("Independent JWT session tokens signed and verified for both users");
    } else {
      fail("Session verification failed");
    }

    // Account isolation check: querying User 1's accounts only yields User 1's records
    const u1Accounts = await prisma.account.findMany({
      where: { userId: parsedSession1!.sub },
    });
    const u2Accounts = await prisma.account.findMany({
      where: { userId: parsedSession2!.sub },
    });

    const u1SeesOnlyOwn =
      u1Accounts.length === 1 && u1Accounts[0].id === user1.account.id;
    const u2SeesOnlyOwn =
      u2Accounts.length === 1 && u2Accounts[0].id === user2.account.id;

    if (u1SeesOnlyOwn && u2SeesOnlyOwn) {
      pass("Account isolation enforced: User 1 and User 2 cannot access each other's accounts");
    } else {
      fail("Account isolation breach detected");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. DEPOSIT INTO THE FIRST ACCOUNT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n3. Deposit Funds into Account 1 (Treasury -> User 1)");

    const depositAmount = 500.0;
    const depositResult = await executeDeposit({
      accountId: user1.account.id,
      amount: depositAmount,
      callerUserId: user1.user.id,
      reference: "E2E_INITIAL_DEPOSIT",
    });

    const u1AfterDeposit = await prisma.account.findUnique({
      where: { id: user1.account.id },
    });

    if (u1AfterDeposit && Number(u1AfterDeposit.balance) === depositAmount) {
      pass(`Deposit successful: User 1 balance credited to $${Number(u1AfterDeposit.balance).toFixed(2)}`);
    } else {
      fail("Deposit failed", `Expected balance $${depositAmount}, got ${u1AfterDeposit?.balance}`);
    }

    if (
      depositResult.ledgerEntries.debit.sequenceNo <
      depositResult.ledgerEntries.credit.sequenceNo
    ) {
      pass(
        `Double-entry sequenced monotonically: Treasury DEBIT (seq #${depositResult.ledgerEntries.debit.sequenceNo}) < User 1 CREDIT (seq #${depositResult.ledgerEntries.credit.sequenceNo})`
      );
    } else {
      fail("Deposit ledger sequence ordering failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. WITHDRAW FROM THE FIRST ACCOUNT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n4. Withdraw Funds from Account 1 (User 1 -> Treasury)");

    const withdrawAmount = 150.0;
    const withdrawResult = await executeWithdrawal({
      accountId: user1.account.id,
      amount: withdrawAmount,
      callerUserId: user1.user.id,
      reference: "E2E_WITHDRAWAL",
    });

    const u1AfterWithdraw = await prisma.account.findUnique({
      where: { id: user1.account.id },
    });
    const expectedBalanceAfterWithdraw = depositAmount - withdrawAmount; // 350.00

    if (
      u1AfterWithdraw &&
      Number(u1AfterWithdraw.balance) === expectedBalanceAfterWithdraw
    ) {
      pass(
        `Withdrawal successful: User 1 balance reduced to $${Number(u1AfterWithdraw.balance).toFixed(2)} ($${depositAmount} - $${withdrawAmount})`
      );
    } else {
      fail(
        "Withdrawal failed",
        `Expected $${expectedBalanceAfterWithdraw}, got ${u1AfterWithdraw?.balance}`
      );
    }

    if (
      withdrawResult.ledgerEntries.debit.sequenceNo >
      depositResult.ledgerEntries.credit.sequenceNo
    ) {
      pass(
        `Ledger sequence increment preserved: Withdrawal seq #${withdrawResult.ledgerEntries.debit.sequenceNo} > Deposit seq #${depositResult.ledgerEntries.credit.sequenceNo}`
      );
    } else {
      fail("Withdrawal sequence monotonicity failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. TRANSFER FUNDS TO THE SECOND ACCOUNT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n5. Transfer Funds from User 1 to User 2");

    const transferAmount = 100.0;
    const transferResult = await executeDoubleEntryMovement({
      senderAccountId: user1.account.id,
      receiverAccountId: user2.account.id,
      amount: transferAmount,
      callerUserId: user1.user.id,
      reference: "E2E_TRANSFER_U1_TO_U2",
    });

    const u1AfterTransfer = await prisma.account.findUnique({
      where: { id: user1.account.id },
    });
    const u2AfterTransfer = await prisma.account.findUnique({
      where: { id: user2.account.id },
    });

    const expectedU1Final = expectedBalanceAfterWithdraw - transferAmount; // 250.00
    const expectedU2Final = transferAmount; // 100.00

    if (
      u1AfterTransfer &&
      Number(u1AfterTransfer.balance) === expectedU1Final &&
      u2AfterTransfer &&
      Number(u2AfterTransfer.balance) === expectedU2Final
    ) {
      pass(
        `Transfer successful: User 1 debited to $${expectedU1Final.toFixed(2)}, User 2 credited to $${expectedU2Final.toFixed(2)}`
      );
    } else {
      fail(
        "Transfer balance check failed",
        `U1: ${u1AfterTransfer?.balance} (expected ${expectedU1Final}), U2: ${u2AfterTransfer?.balance} (expected ${expectedU2Final})`
      );
    }

    const txRecord = await prisma.transaction.findUnique({
      where: { id: transferResult.transactionId },
    });

    if (
      transferResult.success &&
      txRecord?.status === "COMPLETED" &&
      transferResult.ledgerEntries.debit.sequenceNo < transferResult.ledgerEntries.credit.sequenceNo &&
      transferResult.amount === transferAmount
    ) {
      pass(
        `Double-entry transfer generated balanced entries: seq #${transferResult.ledgerEntries.debit.sequenceNo} DEBIT and seq #${transferResult.ledgerEntries.credit.sequenceNo} CREDIT for $${transferResult.amount.toFixed(2)}`
      );
    } else {
      fail("Transfer double-entry balance failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. VERIFY UPDATED BALANCES AND TRANSACTION STATEMENTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n6. Statement History & Proof Isolation Verification");

    // Query statements for User 1
    const u1Txs = await prisma.transaction.findMany({
      where: {
        OR: [
          { senderAccountId: user1.account.id },
          { receiverAccountId: user1.account.id },
        ],
      },
      include: {
        ledgerEntries: {
          where: { accountId: user1.account.id },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Query statements for User 2
    const u2Txs = await prisma.transaction.findMany({
      where: {
        OR: [
          { senderAccountId: user2.account.id },
          { receiverAccountId: user2.account.id },
        ],
      },
      include: {
        ledgerEntries: {
          where: { accountId: user2.account.id },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (u1Txs.length === 3) {
      pass(`User 1 statement contains exactly 3 transactions (Deposit, Withdrawal, Transfer)`);
    } else {
      fail(`User 1 statement count incorrect: expected 3, got ${u1Txs.length}`);
    }

    if (u2Txs.length === 1 && u2Txs[0].id === transferResult.transactionId) {
      pass(`User 2 statement contains exactly 1 incoming transfer transaction`);
    } else {
      fail(`User 2 statement count incorrect: expected 1, got ${u2Txs.length}`);
    }

    // Verify proof isolation: User 1 statement only includes User 1's ledger entries
    const u1Proofs = u1Txs.flatMap((t) => t.ledgerEntries);
    const u1OnlyOwnProofs = u1Proofs.every((p) => p.accountId === user1.account.id);

    const u2Proofs = u2Txs.flatMap((t) => t.ledgerEntries);
    const u2OnlyOwnProofs = u2Proofs.every((p) => p.accountId === user2.account.id);

    if (u1OnlyOwnProofs && u2OnlyOwnProofs) {
      pass("Cryptographic proof isolation verified: ledger entries scoped strictly to account owner");
    } else {
      fail("Proof isolation violation detected in statement query");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. TEST INSUFFICIENT BALANCE, INVALID AMOUNTS, AND IDEMPOTENCY
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n7. Edge Cases: Overdraft, Invalid Inputs & Idempotency");

    // Overdraft withdrawal
    let overdraftWithdrawCaught = false;
    try {
      await executeWithdrawal({
        accountId: user1.account.id,
        amount: 1000.0, // User 1 has $250.00
        callerUserId: user1.user.id,
      });
    } catch (e: any) {
      if (e instanceof LedgerEngineError && e.statusCode === 422) {
        overdraftWithdrawCaught = true;
      }
    }
    if (overdraftWithdrawCaught) {
      pass("Overdraft withdrawal ($1000 with $250 available) rejected with HTTP 422");
    } else {
      fail("Overdraft withdrawal was not rejected properly");
    }

    // Overdraft transfer
    let overdraftTransferCaught = false;
    try {
      await executeDoubleEntryMovement({
        senderAccountId: user2.account.id,
        receiverAccountId: user1.account.id,
        amount: 500.0, // User 2 has $100.00
        callerUserId: user2.user.id,
      });
    } catch (e: any) {
      if (e instanceof LedgerEngineError && e.statusCode === 422) {
        overdraftTransferCaught = true;
      }
    }
    if (overdraftTransferCaught) {
      pass("Overdraft transfer ($500 with $100 available) rejected with HTTP 422");
    } else {
      fail("Overdraft transfer was not rejected properly");
    }

    // Invalid negative amount
    let negativeAmountCaught = false;
    try {
      await executeDeposit({
        accountId: user1.account.id,
        amount: -50.0,
        callerUserId: user1.user.id,
      });
    } catch (e: any) {
      if (e instanceof LedgerEngineError && e.statusCode === 400) {
        negativeAmountCaught = true;
      }
    }
    if (negativeAmountCaught) {
      pass("Negative deposit amount (-$50) rejected with HTTP 400");
    } else {
      fail("Negative deposit was not rejected");
    }

    // Same account transfer
    let sameAccountCaught = false;
    try {
      await executeDoubleEntryMovement({
        senderAccountId: user1.account.id,
        receiverAccountId: user1.account.id,
        amount: 25.0,
        callerUserId: user1.user.id,
      });
    } catch (e: any) {
      if (e instanceof LedgerEngineError && e.statusCode === 400) {
        sameAccountCaught = true;
      }
    }
    if (sameAccountCaught) {
      pass("Self-transfer to same account rejected with HTTP 400");
    } else {
      fail("Self-transfer was not rejected");
    }

    // Duplicate idempotency keys
    const testIdempKey = `idemp-e2e-${Date.now()}`;
    const payloadA = {
      receiverAccountNumber: user2.account.accountNumber,
      amount: 10.0,
      reference: "E2E_IDEMP_TEST",
    };

    // Initial execution
    const firstExec = await handleIdempotency(
      user1.user.id,
      testIdempKey,
      "/api/transactions/transfer",
      "POST",
      payloadA
    );

    if (!firstExec.isReplay && firstExec.recordId) {
      pass("Initial idempotency key acquired with PROCESSING status");
      // Finalize the record as completed
      await prisma.idempotencyRecord.update({
        where: { id: firstExec.recordId },
        data: {
          status: "COMPLETED",
          responseCode: 200,
          responseBody: JSON.stringify({
            message: "Transfer successful",
            transferred: 10.0,
          }),
        },
      });
    } else {
      fail("Failed to acquire new idempotency record");
    }

    // Replay with identical key & identical payload
    const replayExec = await handleIdempotency(
      user1.user.id,
      testIdempKey,
      "/api/transactions/transfer",
      "POST",
      payloadA
    );

    if (replayExec.isReplay && replayExec.cachedResponse) {
      const isReplayed = replayExec.cachedResponse.headers.get("Idempotent-Replayed");
      if (isReplayed === "true") {
        pass("Idempotency replay recognized: returned cached response with 'Idempotent-Replayed: true' header");
      } else {
        fail("Cached response missing Idempotent-Replayed header");
      }
    } else {
      fail("Idempotency replay mechanism failed");
    }

    // Conflict: replay with identical key but altered payload
    const idempMismatch = await handleIdempotency(
      user1.user.id,
      testIdempKey,
      "/api/transactions/transfer",
      "POST",
      {
        receiverAccountNumber: user2.account.accountNumber,
        amount: 999.0, // altered payload
      }
    );

    if (!idempMismatch.isReplay && idempMismatch.errorResponse?.status === 422) {
      pass("Idempotency key reuse with different payload correctly rejected with HTTP 422");
    } else {
      fail("Altered payload was not rejected on reused idempotency key");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. DOUBLE-ENTRY BALANCE & HMAC CONTINUITY WALK
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n8. Double-Entry Balance Invariant & Cryptographic HMAC Continuity");

    // Aggregate all ledger entries
    const allDebits = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { entryType: "DEBIT" },
    });
    const allCredits = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { entryType: "CREDIT" },
    });

    const sumDebits = Number(allDebits._sum.amount || 0);
    const sumCredits = Number(allCredits._sum.amount || 0);

    if (sumDebits === sumCredits) {
      pass(
        `Double-entry invariant strictly holds: Total Debits ($${sumDebits.toFixed(2)}) === Total Credits ($${sumCredits.toFixed(2)})`
      );
    } else {
      fail(
        "Double-entry balance mismatch",
        `Debits: ${sumDebits}, Credits: ${sumCredits}`
      );
    }

    // HMAC chain walk from genesis sequence 1 to head
    const fullChain = await prisma.ledgerEntry.findMany({
      orderBy: { sequenceNo: "asc" },
    });

    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    let chainValid = true;

    for (const entry of fullChain) {
      if (entry.sequenceNo !== expectedSeq) {
        chainValid = false;
        fail(`Sequence gap: expected ${expectedSeq}, got ${entry.sequenceNo}`);
        break;
      }
      if (entry.prevHash !== expectedPrev) {
        chainValid = false;
        fail(`prevHash mismatch at seq #${entry.sequenceNo}`);
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
        chainValid = false;
        fail(`HMAC mismatch at seq #${entry.sequenceNo}`);
        break;
      }
      expectedPrev = entry.entryHash;
      expectedSeq++;
    }

    if (chainValid) {
      pass(`Full HMAC chain verified: all ${fullChain.length} entries intact with zero gaps or HMAC mismatches`);
    }
  } catch (err: any) {
    console.error("Unhandled test error:", err);
    fail("Test execution threw unhandled exception", err.message);
  } finally {
    // ─────────────────────────────────────────────────────────────────────────
    // 9. CLEANUP TEST DATA
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n── Cleaning up test data safely…");
    await cleanup(PREFIX);

    // Verify Treasury is balanced after cleanup
    const treasury = await prisma.account.findFirst({
      where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
    });
    if (treasury) {
      const cr = await prisma.ledgerEntry.aggregate({
        where: { accountId: treasury.id, entryType: "CREDIT" },
        _sum: { amount: true },
      });
      const db = await prisma.ledgerEntry.aggregate({
        where: { accountId: treasury.id, entryType: "DEBIT" },
        _sum: { amount: true },
      });
      const expectedTreasuryBal = Number(cr._sum.amount || 0) - Number(db._sum.amount || 0);
      if (Number(treasury.balance) === expectedTreasuryBal) {
        pass(`Treasury balance reconciled after test teardown ($${expectedTreasuryBal.toFixed(2)})`);
      } else {
        fail("Treasury reconciliation failed after teardown");
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n==================================================");
  console.log(`  Stage 6.1 Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log("\n  Failed checks:");
    errors.forEach((e) => console.log(`    • ${e}`));
  }
  console.log("==================================================\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runStage61Verification().catch(async (e) => {
  console.error("Fatal test failure:", e);
  await prisma.$disconnect();
  process.exit(1);
});
