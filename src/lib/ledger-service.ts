import { prisma } from "./prisma";
import {
  TransactionType,
  TransactionStatus,
  EntryType,
  AccountStatus,
} from "@prisma/client";
import { GENESIS_HASH, SYSTEM_TREASURY_ACCOUNT } from "./constants";
import { computeEntryHash } from "./ledger-crypto";

export interface TransferParams {
  senderAccountId: string;
  receiverAccountId: string;
  amount: number;
  currency?: string;
  type?: TransactionType;
  reference?: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
  callerUserId?: string; // If provided, validates ownership of sender account
  bypassOwnershipCheck?: boolean; // Used for system treasury operations
}

export interface TransactionResult {
  success: boolean;
  transactionId: string;
  type: TransactionType;
  amount: number;
  currency: string;
  senderAccount: {
    id: string;
    accountNumber: string;
    newBalance: number;
  };
  receiverAccount: {
    id: string;
    accountNumber: string;
    newBalance: number;
  };
  ledgerEntries: {
    debit: {
      sequenceNo: number;
      entryHash: string;
    };
    credit: {
      sequenceNo: number;
      entryHash: string;
    };
  };
  timestamp: string;
}

export class LedgerEngineError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "LedgerEngineError";
    this.statusCode = statusCode;
  }
}

/**
 * Executes an atomic, double-entry financial transfer backed by cryptographically
 * chained ledger entries.
 *
 * Guarantees:
 * 1. ACID Transactionality: If any step fails, all balance changes rollback.
 * 2. Deadlock Prevention: Row locks on accounts are acquired in deterministic ascending order.
 * 3. Invariant: Sum of Debits == Sum of Credits.
 * 4. Invariant: Accounts cannot drop below zero (enforced in application + DB check constraint).
 * 5. Strictly monotonic sequence numbers & SHA-256 hash chaining.
 */
export async function executeDoubleEntryMovement(
  params: TransferParams
): Promise<TransactionResult> {
  const {
    senderAccountId,
    receiverAccountId,
    amount,
    currency = "USD",
    type = TransactionType.TRANSFER,
    reference,
    metadata,
    idempotencyKey,
    callerUserId,
    bypassOwnershipCheck = false,
  } = params;

  // 1. Basic validation
  if (!amount || typeof amount !== "number" || amount <= 0 || isNaN(amount)) {
    throw new LedgerEngineError("Transfer amount must be a positive number greater than 0.", 400);
  }

  if (senderAccountId === receiverAccountId) {
    throw new LedgerEngineError("Cannot transfer funds to the same account.", 400);
  }

  // 2. Execute within an ACID transaction
  return prisma.$transaction(
    async (tx) => {
      // Deterministic lock acquisition order (prevents deadlocks)
      const [firstLockId, secondLockId] = [senderAccountId, receiverAccountId].sort();

      // Acquire pessimistic locks on accounts
      const accountsLocked = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          userId: string;
          accountNumber: string;
          balance: any;
          currency: string;
          status: AccountStatus;
        }>
      >(
        `SELECT "id", "userId", "accountNumber", "balance", "currency", "status" 
         FROM accounts 
         WHERE "id" IN ($1, $2) 
         ORDER BY "id" ASC 
         FOR UPDATE`,
        firstLockId,
        secondLockId
      );

      const sender = accountsLocked.find((a) => a.id === senderAccountId);
      const receiver = accountsLocked.find((a) => a.id === receiverAccountId);

      if (!sender) {
        throw new LedgerEngineError("Sender account not found.", 404);
      }
      if (!receiver) {
        throw new LedgerEngineError("Receiver account not found.", 404);
      }

      // Check account statuses
      if (sender.status !== AccountStatus.ACTIVE) {
        throw new LedgerEngineError(`Sender account is ${sender.status}. Outgoing transactions are suspended.`, 403);
      }
      if (receiver.status !== AccountStatus.ACTIVE) {
        throw new LedgerEngineError(`Receiver account is ${receiver.status}. Incoming transactions are suspended.`, 403);
      }

      // Check ownership
      if (!bypassOwnershipCheck && callerUserId && sender.userId !== callerUserId) {
        throw new LedgerEngineError("Forbidden: You do not own the source account.", 403);
      }

      // Currency check
      if (sender.currency !== currency || receiver.currency !== currency) {
        throw new LedgerEngineError(`Currency mismatch: Both accounts must use ${currency}.`, 400);
      }

      // Check balance
      const senderBalance = Number(sender.balance);
      const receiverBalance = Number(receiver.balance);

      if (senderBalance < amount) {
        throw new LedgerEngineError(
          `Insufficient funds: Account balance is $${senderBalance.toFixed(2)}, attempted to move $${amount.toFixed(2)}.`,
          422
        );
      }

      const newSenderBalance = Number((senderBalance - amount).toFixed(4));
      const newReceiverBalance = Number((receiverBalance + amount).toFixed(4));

      // 1. Acquire transaction-level advisory lock on global ledger sequence
      // pg_advisory_xact_lock automatically releases when transaction commits or rolls back
      // Using hashtext('global_ledger_sequence') ensures deterministic 64-bit lock key
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('global_ledger_sequence'))`
      );

      // 2. Retrieve latest ledger head only AFTER acquiring the advisory lock
      const latestHead = await tx.$queryRawUnsafe<
        Array<{ sequenceNo: number; entryHash: string }>
      >(
        `SELECT "sequenceNo", "entryHash" 
         FROM ledger_entries 
         ORDER BY "sequenceNo" DESC 
         LIMIT 1`
      );

      const lastSeq = latestHead.length > 0 ? latestHead[0].sequenceNo : 0;
      const lastHash = latestHead.length > 0 ? latestHead[0].entryHash : GENESIS_HASH;

      const seqDebit = lastSeq + 1;
      const seqCredit = lastSeq + 2;

      // Update account balances
      await tx.account.update({
        where: { id: sender.id },
        data: { balance: newSenderBalance },
      });

      await tx.account.update({
        where: { id: receiver.id },
        data: { balance: newReceiverBalance },
      });

      // Create transaction record
      const transaction = await tx.transaction.create({
        data: {
          idempotencyKey,
          senderAccountId: sender.id,
          receiverAccountId: receiver.id,
          amount,
          currency,
          type,
          status: TransactionStatus.COMPLETED,
          reference: reference || null,
          metadata: metadata ? JSON.stringify(metadata) : null,
        },
      });

      const timestamp = transaction.createdAt.toISOString();

      // Compute Sequence 1: DEBIT Entry
      const debitHash = computeEntryHash({
        prevHash: lastHash,
        sequenceNo: seqDebit,
        accountId: sender.id,
        entryType: "DEBIT",
        amount: Number(amount).toFixed(4),
        balanceAfter: Number(newSenderBalance).toFixed(4),
        timestamp,
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: sender.id,
          sequenceNo: seqDebit,
          entryType: EntryType.DEBIT,
          amount,
          balanceAfter: newSenderBalance,
          prevHash: lastHash,
          entryHash: debitHash,
          createdAt: transaction.createdAt,
        },
      });

      // Compute Sequence 2: CREDIT Entry
      const creditHash = computeEntryHash({
        prevHash: debitHash,
        sequenceNo: seqCredit,
        accountId: receiver.id,
        entryType: "CREDIT",
        amount: Number(amount).toFixed(4),
        balanceAfter: Number(newReceiverBalance).toFixed(4),
        timestamp,
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: receiver.id,
          sequenceNo: seqCredit,
          entryType: EntryType.CREDIT,
          amount,
          balanceAfter: newReceiverBalance,
          prevHash: debitHash,
          entryHash: creditHash,
          createdAt: transaction.createdAt,
        },
      });

      // Audit Log
      await tx.auditLog.create({
        data: {
          actorId: callerUserId || sender.userId,
          action: `TRANSACTION_${type}`,
          entity: "TRANSACTION",
          entityId: transaction.id,
          details: `Moved $${amount.toFixed(2)} from ${sender.accountNumber} to ${receiver.accountNumber}. Sequences: ${seqDebit}, ${seqCredit}.`,
        },
      });

      return {
        success: true,
        transactionId: transaction.id,
        type,
        amount,
        currency,
        senderAccount: {
          id: sender.id,
          accountNumber: sender.accountNumber,
          newBalance: newSenderBalance,
        },
        receiverAccount: {
          id: receiver.id,
          accountNumber: receiver.accountNumber,
          newBalance: newReceiverBalance,
        },
        ledgerEntries: {
          debit: {
            sequenceNo: seqDebit,
            entryHash: debitHash,
          },
          credit: {
            sequenceNo: seqCredit,
            entryHash: creditHash,
          },
        },
        timestamp,
      };
    },
    {
      maxWait: 5000,
      timeout: 10000,
    }
  );
}

/**
 * Deposits money into a user account by transferring from the Operating Treasury vault
 */
export async function executeDeposit(params: {
  accountId: string;
  amount: number;
  callerUserId: string;
  reference?: string;
  idempotencyKey?: string;
}): Promise<TransactionResult> {
  const treasury = await prisma.account.findUnique({
    where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
  });

  if (!treasury) {
    throw new LedgerEngineError("System Treasury Account not found.", 500);
  }

  return executeDoubleEntryMovement({
    senderAccountId: treasury.id,
    receiverAccountId: params.accountId,
    amount: params.amount,
    type: TransactionType.DEPOSIT,
    reference: params.reference || "DEPOSIT_FROM_TREASURY",
    idempotencyKey: params.idempotencyKey,
    callerUserId: params.callerUserId,
    bypassOwnershipCheck: true, // Operating treasury transfer
  });
}

/**
 * Withdraws money from a user account by transferring into the Operating Treasury vault
 */
export async function executeWithdrawal(params: {
  accountId: string;
  amount: number;
  callerUserId: string;
  reference?: string;
  idempotencyKey?: string;
}): Promise<TransactionResult> {
  const treasury = await prisma.account.findUnique({
    where: { accountNumber: SYSTEM_TREASURY_ACCOUNT },
  });

  if (!treasury) {
    throw new LedgerEngineError("System Treasury Account not found.", 500);
  }

  return executeDoubleEntryMovement({
    senderAccountId: params.accountId,
    receiverAccountId: treasury.id,
    amount: params.amount,
    type: TransactionType.WITHDRAWAL,
    reference: params.reference || "WITHDRAWAL_TO_TREASURY",
    idempotencyKey: params.idempotencyKey,
    callerUserId: params.callerUserId,
    bypassOwnershipCheck: false, // User must own the account
  });
}

