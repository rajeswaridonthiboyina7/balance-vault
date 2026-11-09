import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { prisma } from "./prisma";
import { Role } from "@prisma/client";
import { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "bv_session";

/**
 * Validates and retrieves the JWT signing secret.
 * Rejects missing secrets and prevents placeholder strings in production.
 */
export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "CONFIGURATION ERROR: JWT_SECRET environment variable is required and must not be empty."
    );
  }

  if (
    isProduction &&
    (secret.includes("replace-with") ||
      secret.includes("dev-jwt-super-secret") ||
      secret.length < 32)
  ) {
    throw new Error(
      "CRITICAL SECURITY ERROR: In production, JWT_SECRET must be a non-placeholder string at least 32 characters long."
    );
  }

  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Secure password hashing using bcrypt with 12 salt rounds
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Constant-time password verification
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Sign JWT session token valid for 24 hours
 */
export async function signSessionToken(payload: SessionPayload): Promise<string> {
  const secret = getJwtSecret();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);
}

/**
 * Verify JWT session token and extract payload
 */
export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret);
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
}

/**
 * Read and verify session from request cookies
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Require valid authenticated session; returns SessionPayload or NextResponse 401
 */
export async function requireAuth(): Promise<
  { session: SessionPayload; response?: never } | { session?: never; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      response: NextResponse.json(
        { error: "Authentication required. Session is missing or expired." },
        { status: 401 }
      ),
    };
  }
  return { session };
}

/**
 * Require authenticated session with specified role(s)
 */
export async function requireRole(allowedRoles: Role[]): Promise<
  { session: SessionPayload; response?: never } | { session?: never; response: NextResponse }
> {
  const auth = await requireAuth();
  if (auth.response) return auth;

  if (!allowedRoles.includes(auth.session.role)) {
    return {
      response: NextResponse.json(
        { error: "Forbidden. Insufficient permissions for this action." },
        { status: 403 }
      ),
    };
  }

  return { session: auth.session };
}

/**
 * Retrieve authenticated user entity from database
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  return prisma.user.findUnique({
    where: { id: session.sub },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      accounts: {
        select: {
          id: true,
          accountNumber: true,
          balance: true,
          currency: true,
          status: true,
        },
      },
    },
  });
}

/**
 * Generate a cryptographically secure customer account number (e.g. ACC-12345678)
 * Uses crypto.randomInt to prevent PRNG predictability
 */
export function generateAccountNumber(): string {
  const randomNum = crypto.randomInt(10000000, 99999999);
  return `ACC-${randomNum}`;
}
