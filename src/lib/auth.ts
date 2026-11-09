import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import * as bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { Role } from "@prisma/client";

export const SESSION_COOKIE_NAME = "bv_session";
const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-super-secret-key-32-chars-long-min";
const secretKey = new TextEncoder().encode(JWT_SECRET);

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
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secretKey);
}

/**
 * Verify JWT session token and extract payload
 */
export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey);
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
 * Generate a unique customer account number (e.g. ACC-12345678)
 */
export function generateAccountNumber(): string {
  const randomNum = Math.floor(10000000 + Math.random() * 90000000);
  return `ACC-${randomNum}`;
}

