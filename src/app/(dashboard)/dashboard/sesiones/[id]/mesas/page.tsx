import { ChevronRight } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { TableStatusButton } from "@/modules/session-tables/components/table-actions"
import { getSessionTables } from "@/modules/session-tables/session-table.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"
import { TableStatusBadge } from "../../table-ui"

export const metadata = { title: "Mesas de la sesión — Poker Manager" }

export default async function SessionTablesPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/mesas">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/mesas`
  )
  const session = await loadSession(id, user)
  const tables = await getSessionTables(id)
  const canManage =
    can(user, PERMISSIONS.SESSIONS_MANAGE) && session.status === "OPEN"

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}`}
        label={`Sesión ${session.folio}`}
      />
      <div>
        <h1 className="text-xl font-semibold">Mesas · {session.folio}</h1>
        <p className="text-muted-foreground text-sm">
          Todas las mesas comparten la caja central y el inventario de fichas.
          Abrir, cerrar o reabrir una mesa no mueve dinero ni fichas.
        </p>
      </div>
      {session.status !== "OPEN" ? (
        <p className="rounded-lg border p-3 text-sm">
          La sesión debe estar abierta para habilitar una mesa.
        </p>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {tables.map((t) => (
          <li key={t.tableId}>
            <Card data-testid="session-table-card" data-table={t.name}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <Link
                    href={`${SESSIONS_BASE}/${id}/mesas/${t.tableId}`}
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    {t.name}
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Link>
                  <TableStatusBadge status={t.status} />
                </CardTitle>
                <p className="text-muted-foreground text-xs">
                  Ciegas ${t.blinds.small} / ${t.blinds.big}
                </p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <dl className="grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-muted-foreground text-xs">Ciclo</dt>
                    <dd data-testid="table-cycle">
                      {t.currentCycle
                        ? t.currentCycle.number
                        : t.lastCycleNumber || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Jugadores activos
                    </dt>
                    <dd data-testid="table-active-players">
                      {t.activePlayers}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Última apertura
                    </dt>
                    <dd>
                      {t.lastOpenedAt ? formatDateTime(t.lastOpenedAt) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Último cierre
                    </dt>
                    <dd>
                      {t.lastClosedAt ? formatDateTime(t.lastClosedAt) : "—"}
                    </dd>
                  </div>
                </dl>
                {canManage && t.catalogActive ? (
                  <TableStatusButton
                    sessionId={id}
                    tableId={t.tableId}
                    tableName={t.name}
                    status={t.status}
                  />
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
