import { HandCoins, ShoppingCart, Users } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { PURCHASES_BASE } from "@/modules/purchases/components/purchase-ui"
import {
  AddPlayerPanel,
  TransferButton,
} from "@/modules/session-tables/components/table-actions"
import { getActiveParticipants } from "@/modules/session-tables/participation.service"
import { SETTLEMENTS_BASE } from "@/modules/settlements/components/settlement-ui"
import { listSettlements } from "@/modules/settlements/settlement.service"
import {
  getSessionTableDetail,
  getSessionTables,
} from "@/modules/session-tables/session-table.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../../../back-link"
import { loadSession } from "../../../../load-session"

export const metadata = { title: "Jugadores de la mesa — Poker Manager" }

export default async function TablePlayersPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/mesas/[tableId]/jugadores">) {
  const { id, tableId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/mesas`
  )
  const session = await loadSession(id, user)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) notFound()
  const table = await getSessionTableDetail(id, tableId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const [players, tables, settling] = await Promise.all([
    getActiveParticipants(id, tableId, {
      showPhone: can(user, PERMISSIONS.PLAYERS_READ),
    }),
    getSessionTables(id),
    listSettlements({ sessionId: id, page: 1, pageSize: 100 }),
  ])
  const canSettle =
    can(user, PERMISSIONS.SETTLEMENTS_OPERATE) &&
    session.status === "OPEN" &&
    table.status === "OPEN"
  // Liquidación en curso por jugador (abre la existente en vez de crear otra).
  const inProgress = new Map(
    settling.items
      .filter(
        (s) => s.status === "DRAFT" || s.status === "READY_FOR_CONFIRMATION"
      )
      .map((s) => [s.player.id, s.id])
  )
  const canManage =
    can(user, PERMISSIONS.SESSIONS_MANAGE) && session.status === "OPEN"
  const canBuy =
    can(user, PERMISSIONS.PURCHASES_CREATE) &&
    session.status === "OPEN" &&
    table.status === "OPEN"
  const destinations = tables
    .filter((t) => t.status === "OPEN" && t.tableId !== tableId)
    .map((t) => ({ tableId: t.tableId, name: t.name }))

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/mesas/${tableId}`}
        label={table.name}
      />
      <h1 className="text-xl font-semibold">Jugadores · {table.name}</h1>

      {canManage && table.status === "OPEN" ? (
        <Card>
          <CardContent>
            <AddPlayerPanel sessionId={id} tableId={tableId} />
          </CardContent>
        </Card>
      ) : table.status !== "OPEN" ? (
        <p className="rounded-lg border p-3 text-sm">
          La mesa debe estar abierta para registrar jugadores.
        </p>
      ) : null}

      {players.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin jugadores activos"
          description="Agrega jugadores desde el directorio."
        />
      ) : (
        <ul className="space-y-2" data-testid="active-players">
          {players.map((p) => (
            <li key={p.id}>
              <Card data-testid="participant-row">
                <CardContent className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {p.player.name}
                      {p.player.nickname ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {p.player.nickname}
                        </span>
                      ) : null}
                    </p>
                    <span className="text-muted-foreground text-xs">
                      Ingresó {formatDateTime(p.joinedAt)}
                    </span>
                  </div>
                  {p.player.phone ? (
                    <p className="text-muted-foreground text-xs">
                      {p.player.phone}
                    </p>
                  ) : null}
                  {canBuy && !inProgress.has(p.player.id) ? (
                    <Link
                      href={`${PURCHASES_BASE}/nueva?participationId=${p.id}`}
                      className={cn(
                        buttonVariants(),
                        "h-11 w-full sm:w-auto md:h-9"
                      )}
                      data-testid="new-purchase-for-player"
                    >
                      <ShoppingCart />
                      Nueva compra
                    </Link>
                  ) : null}
                  {canSettle ? (
                    <Link
                      href={
                        inProgress.has(p.player.id)
                          ? `${SETTLEMENTS_BASE}/${inProgress.get(p.player.id)}`
                          : `${SETTLEMENTS_BASE}/nueva?participationId=${p.id}`
                      }
                      className={cn(
                        buttonVariants({ variant: "outline" }),
                        "h-11 w-full sm:w-auto md:h-9"
                      )}
                      data-testid="settle-player"
                    >
                      <HandCoins />
                      {inProgress.has(p.player.id)
                        ? "Liquidación en curso"
                        : "Liquidar jugador"}
                    </Link>
                  ) : null}
                  {canManage && !inProgress.has(p.player.id) ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <TransferButton
                        sessionId={id}
                        participationId={p.id}
                        playerName={p.player.name}
                        destinations={destinations}
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
