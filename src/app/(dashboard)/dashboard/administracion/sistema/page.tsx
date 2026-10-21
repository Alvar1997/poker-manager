import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { getSystemHealth } from "@/modules/admin/system-health.service"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"

export const metadata = { title: "Estado del sistema — Poker Manager" }

export default async function SystemPage() {
  await requirePagePermission(
    PERMISSIONS.SYSTEM_HEALTH_READ,
    `${ADMIN_BASE}/sistema`
  )
  const h = await getSystemHealth()
  return (
    <>
      <PageHeader
        title="Estado del sistema"
        description="Comprobaciones reales y ligeras; sin secretos."
        actions={<StatusBadge value={h.overall} testId="system-overall" />}
      />
      <RefreshOnFocus generatedAt={h.checkedAt} />
      <Card>
        <CardContent>
          <ul className="space-y-2" data-testid="system-components">
            {h.components.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm"
                data-testid={`system-${c.id}`}
                data-status={c.status}
              >
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="text-muted-foreground block text-xs">
                    {c.detail}
                  </span>
                </span>
                <StatusBadge value={c.status} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Versiones</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <KeyValue label="Aplicación">
              {h.app.version}
              {h.app.commit ? ` (${h.app.commit})` : ""} · {h.app.environment}
            </KeyValue>
            <KeyValue label="Esquema de base de datos">
              {h.schema
                ? `${h.schema.latestMigration} · ${h.schema.applied} migraciones`
                : "—"}
            </KeyValue>
            <KeyValue label="Último diagnóstico de integridad">
              {h.lastIntegrity
                ? `${h.lastIntegrity.status} · ${formatDateTime(h.lastIntegrity.startedAt)}`
                : "Nunca"}
            </KeyValue>
          </dl>
        </CardContent>
      </Card>
      {h.recentErrors?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Errores recientes (24 h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {h.recentErrors.map((e) => (
                <li key={e.id} className="font-mono text-xs">
                  {formatDateTime(e.createdAt)} · {e.action}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
