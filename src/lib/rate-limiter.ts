import { prisma } from "./prisma";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * PostgreSQL-backed sliding-window rate limiter designed for serverless environments.
 * Tracks attempts across distributed instances without in-memory state loss.
 *
 * @param key Unique identifier (e.g. `login:ip:127.0.0.1` or `login:account:user@example.com`)
 * @param limit Maximum allowed attempts within window
 * @param windowSeconds Window duration in seconds
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = new Date();
  const resetTime = new Date(now.getTime() + windowSeconds * 1000);

  return prisma.$transaction(async (tx) => {
    const bucket = await tx.rateLimitBucket.findUnique({
      where: { key },
    });

    if (bucket && bucket.resetAt > now) {
      if (bucket.attempts >= limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((bucket.resetAt.getTime() - now.getTime()) / 1000)
        );
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds,
        };
      }

      const updated = await tx.rateLimitBucket.update({
        where: { key },
        data: { attempts: { increment: 1 } },
      });

      return {
        allowed: true,
        remaining: Math.max(0, limit - updated.attempts),
        retryAfterSeconds: 0,
      };
    }

    // Bucket expired or does not exist
    await tx.rateLimitBucket.upsert({
      where: { key },
      create: {
        key,
        attempts: 1,
        resetAt: resetTime,
      },
      update: {
        attempts: 1,
        resetAt: resetTime,
      },
    });

    return {
      allowed: true,
      remaining: limit - 1,
      retryAfterSeconds: 0,
    };
  });
}

/**
 * Resets rate limit record (e.g. after successful login)
 */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    await prisma.rateLimitBucket.delete({ where: { key } });
  } catch {
    // Record might already be deleted or expired
  }
}
