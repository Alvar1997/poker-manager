import "server-only"

import { prisma } from "@/lib/prisma"

/**
 * Monitoreo de seguridad y accesos (Módulo 15). Reutiliza la auditoría de
 * seguridad del Módulo 01 (`AUTH_*`, cambios de rol, desactivaciones):
 * no hay una tabla paralela de eventos de seguridad. Solo SUPERADMIN.
 */
export async function getSecurityOverview(now = new Date()) {
  const since = new Date(now.getTime() - 7 * 24 * 3600_000)
  const actions = [
    "AUTH_LOGIN_FAILED",
    "AUTH_LOGIN_RATE_LIMITED",
    "AUTH_ACCESS_DENIED",
    "USER_ROLE_CHANGED",
    "USER_DEACTIVATED",
    "USER_ACTIVATED",
    "USER_PASSWORD_RESET",
    "AUTH_PASSWORD_CHANGED",
    "MAINTENANCE_ENABLED",
    "MAINTENANCE_DISABLED",
  ]
  const [counts, recent, roles, mustChange, securityIncidents] =
    await Promise.all([
      prisma.auditLog.groupBy({
        by: ["action"],
        where: { action: { in: actions }, createdAt: { gte: since } },
        _count: true,
      }),
      prisma.auditLog.findMany({
        where: { action: { in: actions } },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true,
          action: true,
          result: true,
          createdAt: true,
          entityId: true,
          actor: { select: { name: true } },
          metadata: true,
        },
      }),
      prisma.user.groupBy({ by: ["role", "isActive"], _count: true }),
      prisma.user.count({
        where: { mustChangePassword: true, isActive: true },
      }),
      prisma.operationalIncident.count({
        where: { source: "SECURITY", status: { in: ["OPEN", "IN_REVIEW"] } },
      }),
    ])
  return {
    windowDays: 7,
    counts: Object.fromEntries(counts.map((c) => [c.action, c._count])),
    recent: recent.map((r) => ({
      id: r.id,
      action: r.action,
      result: r.result,
      at: r.createdAt.toISOString(),
      entityId: r.entityId,
      actor: r.actor?.name ?? null,
      resource: (r.metadata as { resource?: string } | null)?.resource ?? null,
    })),
    users: roles.map((r) => ({
      role: r.role,
      active: r.isActive,
      count: r._count,
    })),
    mustChangePassword: mustChange,
    openSecurityIncidents: securityIncidents,
    controls: [
      "Autorización por capacidad en el servidor (matriz única, denegado por defecto).",
      "Rol y estado leídos de la base en cada request; cambios de rol, desactivación y contraseña incrementan sessionVersion (revocan sesiones).",
      "Limitador de intentos de inicio de sesión persistido en la base.",
      "Defensa CSRF en escrituras (Origin/Sec-Fetch-Site) y cookie httpOnly SameSite=Lax.",
      "Nadie cambia su propio rol; siempre al menos un SUPERADMIN activo.",
      "Evidencias privadas solo por endpoint autorizado (nunca URLs públicas).",
      "Accesos administrativos denegados abren una incidencia de seguridad.",
    ],
  }
}
