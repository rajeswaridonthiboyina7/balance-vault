import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyPassword,
  signSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limiter";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    // 1. Basic Input Validation
    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 2. Extract Client IP
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "127.0.0.1";

    // 3. PostgreSQL-Backed Rate Limiting (Serverless Safe)
    const ipKey = `login:ip:${ip}`;
    const accountKey = `login:account:${normalizedEmail}`;

    // IP level limit: 10 attempts per minute
    const ipRateCheck = await checkRateLimit(ipKey, 10, 60);
    if (!ipRateCheck.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts from this IP. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": ipRateCheck.retryAfterSeconds.toString() },
        }
      );
    }

    // Account level limit: 5 attempts per minute
    const accountRateCheck = await checkRateLimit(accountKey, 5, 60);
    if (!accountRateCheck.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts for this account. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": accountRateCheck.retryAfterSeconds.toString() },
        }
      );
    }

    // 4. Lookup User
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
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

    if (!user) {
      // Constant-time/generic message - does not reveal email non-existence
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // 5. Authentication Succeeded: Reset Account Rate Limit
    await resetRateLimit(accountKey);

    // Record login in audit log
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "USER_LOGIN",
        entity: "USER",
        entityId: user.id,
        ipAddress: ip,
        details: "User authenticated successfully",
      },
    });

    const token = await signSessionToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    const response = NextResponse.json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      accounts: user.accounts,
    });

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error during login" },
      { status: 500 }
    );
  }
}
