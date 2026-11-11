# BalanceVault

> **Immutable Financial Accounting & Provable Cryptographic Ledger Platform**

BalanceVault is an enterprise-grade financial core built on Next.js 15, PostgreSQL, and Prisma ORM. It combines strict double-entry balance equality, database row-level serialized concurrency, HMAC-SHA256 cryptographic sequence chaining, and periodic anchoring checkpoints with an intuitive, accessible customer dashboard and administrative control portal.

---

## Architecture Overview

BalanceVault guarantees zero balance discrepancy and immutable transaction history through multi-layered defense:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BalanceVault Architecture                       │
├────────────────────────────────────────────────────────────────────────┤
│  Client Layer (Next.js 15 App Router + React 19 + Tailwind CSS)        │
│    • Customer Dashboard: Balance, Statements, Transfer, Deposit, Withdraw│
│    • Cryptographic Proof Explorer: Hash chain inspection & verification│
│    • Admin Console: Ledger Integrity, User Management, Audit Trail     │
├────────────────────────────────────────────────────────────────────────┤
│  Edge & Application Middleware                                         │
│    • Edge-enforced JWT Cookie Sessions (`bv_session`)                  │
│    • Strict Role-Based Access Control (`ADMIN` vs `USER`)              │
│    • OWASP Security Headers (CSP, HSTS, X-Frame-Options, Permissions)  │
├────────────────────────────────────────────────────────────────────────┤
│  Core Financial & Transaction Engine                                   │
│    • Double-Entry Movement: Sum(Debits) === Sum(Credits) Invariant    │
│    • Deterministic Sorting Row-Level Locking (`SELECT FOR UPDATE`)     │
│    • Global Advisory Mutex: `pg_advisory_xact_lock` for sequence tip  │
│    • Sliding-Window Distributed Rate Limiting (PostgreSQL-backed)      │
│    • Idempotency Manager: Replay cache & 422 payload conflict guard    │
├────────────────────────────────────────────────────────────────────────┤
│  Cryptographic Verification & Checkpoint Layer                         │
│    • Continuous HMAC-SHA256 Chaining: prevHash -> entryHash            │
│    • Periodic Checkpoint Commitments anchoring chain tips              │
│    • Complete Ledger Walk & Tamper Detection Engine                   │
├────────────────────────────────────────────────────────────────────────┤
│  Persistence Layer (PostgreSQL 15+)                                    │
│    • Database-level CHECK Constraints (`balance >= 0`)                 │
│    • Normalized schema: users, accounts, transactions, ledger, audits  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

### 1. Provable Cryptographic Ledger
- **HMAC-SHA256 Linked Sequence**: Every debit and credit entry computes a tamper-evident HMAC digest linking monotonically to the preceding entry hash (`prevHash`).
- **Genesis Checkpoint**: Sequence #1 and #2 anchor the initial $1,000,000.00 Operating Treasury capitalization from the System Equity Reserve.
- **Proof Explorer**: Customers can expand any transaction in their statement to inspect raw sequence numbers, entry types (`CREDIT` vs `DEBIT`), amounts, resulting balances, and cryptographic hashes with 1-click clipboard tools.
- **Tamper Detection**: An automated verification walk traverses sequence monotonicity, hash pointers, and recomputed HMAC digests. Any manual mutation aborts the chain with diagnostic evidence.

### 2. Atomic Money Movement
- **Double-Entry Invariant**: Every transfer, deposit, and withdrawal creates balanced, simultaneous debits and credits.
- **Deadlock-Free Row Locking**: Accounts are locked in deterministic sorted order (`ORDER BY id ASC FOR UPDATE`) within ACID database transactions.
- **Concurrency Serialization**: Sequence allocation uses PostgreSQL transaction-scoped advisory locks (`pg_advisory_xact_lock(hashtext('global_ledger_sequence'))`) to guarantee strictly monotonic sequences under high concurrency.
- **Non-Optimistic UI**: Account balances and transaction histories are strictly refreshed from committed database queries after transaction confirmation.

### 3. Authentication & Access Control
- **Session Security**: Stateless, edge-verified JWTs signed with `jose` using HS256, stored in `httpOnly`, `secure` (in production), `sameSite: "lax"` cookies.
- **Password Security**: Bcrypt with 12 salt rounds; constant-time comparisons.
- **Rate Limiting**: Distributed PostgreSQL-backed sliding-window rate limiter protecting against brute-force attacks:
  - 10 attempts per minute per IP.
  - 5 attempts per minute per account email.
  - Returns standard HTTP 429 with `Retry-After` countdown headers.

### 4. Admin Management Console
- **Ledger Integrity**: On-demand cryptographic chain verification walk reporting intact status, verified entry count, and chain tip digest.
- **Checkpoint Creation**: Concurrency-safe creation of new cryptographic checkpoints anchoring verified chain tips.
- **Users & Accounts Registry**: Directory of users, roles, account numbers, balances, and account statuses (`ACTIVE`, `FROZEN`, `CLOSED`).
- **Audit Trail**: Searchable, filterable audit event logs with action prefix matching, entity filtering, and pagination.

---

## Technology Stack

- **Framework**: Next.js 15.5.29 (App Router)
- **UI Library**: React 19.3.1, Tailwind CSS 4
- **Database**: PostgreSQL 15+
- **ORM**: Prisma 6.19.3
- **Authentication**: `jose` (JWT), `bcryptjs` (Password Hashing)
- **Runtime**: Node.js 20+

---

## Getting Started

### Prerequisites
- Node.js 20.x or higher
- PostgreSQL 15 or higher (local or managed, e.g. Neon, Supabase, AWS RDS)
- npm or pnpm

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/rajeswaridonthiboyina7/balance-vault.git
cd balance-vault
npm install
```

### 2. Environment Configuration
Copy the example environment file:
```bash
cp .env.example .env
```
Configure `.env` with your parameters:
```env
# Database Connection
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/balance_vault?schema=public"

# Application Security Secrets (Minimum 32 characters in production)
JWT_SECRET="dev-jwt-super-secret-key-32-chars-long-min"
LEDGER_HMAC_SECRET="dev-ledger-hmac-secret-hash-validation-key"

# Initial Admin Bootstrap Credentials
INITIAL_ADMIN_EMAIL="admin@balancevault.local"
INITIAL_ADMIN_PASSWORD="YourSecureAdminPassword123!"
INITIAL_ADMIN_NAME="System Administrator"

# System Accounts
SYSTEM_EQUITY_ACCOUNT_NUMBER="VAULT-EQUITY-0000"
SYSTEM_TREASURY_ACCOUNT_NUMBER="VAULT-SYSTEM-0001"
```

### 3. Database Migration & Bootstrap Seed
```bash
# Run forward migrations
npx prisma migrate deploy

# Run the idempotent seed to bootstrap the genesis ledger & admin user
npm run db:seed
```

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Verification & Test Suites

BalanceVault includes a comprehensive, automated multi-stage test suite covering all operational and security invariants:

| Command | Suite Focus | Assertions |
|---|---|:---:|
| `npm run test:stage1` | Seed idempotency, Treasury balance, Genesis HMAC sequence, DB CHECK constraints | 18 / 18 PASS |
| `npm run test:stage2` | Strict RFC 5322 regex, JWT verification, distributed rate limiter, bcrypt, role auth | 16 / 16 PASS |
| `npm run test:stage3` | Deposits, withdrawals, transfers, advisory lock concurrency, ACID rollback, double-entry equality | 25 / 25 PASS |
| `npm run test:stage4` | Audit log filters, checkpoint creation, duplicate idempotency, tamper detection | 12 / 12 PASS |
| `npx tsx scripts/verify-stage6-user-flow.ts` | Complete USER workflow: registration, login, deposit, withdrawal, transfer, statements, proof isolation | 23 / 23 PASS |
| `npx tsx scripts/verify-stage6-admin-security.ts` | Admin security: 403 authorization boundary, checkpoint registry, tamper walk, zero secret leakage | 22 / 22 PASS |

To run all suites sequentially:
```bash
npm run test:stage1 && npm run test:stage2 && npm run test:stage3 && npm run test:stage4 && npx tsx scripts/verify-stage6-user-flow.ts && npx tsx scripts/verify-stage6-admin-security.ts
```

---

## Production Deployment Guide

### Deployment Checklist

1. **Database Setup**:
   - Provision a managed PostgreSQL instance with SSL enabled (`?sslmode=require`).
   - Run forward migrations: `npx prisma migrate deploy`.
   - Run bootstrap seed once: `npx tsx prisma/seed.ts`.
2. **Environment Variables**:
   - Set `NODE_ENV="production"`.
   - Set `JWT_SECRET` (generate with `openssl rand -hex 32`, min 32 chars).
   - Set `LEDGER_HMAC_SECRET` (generate with `openssl rand -hex 32`, min 32 chars).
   - Set `INITIAL_ADMIN_PASSWORD` (strong password, min 12 chars).
3. **Build & Start**:
   ```bash
   npm run build
   npm run start
   ```

### Reverse-Proxy & IP Considerations
- BalanceVault inspects `X-Forwarded-For` (first IP) and `X-Real-IP` to extract the client address.
- **Important**: When deploying behind a reverse proxy or load balancer (e.g. AWS CloudFront/ALB, Cloudflare, Nginx, Vercel), ensure your proxy is configured to strip untrusted incoming `X-Forwarded-For` headers from client requests.
- **Defense in Depth**: Even if client IP headers are spoofed, the application enforces **account-level sliding-window rate limiting** (5 attempts/min on email), preventing credential brute-force attacks.

---

## License

ISC License. Built for secure financial accounting and auditable ledgers.
