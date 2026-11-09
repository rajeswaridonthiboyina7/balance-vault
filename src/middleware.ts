import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

function getValidatedJwtSecret(): Uint8Array {
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

const SESSION_COOKIE_NAME = "bv_session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Protect Admin endpoints
  if (pathname.startsWith("/api/admin") || pathname.startsWith("/admin")) {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (!token) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Authentication required for admin access" },
          { status: 401 }
        );
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }

    try {
      const secretKey = getValidatedJwtSecret();
      const { payload } = await jwtVerify(token, secretKey);
      if (payload.role !== "ADMIN") {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json(
            { error: "Forbidden: Admin privileges required" },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL("/dashboard", req.url));
      }
    } catch (err: any) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Invalid or expired session token" },
          { status: 401 }
        );
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/admin/:path*", "/admin/:path*"],
};
