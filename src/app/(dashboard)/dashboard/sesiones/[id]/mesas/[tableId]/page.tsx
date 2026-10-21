import Link from "next/link"
import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { TableStatusButton } from "@/modules/session-tables/components/table-actions"
import { getSessionTableDetail } from "@/modules/session-tables/session-table.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../../back-link"
import { loadSession } from "../../../load-session"
import { TableStatusBadge } from "../../../table-ui"

export const metadata = { title: "Mesa — Poker Manager" }

export default async function SessionTablePage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/mesas/[tableId]">) {
  const { id, tableId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/mesas`
  )
  const session = await loadSession(id, user)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) notFound()
  const t = await getSessionTableDetail(id, tableId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const canManage =
    can(user, PERMISSIONS.SESSIONS_MANAGE) && session.status === "OPEN"
  const base = `${SESSIONS_BASE}/${id}/mesas/${tableId}`

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink href={`${SESSIONS_BASE}/${id}/mesas`} label="Mesas" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t.name}</h1>
        <TableStatusBadge status={t.status} />
      </div>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Ciegas</dt>
              <dd>
                ${t.blinds.small} / ${t.blinds.big}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Ciclo actual</dt>
              <dd data-testid="current-cycle">
                {t.currentCycle ? `#${t.currentCycle.number}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Abierta desde</dt>
              <dd>
                {t.currentCycle ? formatDateTime(t.currentCycle.openedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Responsable</dt>
              <dd>{t.currentCycle?.openedBy.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Jugadores activos
              </dt>
              <dd>{t.activePlayers}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Link
          href={`${base}/jugadores`}
          className={cn(buttonVariants(), "h-11 md:h-9")}
          data-testid="go-players"
        >
          Jugadores
        </Link>
        <Link
          href={`${base}/compras`}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          data-testid="go-purchases"
        >
          Compras
        </Link>
        <Link
          href={`${base}/historial`}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          data-testid="go-history"
        >
          Historial
        </Link>
        {canManage && t.catalogActive ? (
          <TableStatusButton
            sessionId={id}
            tableId={tableId}
            tableName={t.name}
            status={t.status}
          />
        ) : null}
      </div>
    </div>
  )
}
