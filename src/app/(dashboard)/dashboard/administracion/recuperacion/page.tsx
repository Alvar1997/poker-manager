import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  MaintenanceForm,
  RecoveryRequestActions,
  RecoveryRequestForm,
} from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { getRecoveryOverview } from "@/modules/backups/recovery.service"

export const metadata = { title: "Recuperación — Poker Manager" }

export default async function RecoveryPage() {
  await requirePagePermission(
    PERMISSIONS.RECOVERY_MANAGE,
    `${ADMIN_BASE}/recuperacion`
  )
  const [o, backups] = await Promise.all([
    getRecoveryOverview(),
    prisma.backupExecution.findMany({
      where: {
        status: "SUCCESS",
        verificationStatus: "PASSED",
        prunedAt: null,
      },
      orderBy: { startedAt: "desc" },
      take: 30,
      select: { id: true, recoveryPoint: true },
    }),
  ])
  return (
    <>
      <PageHeader
        title="Recuperación protegida"
        description="Solo SUPERADMIN. Esta pantalla prepara, valida y da seguimiento: la restauración NUNCA se ejecuta desde la web ni sobrescribe la base actual."
      />
      <Card data-testid="recovery-procedure">
        <CardContent className="space-y-2 text-sm">
          <p className="font-medium">Procedimiento</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Probar el respaldo en un entorno aislado (npm run restore:test)
              hasta obtener una prueba APROBADA.
            </li>
            <li>
              Activar el modo mantenimiento (detiene escrituras de negocio).
            </li>
            <li>
              Solicitar la recuperación (motivo + contraseña) y revisar los
              datos posteriores al punto de recuperación.
            </li>
            <li>Aprobar con contraseña y la palabra RECUPERAR.</li>
            <li>
              Ejecutar en el servidor de operación: npm run recovery:execute --
              &lt;id&gt; (restaura en una base NUEVA y verifica).
            </li>
            <li>
              Cambiar la conexión según docs/DISASTER_RECOVERY_RUNBOOK.md y
              desactivar el mantenimiento.
            </li>
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Modo mantenimiento:{" "}
            <StatusBadge
              value={o.maintenance.enabled ? "DEGRADED" : "OK"}
              label={o.maintenance.enabled ? "ACTIVO" : "Inactivo"}
              testId="maintenance-status"
            />
          </CardTitle>
          {o.maintenance.changedAt ? (
            <p className="text-muted-foreground text-xs">
              Último cambio: {formatDateTime(o.maintenance.changedAt)} ·{" "}
              {o.maintenance.changedBy?.name} · {o.maintenance.reason}
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          <MaintenanceForm enabled={o.maintenance.enabled} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solicitar recuperación</CardTitle>
        </CardHeader>
        <CardContent>
          <RecoveryRequestForm
            backups={backups.map((b) => ({
              id: b.id,
              label: `${b.recoveryPoint ? formatDateTime(b.recoveryPoint) : b.id} · ${b.id}`,
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Historial de recuperaciones
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {o.requests.length === 0 ? (
            <p
              className="text-muted-foreground text-sm"
              data-testid="no-recovery-requests"
            >
              Sin solicitudes de recuperación.
            </p>
          ) : null}
          {o.requests.map((r) => (
            <div
              key={r.id}
              className="space-y-2 rounded-md border p-3 text-sm"
              data-testid="recovery-request"
            >
              <p>
                <StatusBadge value={r.status} /> ·{" "}
                {formatDateTime(r.requestedAt)} · {r.requestedBy.name}
                {r.approvedBy ? ` · aprobó ${r.approvedBy.name}` : ""}
              </p>
              <p>{r.reason}</p>
              <p className="text-muted-foreground text-xs">
                Respaldo {r.backupId} · punto{" "}
                {r.recoveryPoint ? formatDateTime(r.recoveryPoint) : "—"} ·
                validación{" "}
                {r.validation
                  ? `${r.validation.status} (${r.validation.id})`
                  : "pendiente"}
              </p>
              {r.dataAfterRecovery ? (
                <p className="text-xs" data-testid="recovery-data-after">
                  Datos posteriores al punto de recuperación:{" "}
                  {JSON.stringify(r.dataAfterRecovery)}
                </p>
              ) : null}
              {r.result ? <p className="text-xs">{r.result}</p> : null}
              <RecoveryRequestActions
                id={r.id}
                version={r.version}
                status={r.status}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}
