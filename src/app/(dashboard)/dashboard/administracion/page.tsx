import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import {
  ADMIN_BASE,
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { backupAutomationStatus } from "@/modules/backups/backup.service"

export const metadata = { title: "Administración — Poker Manager" }

export default async function AdminHome() {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_READ, ADMIN_BASE)
  const [
    pendingCorrections,
    approvedPending,
    openIncidents,
    critical,
    lastRun,
  ] = await Promise.all([
    prisma.correctionRequest.count({
      where: { status: { in: ["REQUESTED", "UNDER_REVIEW"] } },
    }),
    prisma.correctionRequest.count({ where: { status: "APPROVED" } }),
    prisma.operationalIncident.count({
      where: { status: { in: ["OPEN", "IN_REVIEW"] } },
    }),
    prisma.operationalIncident.count({
      where: { status: { in: ["OPEN", "IN_REVIEW"] }, severity: "CRITICAL" },
    }),
    prisma.integrityCheckRun.findFirst({
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, startedAt: true, summary: true },
    }),
  ])
  const backups = can(user, PERMISSIONS.BACKUPS_READ)
    ? await backupAutomationStatus()
    : null
  const overall =
    (lastRun?.summary as { overall?: string } | null)?.overall ?? null
  const card = (
    title: string,
    body: React.ReactNode,
    href: string,
    testId: string
  ) => (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {body}
        <LinkButton href={href}>Abrir</LinkButton>
      </CardContent>
    </Card>
  )
  return (
    <>
      <PageHeader
        title="Administración"
        description="Auditoría, correcciones excepcionales, integridad, incidencias, seguridad, respaldos y estado del sistema."
      />
      <div className="grid gap-3 md:grid-cols-2">
        {card(
          "Auditoría",
          <p>Historial inmutable de operaciones de todos los módulos.</p>,
          `${ADMIN_BASE}/auditoria`,
          "admin-card-audit"
        )}
        {card(
          "Correcciones excepcionales",
          <p>
            {pendingCorrections} por decidir · {approvedPending} aprobadas
            pendientes de ejecución real
          </p>,
          `${ADMIN_BASE}/correcciones`,
          "admin-card-corrections"
        )}
        {card(
          "Integridad",
          <p>
            Último diagnóstico:{" "}
            {lastRun ? (
              <StatusBadge value={overall ?? lastRun.status} />
            ) : (
              "nunca ejecutado"
            )}
          </p>,
          `${ADMIN_BASE}/integridad`,
          "admin-card-integrity"
        )}
        {card(
          "Incidencias",
          <p>
            {openIncidents} abiertas · {critical} críticas
          </p>,
          `${ADMIN_BASE}/incidencias`,
          "admin-card-incidents"
        )}
        {backups
          ? card(
              "Respaldos",
              <p>
                Automatización:{" "}
                <StatusBadge
                  value={backups.automation}
                  testId="admin-backup-automation"
                />
              </p>,
              `${ADMIN_BASE}/respaldos`,
              "admin-card-backups"
            )
          : null}
        {can(user, PERMISSIONS.SYSTEM_HEALTH_READ)
          ? card(
              "Estado del sistema",
              <p>Base de datos, evidencias, respaldos y tareas.</p>,
              `${ADMIN_BASE}/sistema`,
              "admin-card-system"
            )
          : null}
        {can(user, PERMISSIONS.RECOVERY_MANAGE)
          ? card(
              "Recuperación",
              <p>Procedimiento protegido (solo SUPERADMIN).</p>,
              `${ADMIN_BASE}/recuperacion`,
              "admin-card-recovery"
            )
          : null}
        {can(user, PERMISSIONS.AUDIT_SECURITY_READ)
          ? card(
              "Seguridad y accesos",
              <p>Inicios de sesión, denegaciones y cambios de rol.</p>,
              `${ADMIN_BASE}/seguridad`,
              "admin-card-security"
            )
          : null}
        {can(user, PERMISSIONS.USERS_READ)
          ? card(
              "Usuarios",
              <p>Alta, roles y desactivación (Módulo 01).</p>,
              "/dashboard/users",
              "admin-card-users"
            )
          : null}
        {card(
          "Configuración",
          <p>Catálogos y reglas (Módulo 02).</p>,
          "/dashboard/configuracion",
          "admin-card-settings"
        )}
      </div>
    </>
  )
}
