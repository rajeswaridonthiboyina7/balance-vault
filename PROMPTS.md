# BalanceVault: AI-Assisted Development History & Engineering Log

This document records the actual chronological development stages, architectural iterations, technical errors encountered, and root-cause corrections during the engineering of the **BalanceVault** financial ledger platform.

---

## Stage-by-Stage Engineering Log

### Stage 1: Foundation, Seed & Double-Entry Ledger
- **Objective**: Establish PostgreSQL schema, Prisma models, database-level CHECK constraints, balanced opening capitalization ($1,000,000.00 Operating Treasury from System Equity), HMAC-SHA256 hash chaining, and Genesis checkpoint.
- **Key Files**:
  - `prisma/schema.prisma`
  - `prisma/migrations/20261109052434_init/`
  - `prisma/seed.ts`
  - `src/lib/ledger-crypto.ts`
  - `scripts/verify-stage1.ts`
- **Mistake & Correction**:
  - *Issue*: Early seed attempts allowed repeated executions to duplicate opening capitalization records and failed Treasury balance checks against ledger entries.
  - *Fix*: Made `seed.ts` strictly idempotent by inspecting `sequenceNo: 1` prior to executing the genesis transaction. Configured compound unique constraints and automated reconciliation.
- **Verification**: `npm run test:stage1` &rarr; 18/18 PASS.

---

### Stage 2: Security & Authentication System
- **Objective**: Implement secure authentication, edge session verification, strict RFC 5322 email regex, distributed sliding-window rate limiting, and role-based access control (`ADMIN` vs `USER`).
- **Key Files**:
  - `src/lib/auth.ts`
  - `src/lib/rate-limiter.ts`
  - `src/middleware.ts`
  - `src/app/api/auth/login/route.ts`
  - `src/app/api/auth/register/route.ts`
  - `scripts/verify-stage2.ts`
- **Mistake & Correction**:
  - *Issue*: In-memory rate limiting suffered state loss in serverless environments and allowed brute-force across multi-instance restarts.
  - *Fix*: Created migration `20261109054732_add_rate_limit_bucket` introducing a PostgreSQL-backed `rate_limit_buckets` table with atomic transactional upserts.
- **Verification**: `npm run test:stage2` &rarr; 16/16 PASS.

---

### Stage 3: Money Movement & Transaction Processing
- **Objective**: Build atomic Deposit, Withdrawal, and Account-to-Account Transfer endpoints with deterministic row locking, double-entry balance equality, global advisory sequence locking, and idempotency key caching.
- **Key Files**:
  - `src/lib/ledger-service.ts`
  - `src/lib/idempotency.ts`
  - `src/app/api/transactions/deposit/route.ts`
  - `src/app/api/transactions/withdraw/route.ts`
  - `src/app/api/transactions/transfer/route.ts`
  - `scripts/verify-stage3.ts`
- **Mistake & Correction**:
  - *Issue*: In early test suite runs, test teardown cleaned up test ledger entries but left the Treasury account balance column unchanged in the DB, causing a mismatch between Treasury balance and ledger sum in subsequent Stage 1 regression checks.
  - *Fix*: Added an explicit Treasury balance reconciliation step to test teardown helpers (`cleanup()`) that recomputes `balance = SUM(credits) - SUM(debits)` from remaining ledger rows.
- **Verification**: `npm run test:stage3` &rarr; 25/25 PASS.

---

### Stage 4: Verification & Audit Checkpoint System
- **Objective**: Implement complete cryptographic ledger walk (`/api/ledger/verify`), admin checkpoint creation (`/api/admin/checkpoints`) with global advisory lock serialization, and multi-field filterable audit logs (`/api/admin/audit-logs`).
- **Key Files**:
  - `src/app/api/ledger/verify/route.ts`
  - `src/app/api/admin/checkpoints/route.ts`
  - `src/app/api/admin/audit-logs/route.ts`
  - `scripts/verify-stage4.ts`
- **Mistake & Correction**:
  - *Issue*: A webpack compile error occurred (`Identifier 'NextResponse' has already been declared`) on `audit-logs/route.ts` due to an accidental duplicate code block appended during a refactor.
  - *Fix*: Completely overwrote `src/app/api/admin/audit-logs/route.ts` with a clean, single-copy file.
- **Verification**: `npm run test:stage4` &rarr; 12/12 PASS.

---

### Stage 5: Frontend & User Experience
- **Stage 5.1 (Shared Components & Auth UI)**:
  - Created `Badge.tsx`, `Modal.tsx`, `Navbar.tsx`, `/login` (with real-time 429 countdown), `/register`, and landing page (`page.tsx`).
- **Stage 5.2 (Customer Dashboard Read-Only)**:
  - Created protected `/dashboard` displaying real account balance, account number, status badges, and paginated statement history.
- **Stage 5.3 (Money Movement UI)**:
  - Added Deposit, Withdrawal, and Transfer modals to `/dashboard`.
  - Enforced client idempotency key generation (`idemp-${Date.now()}-${random}`), preserved key across network errors for safe retry, and strictly updated balances non-optimistically via backend statement refresh.
- **Stage 5.4 (Admin Console)**:
  - Created `/admin` console with three tabbed panels: Ledger Integrity (with live verify trigger and checkpoint generator), Users & Accounts directory, and Audit Trail with action prefix filter.
- **Stage 5.5 (Cryptographic Proof Explorer)**:
  - Added an inline expandable proof viewer row to the customer transaction table.
  - Displays sequence numbers, `CREDIT (+)` vs `DEBIT (-)` badges, amounts, resulting balances, and `prevHash` / `entryHash` with copy buttons.
- **Stage 5.6 (Integration Verification & Polish)**:
  - *Issue*: Clipboard copy buttons silently ignored promise rejections (`.catch(() => {})`) when executed in permission-denied browser contexts or iframes.
  - *Fix*: Updated copy handlers across `DashboardPage` and `AdminPage` to set visual state to `"Copied"` on success and `"Copy failed. Please copy manually."` on rejection without unhandled exceptions.
- **Verification**: `npm run build` &rarr; Exit 0 (all 20 static & server routes compiled).

---

### Stage 6: End-to-End Testing & Production Readiness
- **Stage 6.1 (E2E USER Workflow)**:
  - Created `scripts/verify-stage6-user-flow.ts` testing the complete user lifecycle: dual registration, password hashing verification, independent session isolation, deposit, withdrawal, transfer, statement and proof isolation, overdraft rejections, idempotency replay, and full ledger double-entry equality.
  - *Result*: 23 / 23 PASS.
- **Stage 6.2 (E2E Admin & Security)**:
  - Created `scripts/verify-stage6-admin-security.ts` testing non-admin 403 access barriers, admin authentication, baseline chain walk, checkpoint creation with advisory lock, duplicate tip handling, audit log filters, controlled tampering detection on modified amounts, safe teardown, and zero secret exposure.
  - *Result*: 22 / 22 PASS.
- **Stage 6.3 (Production Readiness Hardening)**:
  - Removed fallback admin password from `prisma/seed.ts` to enforce mandatory environment variable `INITIAL_ADMIN_PASSWORD`.
  - Added OWASP security headers to `next.config.mjs` (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy).
  - Authored complete `README.md`, `THREATS.md`, and `PROMPTS.md`.
  - Verified reverse-proxy client IP handling and documented operational limitations.

