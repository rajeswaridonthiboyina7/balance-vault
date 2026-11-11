# BalanceVault: Threat Model & Security Architecture

This document outlines the threat modeling methodology, attack surfaces, threat analysis, technical mitigations, and residual risks for the **BalanceVault** financial ledger platform.

---

## 1. Threat Modeling Methodology

BalanceVault applies the **STRIDE** methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) evaluated against financial accounting invariants:

- **Double-Entry Invariant**: $\sum \text{Debits} \equiv \sum \text{Credits}$ across all ledger movements.
- **Balance Non-Negativity Invariant**: $\text{Balance} \ge 0.00$ at all times for standard customer accounts.
- **Cryptographic Sequence Monotonicity**: Sequence numbers must be strictly continuous ($S_{i+1} = S_i + 1$) and hash-linked ($H_{i+1} = \text{HMAC}(H_i, \text{Payload}_{i+1})$).
- **Idempotent Execution**: Network retries must never double-debit or double-credit funds.

---

## 2. Threat Analysis & Mitigation Matrix

### T1: Double Spending & Account Overdraft
- **Threat**: An attacker initiates multiple rapid withdrawals or transfers to exceed available balance before the account balance column is decremented.
- **Risk Level**: **Critical** (Direct financial loss)
- **Mitigation**:
  1. **Deterministic Row Locks**: In `src/lib/ledger-service.ts`, accounts involved in a transaction are acquired in deterministic ascending ID order using `SELECT ... FOR UPDATE`. This serializes concurrent operations touching the same account and eliminates deadlocks.
  2. **Atomic Verification**: Available balance is re-verified inside the active ACID transaction after lock acquisition.
  3. **Database-Level CHECK Constraint**: The `accounts` table enforces `CONSTRAINT "accounts_balance_check" CHECK ("balance" >= 0.00)`. Even if application-layer checks were bypassed, PostgreSQL rejects negative balances at the storage engine level.

### T2: Race Conditions & Sequence Number Clashing
- **Threat**: Concurrent transactions attempting to compute and append ledger entries simultaneously could read the same tip hash and sequence number, causing sequence collisions, forks, or non-deterministic ledger state.
- **Risk Level**: **Critical** (Ledger corruption & chain bifurcation)
- **Mitigation**:
  1. **PostgreSQL Advisory Lock Mutex**: Inside every financial movement (`executeDoubleEntryMovement`, `executeDeposit`, `executeWithdrawal`), the application acquires a transaction-level advisory lock:
     ```sql
     SELECT pg_advisory_xact_lock(hashtext('global_ledger_sequence'));
     ```
  2. **Scoped Serialization**: The lock is held exclusively until the transaction commits or aborts. Only one database worker can read the chain tip, allocate the next monotonic sequence numbers, compute HMAC digests, and write ledger rows at any given millisecond.
  3. **Monotonic Verification Walk**: The verification suite confirms sequence monotonicity under 6+ concurrent transfer bursts without gaps.

### T3: Request Replay & Accidental Duplicate Submissions
- **Threat**: A client's network connection drops after a transfer is processed on the server, prompting the client or browser to retry the HTTP POST request, causing a duplicate transfer.
- **Risk Level**: **High** (Duplicate money movement)
- **Mitigation**:
  1. **Idempotency Key Protocol**: The client generates a unique idempotency key (stored in `idempotency-key` HTTP header) when a financial modal opens.
  2. **Atomic State Transition**: `src/lib/idempotency.ts` claims the key within a transaction with status `PROCESSING`.
  3. **Replay Cache**: If a request arrives with an identical key and matching payload, the server returns the cached response with `Idempotent-Replayed: true` header without re-executing the transfer.
  4. **Payload Mismatch Guard**: If a key is reused with an altered payload (e.g. different recipient or amount), the request is rejected with HTTP 422 Unprocessable Entity.
  5. **Compound Unique Constraint**: `@@unique([userId, key])` at the database level guarantees per-user idempotency uniqueness across server instances.

### T4: Ledger History Tampering & Data Mutation
- **Threat**: A rogue database administrator, SQL injection, or compromised server access modifies transaction amounts or ledger balances directly in PostgreSQL.
- **Risk Level**: **Critical** (Falsification of financial records)
- **Mitigation**:
  1. **HMAC-SHA256 Hash Chaining**: Every `LedgerEntry` row contains `prevHash` and `entryHash`:
     $$\text{entryHash} = \text{HMAC-SHA256}(K, \text{prevHash} \mathbin{\Vert} \text{seq} \mathbin{\Vert} \text{accountId} \mathbin{\Vert} \text{type} \mathbin{\Vert} \text{amount} \mathbin{\Vert} \text{balanceAfter} \mathbin{\Vert} \text{timestamp})$$
  2. **Server-Side Secret Isolation**: The secret key $K$ (`LEDGER_HMAC_SECRET`) is stored exclusively in application environment variables and never persisted to the database. An attacker with full read access to the database cannot re-sign altered rows.
  3. **Periodic Checkpoint Commitments**: Checkpoints (`LedgerCheckpoint`) store immutable sequence anchors computing cryptographic digests over entry count and timestamp.
  4. **Continuous Verification Walk**: The `/api/ledger/verify` endpoint walks the entire chain from Genesis Hash to tip. Any modified row immediately fails HMAC recomputation, pinpointing the exact compromised sequence number.

### T5: Authentication Brute-Force & Credential Stuffing
- **Threat**: Automated bots attempt rapid credential spraying or password dictionary attacks against the `/api/auth/login` endpoint.
- **Risk Level**: **High** (Account compromise)
- **Mitigation**:
  1. **Dual-Layer Sliding-Window Rate Limiting**: Implemented via PostgreSQL table `rate_limit_buckets` (resilient across serverless cold starts):
     - **IP Layer**: Max 10 attempts per minute per IP address.
     - **Account Layer**: Max 5 attempts per minute per target email.
  2. **Standard 429 Response**: Returns HTTP 429 with `Retry-After` header indicating remaining penalty seconds.
  3. **Bcrypt Work Factor**: 12 salt rounds (~250ms hashing time per attempt) significantly raises the computational cost of offline brute forcing.

### T6: Privilege Escalation & Unauthorized Access
- **Threat**: A standard customer (`Role.USER`) attempts to access administrative pages (`/admin`) or administrative APIs (`/api/admin/*`, `/api/ledger/verify`).
- **Risk Level**: **High** (Unauthorized administrative actions)
- **Mitigation**:
  1. **Edge Middleware Guard**: `src/middleware.ts` intercepts `/admin` and `/api/admin/*`, decrypts and verifies the JWT token with `jose`, and verifies `payload.role === "ADMIN"`. Non-admin sessions are redirected to `/dashboard` or return HTTP 403.
  2. **In-Route Defense-in-Depth**: Every individual admin route handler explicitly invokes:
     ```typescript
     const auth = await requireRole([Role.ADMIN]);
     if (auth.response) return auth.response;
     ```
  3. **Public Registration Role Isolation**: The `/api/auth/register` endpoint forces `role: Role.USER` inside a database transaction, ignoring any role attribute sent in the registration request body.

### T7: Information Disclosure & Cross-Account Data Leakage
- **Threat**: A customer inspects API statement payloads or proof explorer data to view counterparty balances, secrets, or other accounts.
- **Risk Level**: **Medium** (Privacy breach)
- **Mitigation**:
  1. **Scoped Query Filtering**: In `GET /api/accounts/statement`, transactions are queried only for accounts owned by `session.sub`. Ledger entries are filtered by:
     ```typescript
     ledgerEntries: { where: { accountId: { in: accountIds } } }
     ```
     In transfers, each party only receives their own debit or credit ledger proof row. The counterparty's resulting balance is never sent.
  2. **Projection Sanitization**: `passwordHash`, `JWT_SECRET`, and `LEDGER_HMAC_SECRET` are strictly excluded from all Prisma `select` projections.

### T8: Reverse-Proxy IP Spoofing
- **Threat**: An attacker behind a proxy sends custom `X-Forwarded-For: 8.8.8.8` headers to bypass IP-based rate limiting.
- **Risk Level**: **Medium** (Rate limit evasion)
- **Mitigation & Residual Risk**:
  - **Mitigation**: BalanceVault implements **account-level rate limiting** (5 req/min on email) alongside IP limiting. Even if an attacker spoofs arbitrary IP addresses, the target account is locked out after 5 consecutive failed attempts.
  - **Residual Risk**: When deploying behind an upstream reverse proxy (Cloudflare, AWS ALB, Nginx), the proxy must be configured to overwrite or sanitize `X-Forwarded-For`. If deployed directly to the internet without a trusted proxy, IP-level throttling can be evaded, though account-level throttling remains fully effective.

---

## 3. Residual Risks & Future Hardening Recommendations

1. **Hardware Security Modules (HSM) / Cloud KMS**:
   - *Current State*: `LEDGER_HMAC_SECRET` is stored as an environment variable in application memory.
   - *Recommendation*: For Tier-1 institutional deployments, migrate HMAC computation to AWS KMS, Google Cloud KMS, or a dedicated PKCS#11 hardware security module (HSM) to prevent memory-dump extraction.
2. **Database Connection Pooling in Serverless**:
   - *Current State*: Prisma Client connects directly to PostgreSQL.
   - *Recommendation*: When scaling to hundreds of serverless Lambdas/Edge functions, place PgBouncer (in transaction pooling mode) or Supabase Connection Pooler in front of PostgreSQL to prevent connection exhaustion.
3. **Public Ledger Anchor Publishing**:
   - *Current State*: Checkpoints are anchored within PostgreSQL in the `ledger_checkpoints` table.
   - *Recommendation*: Periodically anchor checkpoint digests to an external immutability anchor (such as a public blockchain, RFC 6962 Certificate Transparency log, or AWS QLDB) for external third-party non-repudiation.

