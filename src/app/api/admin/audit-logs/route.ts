import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";

/**
 * GET /api/admin/audit-logs
 * ADMIN-only endpoint that returns paginated and filterable audit logs.
 *
 * Query params:
 * - page: number (default 1)
 * - limit: number (default 20, max 100)
 * - action: string (optional, startsWith filter)
 * - entity: string (optional, exact match)
 * - actorId: string (optional, user ID)
 * - startDate: ISO string (optional)
 * - endDate: ISO string (optional)
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole([Role.ADMIN]);
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("limit") || "20", 10))
    );
    const skip = (page - 1) * limit;

    const action = searchParams.get("action");
    const entity = searchParams.get("entity");
    const actorId = searchParams.get("actorId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const where: any = {};

    if (action) {
      where.action = { startsWith: action };
    }
    if (entity) {
      where.entity = entity;
    }
    if (actorId) {
      where.actorId = actorId;
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.createdAt.lte = new Date(endDate);
      }
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
        include: {
          actor: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
            },
          },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return NextResponse.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        actorId: log.actorId,
        actorEmail: log.actor?.email ?? null,
        actorName: log.actor?.name ?? null,
        ipAddress: log.ipAddress,
        details: log.details,
        createdAt: log.createdAt,
      })),
    });
  } catch (err) {
    console.error("Audit logs query error:", err);
    return NextResponse.json(
      { error: "Internal server error querying audit logs" },
      { status: 500 }
    );
  }
}
