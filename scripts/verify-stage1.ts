import { PrismaClient, Role, EntryType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import * as dotenv from "dotenv";
import {
  GENESIS_HASH,
  SYSTEM_EQUITY_ACCOUNT,
  SYSTEM_TREASURY_ACCOUNT,
} from "../src/lib/constants";
import {
  computeEntryHash,
  computeCheckpointHash,
} from "../src/lib/ledger-crypto";

dotenv.config();

const prisma = new PrismaClient();

async function runVerification() {
  console.log("=== Running Stage 1 Comprehensive Verification Suite ===");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}${detail ? ` -> ${detail}` : ""}`);
      failed++;
    }
  }

  try {
    // 1. Verify Admin User
    const admin = await prisma.user.findUnique({
      where: { email: process.env.INITIAL_ADMIN_EMAIL || "admin@balancevault.local" },
    });
    assert(!!admin, "Initial admin user exists in DB");
    assert(admin?.role === Role.ADMIN, "Admin has ADMIN role");

    const passMatch = await bcrypt.compare(
      process.env.INITIAL_ADMIN_PASSWORD || "AdminSecurePassword123!",
      admin?.passwordHash || ""
    );
    assert(passMatch, "Admin password hash matches configured secret");

    // 2. Verify System Equity Account
    const equity = await prisma.account.findUnique({
      where: { accountNumber: SYSTEM_EQUITY_ACCOUNT },
    });
    assert(!!equity, "System Equity account exists");
    assert(Number(equity?.balance) === 0, "Equity account balance is 0.00");

    // 3. Verify System Treasury Account
    const treasury = await prisma.account.findUnique({
      where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
    });
    assert(!!treasury, "System Treasury account exists");
    assert(Number(treasury?.balance) === 1000000, "Treasury reserve balance is $1,000,000.00");

    // 4. Verify Exactly 1 SYSTEM_BOOTSTRAP audit record
    const bootstrapLogs = await prisma.auditLog.findMany({
      where: { action: "SYSTEM_BOOTSTRAP" },
    });
    assert(
      bootstrapLogs.length === 1,
      "Exactly one SYSTEM_BOOTSTRAP audit record exists after multiple seed runs",
      `Found ${bootstrapLogs.length} records`
    );

    // 5. Verify Total Debits Equal Total Credits Across the Ledger
    const debitSumResult = await prisma.ledgerEntry.aggregate({
      where: { entryType: EntryType.DEBIT },
      _sum: { amount: true },
    });
    const creditSumResult = await prisma.ledgerEntry.aggregate({
      where: { entryType: EntryType.CREDIT },
      _sum: { amount: true },
    });

    const totalDebits = Number(debitSumResult._sum.amount || 0);
    const totalCredits = Number(creditSumResult._sum.amount || 0);
    assert(
      totalDebits === 1000000 && totalCredits === 1000000 && totalDebits === totalCredits,
      "Total ledger debits equal total ledger credits ($1,000,000.00)",
      `Debits: ${totalDebits}, Credits: ${totalCredits}`
    );

    // 6. Verify Account Balance Matches Ledger Entries
    const treasuryCredits = await prisma.ledgerEntry.aggregate({
      where: { accountId: treasury!.id, entryType: EntryType.CREDIT },
      _sum: { amount: true },
    });
    const treasuryDebits = await prisma.ledgerEntry.aggregate({
      where: { accountId: treasury!.id, entryType: EntryType.DEBIT },
      _sum: { amount: true },
    });
    const computedTreasuryBalance =
      Number(treasuryCredits._sum.amount || 0) - Number(treasuryDebits._sum.amount || 0);
    assert(
      computedTreasuryBalance === Number(treasury?.balance),
      "Treasury account balance matches its ledger entries",
      `DB balance: ${treasury?.balance}, Ledger sum: ${computedTreasuryBalance}`
    );

    // 7. Verify HMAC-SHA256 Cryptographic Chain
    const entry1 = await prisma.ledgerEntry.findUnique({
      where: { sequenceNo: 1 },
    });
    const entry2 = await prisma.ledgerEntry.findUnique({
      where: { sequenceNo: 2 },
    });

    assert(!!entry1 && !!entry2, "Ledger sequences 1 and 2 exist in DB");

    // Sequence 1 hash verification (genesis root)
    const expectedHash1 = computeEntryHash({
      prevHash: GENESIS_HASH,
      sequenceNo: 1,
      accountId: entry1!.accountId,
      entryType: "DEBIT",
      amount: Number(entry1!.amount).toFixed(4),
      balanceAfter: Number(entry1!.balanceAfter).toFixed(4),
      timestamp: entry1!.createdAt.toISOString(),
    });
    assert(
      entry1?.prevHash === GENESIS_HASH && entry1?.entryHash === expectedHash1,
      "Sequence 1 links to GENESIS_HASH and HMAC matches expected payload digest"
    );

    // Sequence 2 hash verification (chained to Sequence 1)
    const expectedHash2 = computeEntryHash({
      prevHash: entry1!.entryHash,
      sequenceNo: 2,
      accountId: entry2!.accountId,
      entryType: "CREDIT",
      amount: Number(entry2!.amount).toFixed(4),
      balanceAfter: Number(entry2!.balanceAfter).toFixed(4),
      timestamp: entry2!.createdAt.toISOString(),
    });
    assert(
      entry2?.prevHash === entry1?.entryHash && entry2?.entryHash === expectedHash2,
      "Sequence 2 links to Sequence 1 hash and HMAC matches expected payload digest"
    );

    // 8. Verify Genesis Checkpoint
    const checkpoint = await prisma.ledgerCheckpoint.findUnique({
      where: { sequenceNo: 2 },
    });
    assert(!!checkpoint, "Ledger checkpoint exists for sequence 2");

    const expectedCheckpointHash = computeCheckpointHash(
      2,
      entry2!.entryHash,
      2,
      checkpoint!.createdAt.toISOString()
    );
    assert(
      checkpoint?.entryHash === entry2?.entryHash &&
        checkpoint?.checkpointHash === expectedCheckpointHash &&
        checkpoint?.verifiedEntriesCount === 2,
      "Genesis Checkpoint anchors sequence 2 and matches computed checkpoint HMAC"
    );

    // 9. Verify Idempotency Unique Constraint (userId + key)
    const testKey = `test-key-${Date.now()}`;
    const testHash = "sample-sha256-hash-payload";
    const expiresAt = new Date(Date.now() + 60000);

    const rec1 = await prisma.idempotencyRecord.create({
      data: {
        userId: admin!.id,
        key: testKey,
        requestHash: testHash,
        expiresAt,
      },
    });
    assert(!!rec1, "Can insert idempotency record for user");

    let duplicateRejected = false;
    try {
      await prisma.idempotencyRecord.create({
        data: {
          userId: admin!.id,
          key: testKey,
          requestHash: "different-payload-hash",
          expiresAt,
        },
      });
    } catch {
      duplicateRejected = true;
    }
    assert(
      duplicateRejected,
      "Idempotency unique constraint enforces per-user key uniqueness"
    );

    // Clean up test idempotency record
    await prisma.idempotencyRecord.delete({ where: { id: rec1.id } });

    // 10. Verify Database Check Constraint: balance >= 0
    let negativeBalanceRejected = false;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO accounts ("id", "userId", "accountNumber", "balance", "currency", "status", "createdAt", "updatedAt") 
         VALUES ('test-neg-acc', '${admin!.id}', 'ACC-NEG-TEST', -50.00, 'USD', 'ACTIVE', NOW(), NOW())`
      );
    } catch (err: any) {
      if (err.message && err.message.includes("accounts_balance_check")) {
        negativeBalanceRejected = true;
      }
    }
    assert(
      negativeBalanceRejected,
      "Database CHECK constraint accounts_balance_check blocks negative balance"
    );

    console.log(`\nVerification Summary: ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Verification error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runVerification();
