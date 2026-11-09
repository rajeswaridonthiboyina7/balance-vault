import {
  PrismaClient,
  Role,
  AccountStatus,
  TransactionType,
  TransactionStatus,
  EntryType,
} from "@prisma/client";
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

async function main() {
  console.log("Starting BalanceVault database seed...");

  const adminEmail = process.env.INITIAL_ADMIN_EMAIL || "admin@balancevault.local";
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || "AdminSecurePassword123!";
  const adminName = process.env.INITIAL_ADMIN_NAME || "System Administrator";
  const reserveAmount = 1000000.0;

  // 1. Bootstrap Admin User
  let admin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!admin) {
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(adminPassword, saltRounds);

    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        name: adminName,
        role: Role.ADMIN,
      },
    });
    console.log(`Initial Admin created: ${admin.email}`);

    // Create primary administrative account
    await prisma.account.create({
      data: {
        userId: admin.id,
        accountNumber: "ACC-ADMIN-0001",
        balance: 0.0,
        currency: "USD",
        status: AccountStatus.ACTIVE,
      },
    });
  } else {
    console.log(`Admin user already exists: ${admin.email}`);
  }

  // 2. Bootstrap Dedicated System Internal User
  const systemUserEmail = "system.treasury@balancevault.internal";
  let systemUser = await prisma.user.findUnique({
    where: { email: systemUserEmail },
  });

  if (!systemUser) {
    const systemRandomPass = await bcrypt.hash(
      `SYS_${Date.now()}_${Math.random()}`,
      12
    );
    systemUser = await prisma.user.create({
      data: {
        email: systemUserEmail,
        passwordHash: systemRandomPass,
        name: "System Treasury Vault",
        role: Role.ADMIN,
      },
    });
  }

  // 3. Bootstrap System Opening Equity / Capital Account
  let equityAccount = await prisma.account.findUnique({
    where: { accountNumber: SYSTEM_EQUITY_ACCOUNT },
  });

  if (!equityAccount) {
    equityAccount = await prisma.account.create({
      data: {
        userId: systemUser.id,
        accountNumber: SYSTEM_EQUITY_ACCOUNT,
        balance: 0.0,
        currency: "USD",
        status: AccountStatus.ACTIVE,
      },
    });
    console.log(`System Equity Account created: ${equityAccount.accountNumber}`);
  } else {
    console.log(`System Equity Account already exists: ${equityAccount.accountNumber}`);
  }

  // 4. Bootstrap System Operating Treasury Account
  let treasuryAccount = await prisma.account.findUnique({
    where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
  });

  if (!treasuryAccount) {
    treasuryAccount = await prisma.account.create({
      data: {
        userId: systemUser.id,
        accountNumber: SYSTEM_TREASURY_ACCOUNT,
        balance: 0.0,
        currency: "USD",
        status: AccountStatus.ACTIVE,
      },
    });
    console.log(`System Treasury Account created: ${treasuryAccount.accountNumber}`);
  } else {
    console.log(`System Treasury Account already exists: ${treasuryAccount.accountNumber}`);
  }

  // 5. Balanced Double-Entry Opening Transaction (Equity -> Treasury Reserve)
  const genesisEntry1 = await prisma.ledgerEntry.findUnique({
    where: { sequenceNo: 1 },
  });

  if (!genesisEntry1) {
    await prisma.$transaction(async (tx) => {
      // Create Balanced Double-Entry Opening Transaction
      const genesisTx = await tx.transaction.create({
        data: {
          senderAccountId: equityAccount!.id,
          receiverAccountId: treasuryAccount!.id,
          amount: reserveAmount,
          currency: "USD",
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          reference: "GENESIS_CAPITAL_ALLOCATION",
          metadata: JSON.stringify({
            purpose: "Initial capitalization of Operating Treasury from System Equity Reserve",
            source: SYSTEM_EQUITY_ACCOUNT,
            destination: SYSTEM_TREASURY_ACCOUNT,
          }),
        },
      });

      const timestamp = genesisTx.createdAt.toISOString();

      // Update Treasury Account Balance
      await tx.account.update({
        where: { id: treasuryAccount!.id },
        data: { balance: reserveAmount },
      });

      // Sequence 1: DEBIT Opening Equity Account
      const debitEntryHash = computeEntryHash({
        prevHash: GENESIS_HASH,
        sequenceNo: 1,
        accountId: equityAccount!.id,
        entryType: "DEBIT",
        amount: Number(reserveAmount).toFixed(4),
        balanceAfter: (0.0).toFixed(4),
        timestamp,
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId: genesisTx.id,
          accountId: equityAccount!.id,
          sequenceNo: 1,
          entryType: EntryType.DEBIT,
          amount: reserveAmount,
          balanceAfter: 0.0,
          prevHash: GENESIS_HASH,
          entryHash: debitEntryHash,
          createdAt: genesisTx.createdAt,
        },
      });

      // Sequence 2: CREDIT Operating Treasury Account
      const creditEntryHash = computeEntryHash({
        prevHash: debitEntryHash,
        sequenceNo: 2,
        accountId: treasuryAccount!.id,
        entryType: "CREDIT",
        amount: Number(reserveAmount).toFixed(4),
        balanceAfter: Number(reserveAmount).toFixed(4),
        timestamp,
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId: genesisTx.id,
          accountId: treasuryAccount!.id,
          sequenceNo: 2,
          entryType: EntryType.CREDIT,
          amount: reserveAmount,
          balanceAfter: reserveAmount,
          prevHash: debitEntryHash,
          entryHash: creditEntryHash,
          createdAt: genesisTx.createdAt,
        },
      });

      // Anchor State in Genesis Checkpoint (sequence 2)
      const checkpointHash = computeCheckpointHash(
        2,
        creditEntryHash,
        2,
        timestamp
      );

      await tx.ledgerCheckpoint.upsert({
        where: { sequenceNo: 2 },
        create: {
          sequenceNo: 2,
          entryHash: creditEntryHash,
          checkpointHash,
          verifiedEntriesCount: 2,
          createdAt: genesisTx.createdAt,
        },
        update: {},
      });

      console.log(
        "Balanced double-entry genesis transaction, ledger sequences 1 & 2, and checkpoint initialized."
      );
    });
  } else {
    console.log("Genesis double-entry ledger entries already initialized.");
  }

  // 6. Idempotent System Initialization Audit Log
  const existingBootstrapLog = await prisma.auditLog.findFirst({
    where: { action: "SYSTEM_BOOTSTRAP" },
  });

  if (!existingBootstrapLog) {
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        action: "SYSTEM_BOOTSTRAP",
        entity: "SYSTEM",
        entityId: "GENESIS",
        details: "BalanceVault system seeded with Admin, Equity, Treasury, and Double-Entry Genesis Ledger",
      },
    });
    console.log("Recorded initial SYSTEM_BOOTSTRAP audit log.");
  } else {
    console.log("SYSTEM_BOOTSTRAP audit log already exists (skipping duplicate creation).");
  }

  console.log("Database seed completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error during seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
