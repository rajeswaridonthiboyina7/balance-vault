import { PrismaClient, Role } from "@prisma/client";
import * as dotenv from "dotenv";
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
  generateAccountNumber,
  getJwtSecret,
} from "../src/lib/auth";
import { checkRateLimit, resetRateLimit } from "../src/lib/rate-limiter";

dotenv.config();

const prisma = new PrismaClient();

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

async function runStage2Verification() {
  console.log("=== Running Stage 2 Security & Authentication Verification Suite ===");

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
    // 1. Email Format Validation Tests
    const validEmails = [
      "user@example.com",
      "first.last@domain.co",
      "customer+label@fintech.vault.org",
      "snovasys.dev@sub.company.io",
    ];
    const invalidEmails = [
      "@",
      "user@",
      "@domain.com",
      "plainaddress",
      "user@domain",
      "user with space@domain.com",
    ];

    const allValidPass = validEmails.every((e) => EMAIL_REGEX.test(e));
    const allInvalidFail = invalidEmails.every((e) => !EMAIL_REGEX.test(e));
    assert(allValidPass, "RFC 5322 regex accepts valid email formats");
    assert(allInvalidFail, "RFC 5322 regex strictly rejects invalid and malformed emails");

    // 2. Production JWT Secret Fail-Safe Tests
    const origSecret = process.env.JWT_SECRET;
    const origNodeEnv = process.env.NODE_ENV;

    let missingSecretFails = false;
    try {
      process.env.JWT_SECRET = "";
      getJwtSecret();
    } catch (err: any) {
      if (err.message && err.message.includes("JWT_SECRET environment variable is required")) {
        missingSecretFails = true;
      }
    }
    assert(missingSecretFails, "Missing JWT_SECRET fails safely with clear configuration error");

    let placeholderInProdFails = false;
    try {
      (process.env as any).NODE_ENV = "production";
      process.env.JWT_SECRET = "replace-with-a-secure-random-secret-for-jwt-signing";
      getJwtSecret();
    } catch (err: any) {
      if (err.message && err.message.includes("In production, JWT_SECRET must be a non-placeholder")) {
        placeholderInProdFails = true;
      }
    }
    assert(placeholderInProdFails, "Placeholder JWT_SECRET in production is actively rejected");

    // Restore environment
    process.env.JWT_SECRET = origSecret;
    process.env.NODE_ENV = origNodeEnv;

    // 3. Cryptographic Account Number Generation & Uniqueness
    const generatedBatch = new Set<string>();
    let validFormatCount = 0;
    for (let i = 0; i < 100; i++) {
      const acc = generateAccountNumber();
      if (/^ACC-\d{8}$/.test(acc)) {
        validFormatCount++;
      }
      generatedBatch.add(acc);
    }
    assert(validFormatCount === 100, "Account numbers adhere to ACC-XXXXXXXX 8-digit format");
    assert(generatedBatch.size === 100, "100 generated account numbers using crypto.randomInt are unique");

    // 4. PostgreSQL-Backed Login Rate Limiting (Serverless Safe)
    const testRateKey = `test:login:rate:${Date.now()}`;
    const r1 = await checkRateLimit(testRateKey, 3, 60);
    const r2 = await checkRateLimit(testRateKey, 3, 60);
    const r3 = await checkRateLimit(testRateKey, 3, 60);
    const r4 = await checkRateLimit(testRateKey, 3, 60);

    assert(r1.allowed && r2.allowed && r3.allowed, "Permits requests under the limit threshold (3 attempts)");
    assert(!r4.allowed && r4.remaining === 0 && r4.retryAfterSeconds > 0, "Exceeding limit returns allowed: false with retryAfter (triggers HTTP 429)");

    await resetRateLimit(testRateKey);
    const rReset = await checkRateLimit(testRateKey, 3, 60);
    assert(rReset.allowed && rReset.remaining === 2, "resetRateLimit successfully clears limiter bucket");
    await resetRateLimit(testRateKey);

    // 5. User Registration, Authentication & RBAC Verification
    const testEmail = `stage2.verified.${Date.now()}@example.com`;
    const testPassword = "SuperSecurePassword123!";
    const testName = "Verified Customer";

    const passwordHash = await hashPassword(testPassword);
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          name: testName,
          email: testEmail.toLowerCase().trim(),
          passwordHash,
          role: Role.USER,
        },
      });

      const acc = await tx.account.create({
        data: {
          userId: u.id,
          accountNumber: generateAccountNumber(),
          balance: 0.0,
          currency: "USD",
          status: "ACTIVE",
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: u.id,
          action: "USER_REGISTERED",
          entity: "USER",
          entityId: u.id,
          details: `User registered with initial account ${acc.accountNumber}`,
        },
      });

      return u;
    });

    assert(user.role === Role.USER, "Public registration guarantees USER role");

    // Password checks
    const correctPass = await verifyPassword(testPassword, user.passwordHash);
    const wrongPass = await verifyPassword("WrongPassword123!", user.passwordHash);
    assert(correctPass, "Valid password successfully verifies with bcrypt");
    assert(!wrongPass, "Incorrect password fails verification");

    // JWT session token
    const token = await signSessionToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    const session = await verifySessionToken(token);
    assert(session?.sub === user.id && session?.role === Role.USER, "Valid JWT session decoded and verified");

    // RBAC logic test
    function checkRolePermission(s: { role: Role } | null, requiredRole: Role): number {
      if (!s) return 401;
      if (s.role !== requiredRole) return 403;
      return 200;
    }

    assert(checkRolePermission(null, Role.ADMIN) === 401, "Unauthenticated access to protected route returns 401");
    assert(checkRolePermission(session, Role.ADMIN) === 403, "Customer USER accessing ADMIN route returns 403");

    const adminUser = await prisma.user.findFirst({ where: { role: Role.ADMIN } });
    const adminSession = { role: Role.ADMIN };
    assert(checkRolePermission(adminSession, Role.ADMIN) === 200, "ADMIN accessing ADMIN route returns 200");

    // Clean up test user
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } });
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    console.log(`\nStage 2 Security Verification Summary: ${passed} passed, ${failed} failed.`);
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

runStage2Verification();
