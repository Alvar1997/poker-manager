import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { getBackupConfig } from "@/modules/backups/backup.config"
import {
  backupAutomationStatus,
  listBackups,
} from "@/modules/backups/backup.service"
import { listRestoreValidations } from "@/modules/backups/restore.service"

export const metadata = { title: "Respaldos — Poker Manager" }

const AUTOMATION_TEXT: Record<string, string> = {
  NOT_CONFIGURED:
    "NO OPERATIVA: nunca se ha ejecutado un respaldo programado. Configura la tarea diaria (docs/BACKUP_SETUP.md).",
  ACTIVE:
    "Operativa: hubo un respaldo programado exitoso en las últimas 26 horas.",
  STALE:
    "Atrasada: el último respaldo programado exitoso tiene más de 26 horas.",
  FAILING: "Fallando: el último respaldo programado no terminó con éxito.",
}

const kb = (n: number | null) =>
  n === null ? "—" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`

export default async function BackupsPage() {
  await requirePagePermission(
    PERMISSIONS.BACKUPS_READ,
    `${ADMIN_BASE}/respaldos`
  )
  const config = getBackupConfig()
  const [status, backups, tests] = await Promise.all([
    backupAutomationStatus(),
    listBackups(1, 30),
    listRestoreValidations(10),
  ])
  return (
    <>
      <PageHeader
        title="Respaldos y pruebas de restauración"
        description="Resultados REALES. La app no ejecuta respaldos por HTTP: los corre la tarea programada (npm run backup:daily)."
      />
      <Card data-testid="backup-status">
        <CardContent className="space-y-3">
          <p>
            Respaldo automático diario:{" "}
            <StatusBadge value={status.automation} testId="backup-automation" />
          </p>
          <p className="text-sm" data-testid="backup-automation-text">
            {AUTOMATION_TEXT[status.automation]}
          </p>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <KeyValue
              label="Último respaldo exitoso"
              testId="last-backup-success"
            >
              {status.lastSuccess ? (
                <Link
                  className="underline"
                  href={`${ADMIN_BASE}/respaldos/${status.lastSuccess.id}`}
                >
                  {formatDateTime(status.lastSuccess.startedAt)}
                </Link>
              ) : (
                "Ninguno"
              )}
            </KeyValue>
            <KeyValue label="Último respaldo fallido">
              {status.lastFailure
                ? formatDateTime(status.lastFailure.startedAt)
                : "Ninguno"}
            </KeyValue>
            <KeyValue label="Última prueba de restauración">
              {tests[0]
                ? `${tests[0].status} · ${formatDateTime(tests[0].startedAt)}`
                : "Nunca"}
            </KeyValue>
          </dl>
          <div
            className="rounded-md border border-dashed p-3 text-xs"
            data-testid="backup-config"
          >
            <p className="font-medium">
              Configuración vista por la aplicación web
            </p>
            {config.configured ? (
              <p>
                Destino y clave configurados en este proceso (huella de clave{" "}
                {config.keyFingerprint}).
              </p>
            ) : (
              <p>
                Faltan (solo nombres, nunca valores):{" "}
                {config.missing.join(", ")}. La tarea programada usa sus propias
                variables; el estado de arriba se basa en los respaldos que
                realmente terminó.
              </p>
            )}
            <p>
              Prueba de restauración aislada:{" "}
              {config.restoreTestUrl
                ? "destino configurado"
                : "RESTORE_TEST_DATABASE_URL no configurada en este proceso"}
              .
            </p>
            <p>
              Retención: diarios {config.retentionDailyDays} días · mensuales{" "}
              {config.retentionMonthlyMonths} meses (parametrizable).
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historial de respaldos</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={[
              "Inicio",
              "Origen",
              "Estado",
              "Verificación",
              "Punto de recuperación",
              "Tablas / filas",
              "Evidencias",
              "Tamaño",
            ]}
            testId="backups-table"
          >
            {backups.items.map((b) => (
              <tr key={b.id}>
                <Td>
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`${ADMIN_BASE}/respaldos/${b.id}`}
                  >
                    {formatDateTime(b.startedAt)}
                  </Link>
                </Td>
                <Td>{b.trigger}</Td>
                <Td>
                  <StatusBadge value={b.status} />
                  {b.prunedAt ? (
                    <span className="text-muted-foreground block text-xs">
                      artefacto eliminado por retención
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <StatusBadge value={b.verificationStatus} />
                </Td>
                <Td>
                  {b.recoveryPoint ? formatDateTime(b.recoveryPoint) : "—"}
                </Td>
                <Td>
                  {b.tableCount ?? "—"} / {b.rowCount ?? "—"}
                </Td>
                <Td>{b.evidenceCount ?? "—"}</Td>
                <Td>{kb(b.sizeBytes)}</Td>
              </tr>
            ))}
          </Table>
          {backups.items.length === 0 ? (
            <p
              className="text-muted-foreground mt-2 text-sm"
              data-testid="no-backups"
            >
              No existe ningún respaldo registrado.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Pruebas de restauración (entorno aislado)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={[
              "Inicio",
              "Respaldo",
              "Resultado",
              "Origen",
              "Entorno limpiado",
            ]}
            testId="restore-tests-table"
          >
            {tests.map((t) => (
              <tr key={t.id}>
                <Td>{formatDateTime(t.startedAt)}</Td>
                <Td className="font-mono text-xs">{t.backupId}</Td>
                <Td>
                  <StatusBadge value={t.status} />
                </Td>
                <Td>{t.trigger}</Td>
                <Td>{t.cleanedUp ? "Sí" : "No"}</Td>
              </tr>
            ))}
          </Table>
          {tests.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">
              Ninguna prueba de restauración ejecutada todavía.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
