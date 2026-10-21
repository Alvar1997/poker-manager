import Link from "next/link"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { UrlFilters } from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  PageHeader,
  Pager,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import {
  AUDIT_MODULE_LABEL,
  AUDIT_MODULES,
} from "@/modules/audit/audit-taxonomy"
import {
  auditFiltersToQuery,
  parseAuditFilters,
} from "@/modules/audit/audit.filters"
import {
  auditFilterOptions,
  listAuditEvents,
} from "@/modules/audit/audit-query.service"
import { formatMXN } from "@/modules/cash/components/format"

export const metadata = { title: "Auditoría — Poker Manager" }

const BASE = `${ADMIN_BASE}/auditoria`

export default async function AuditPage({
  searchParams,
}: PageProps<"/dashboard/administracion/auditoria">) {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_READ, BASE)
  const raw = await searchParams
  const parsed = parseAuditFilters(raw)
  const filters = parsed.ok ? parsed.filters : { page: 1, pageSize: 50 }
  const viewer = {
    canSecurity: can(user, PERMISSIONS.AUDIT_SECURITY_READ),
    canInfrastructure: can(user, PERMISSIONS.BACKUPS_READ),
  }
  const [r, options] = await Promise.all([
    listAuditEvents(filters, viewer),
    auditFilterOptions(viewer),
  ])
  const modules = AUDIT_MODULES.filter(
    (m) =>
      (m !== "SECURITY" || viewer.canSecurity) &&
      (m !== "INFRASTRUCTURE" || viewer.canInfrastructure)
  )
  const query = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  )
  return (
    <>
      <PageHeader
        title="Auditoría"
        description="Historial de solo inserción. Nadie puede editar ni borrar eventos."
      />
      <UrlFilters
        base={BASE}
        values={query}
        fields={[
          { name: "from", label: "Desde", type: "date" },
          { name: "to", label: "Hasta", type: "date" },
          {
            name: "actorUserId",
            label: "Usuario",
            type: "select",
            options: options.users,
          },
          {
            name: "actorRole",
            label: "Rol",
            type: "select",
            options: [
              { id: "SUPERADMIN", label: "Superadmin" },
              { id: "PARTNER", label: "Socio" },
              { id: "CASHIER", label: "Cajero" },
            ],
          },
          {
            name: "module",
            label: "Módulo",
            type: "select",
            options: modules.map((m) => ({
              id: m,
              label: AUDIT_MODULE_LABEL[m],
            })),
          },
          {
            name: "action",
            label: "Evento",
            type: "select",
            options: options.actions,
          },
          { name: "sessionId", label: "Sesión (id)", type: "text" },
          { name: "playerId", label: "Jugador (id)", type: "text" },
          {
            name: "result",
            label: "Resultado",
            type: "select",
            options: [
              { id: "SUCCESS", label: "Éxito" },
              { id: "FAILURE", label: "Falla" },
              { id: "DENIED", label: "Denegado" },
            ],
          },
          {
            name: "operationId",
            label: "Identificador de operación",
            type: "text",
          },
        ]}
      />
      {!parsed.ok ? (
        <p
          className="text-destructive text-sm"
          data-testid="audit-filter-errors"
        >
          Filtros inválidos: {parsed.issues.map((i) => i.message).join("; ")}
        </p>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <Table
            head={[
              "Fecha y hora",
              "Usuario",
              "Rol",
              "Evento",
              "Módulo",
              "Entidad",
              "Sesión",
              "Mesa",
              "Jugador",
              "Resultado",
              "Importe",
            ]}
            testId="audit-table"
          >
            {r.items.map((e) => (
              <tr key={e.id} data-testid="audit-row">
                <Td>
                  <Link
                    href={`${BASE}/${e.id}${auditFiltersToQuery(filters)}`}
                    className="underline-offset-4 hover:underline"
                    data-testid="audit-row-link"
                  >
                    {formatDateTime(e.occurredAt)}
                  </Link>
                </Td>
                <Td>{e.actor?.name ?? "Sistema"}</Td>
                <Td>{e.actorRole ?? "—"}</Td>
                <Td className="font-mono text-xs">{e.action}</Td>
                <Td>{e.moduleLabel}</Td>
                <Td className="text-xs">
                  {e.entityType}
                  {e.entityId ? (
                    <span className="text-muted-foreground block">
                      {e.entityId}
                    </span>
                  ) : null}
                </Td>
                <Td>{e.session?.folio ?? "—"}</Td>
                <Td>{e.table ?? "—"}</Td>
                <Td>{e.player?.name ?? "—"}</Td>
                <Td>
                  <StatusBadge value={e.result} />
                </Td>
                <Td className="text-right tabular-nums">
                  {e.amount ? formatMXN(e.amount) : "—"}
                </Td>
              </tr>
            ))}
          </Table>
          <Pager
            base={BASE}
            query={query}
            page={r.page}
            pageSize={r.pageSize}
            total={r.total}
          />
        </CardContent>
      </Card>
    </>
  )
}
