import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  hashPassword,
  signSessionToken,
  generateAccountNumber,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { Role, AccountStatus } from "@prisma/client";

// RFC 5322 standard conforming email regex
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, email, password } = body;

    // 1. Input Validation
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return NextResponse.json(
        { error: "Name must be at least 2 characters long" },
        { status: 400 }
      );
    }

    if (
      !email ||
      typeof email !== "string" ||
      !EMAIL_REGEX.test(email.trim())
    ) {
      return NextResponse.json(
        { error: "A valid email address is required (e.g. user@example.com)" },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters long" },
        { status: 400 }
      );
    }

    // 2. Strict Email Normalization
    const normalizedEmail = email.toLowerCase().trim();

    // 3. Existing User Check
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);

    // 4. Atomic Provisioning: User + Primary Account + Audit Log
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: name.trim(),
          email: normalizedEmail,
          passwordHash,
          role: Role.USER, // Enforced USER role regardless of input payload
        },
      });

      // Secure account number generation with collision retry loop
      let accountNumber = generateAccountNumber();
      let collision = await tx.account.findUnique({ where: { accountNumber } });
      let attempts = 0;
      while (collision && attempts < 5) {
        accountNumber = generateAccountNumber();
        collision = await tx.account.findUnique({ where: { accountNumber } });
        attempts++;
      }

      const account = await tx.account.create({
        data: {
          userId: user.id,
          accountNumber,
          balance: 0.0,
          currency: "USD",
          status: AccountStatus.ACTIVE,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "USER_REGISTERED",
          entity: "USER",
          entityId: user.id,
          details: `User registered with initial account ${account.accountNumber}`,
        },
      });

      return { user, account };
    });

    // 5. Session Token & Cookie
    const token = await signSessionToken({
      sub: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
    });

    const response = NextResponse.json(
      {
        message: "Registration successful",
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
        },
        account: {
          id: result.account.id,
          accountNumber: result.account.accountNumber,
          balance: result.account.balance,
          currency: result.account.currency,
          status: result.account.status,
        },
      },
      { status: 201 }
    );

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
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error during registration" },
      { status: 500 }
    );
  }
}
