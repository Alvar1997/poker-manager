import { CircleAlert, UserRound } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { listParticipations } from "@/modules/session-tables/participation.service"
import { getActiveSession } from "@/modules/sessions/session.service"
import { SettlementAmountsForm } from "@/modules/settlements/components/settlement-actions"
import { SETTLEMENTS_BASE } from "@/modules/settlements/components/settlement-ui"
import { getSettlementContext } from "@/modules/settlements/settlement.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Liquidar jugador — Poker Manager" }

export default async function NewSettlementPage({
  searchParams,
}: PageProps<"/dashboard/liquidaciones/nueva">) {
  const user = await requirePagePermission(
    PERMISSIONS.SETTLEMENTS_OPERATE,
    SETTLEMENTS_BASE
  )
  const sp = await searchParams
  const participationId =
    typeof sp.participationId === "string" ? sp.participationId : null

  if (participationId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(participationId)) notFound()
    const ctx = await getSettlementContext(participationId).catch(
      (e: unknown) => {
        if (e instanceof NotFoundError) notFound()
        throw e
      }
    )
    const p = ctx.participation
    const ready =
      p.session.status === "OPEN" &&
      p.tableStatus === "OPEN" &&
      p.status === "ACTIVE"
    return (
      <div className="mx-auto max-w-md space-y-4 pb-8">
        <BackLink href={SETTLEMENTS_BASE} label="Liquidaciones" />
        <h1 className="text-xl font-semibold">Liquidar jugador</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              1 · Jugador, sesión y mesa
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-lg font-medium" data-testid="context-player">
              {p.player.name}
              {p.player.nickname ? ` · ${p.player.nickname}` : ""}
            </p>
            <p className="text-muted-foreground" data-testid="context-table">
              {p.table.name} (mesa final) · Sesión {p.session.folio} · ciclo{" "}
              {p.cycleNumber}
            </p>
          </CardContent>
        </Card>
        {ctx.activeSettlement ? (
          <p
            className="flex items-start gap-2 rounded-lg border p-3 text-sm"
            role="alert"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-600"
              aria-hidden
            />
            <span>
              Ya hay una liquidación en curso ({ctx.activeSettlement.folio}).{" "}
              <Link
                className="underline"
                href={`${SETTLEMENTS_BASE}/${ctx.activeSettlement.id}`}
              >
                Ábrela
              </Link>
              .
            </span>
          </p>
        ) : ctx.pendingPurchases.length > 0 ? (
          <p className="rounded-lg border p-3 text-sm" role="alert">
            El jugador tiene compras sin entregar (
            {ctx.pendingPurchases.map((x) => x.folio).join(", ")}): confírmalas
            o cancélalas antes de liquidar.
          </p>
        ) : !ready ? (
          <p className="rounded-lg border p-3 text-sm" role="alert">
            Para liquidar, la sesión y la mesa deben estar abiertas y el jugador
            activo en esa mesa.
          </p>
        ) : (
          <>
            {ctx.debts.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Deudas vigentes (más antigua primero)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y text-sm" data-testid="player-debts">
                    {ctx.debts.map((d) => (
                      <li
                        key={d.id}
                        className="flex justify-between gap-2 py-2"
                      >
                        <span>
                          <span className="font-mono">{d.purchaseFolio}</span>
                          <span className="text-muted-foreground block text-xs">
                            {d.tableName} · {d.sessionFolio} ·{" "}
                            {formatDateTime(d.createdAt)} · autorizó{" "}
                            {d.partnerName}
                          </span>
                        </span>
                        <span className="text-right tabular-nums">
                          {formatMXN(d.balance)}
                          <span className="text-muted-foreground block text-xs">
                            de {formatMXN(d.originalAmount)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}
            <Card>
              <CardContent className="pt-4">
                <SettlementAmountsForm
                  participationId={p.id}
                  outstanding={ctx.outstandingDebt}
                  purchased={ctx.purchasedInSession.nominal}
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    )
  }

  const session = await getActiveSession(user)
  const participants =
    session && session.status === "OPEN"
      ? await listParticipations(
          session.id,
          { status: "ACTIVE" },
          { showPhone: can(user, PERMISSIONS.PLAYERS_READ) }
        )
      : []
  return (
    <div className="mx-auto max-w-md space-y-4">
      <BackLink href={SETTLEMENTS_BASE} label="Liquidaciones" />
      <h1 className="text-xl font-semibold">Liquidar jugador</h1>
      <p className="text-muted-foreground text-sm">
        Elige al jugador activo que termina de jugar.
      </p>
      {participants.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="Sin jugadores activos"
          description={
            session?.status === "OPEN"
              ? "No hay jugadores activos en las mesas."
              : "No hay una sesión abierta."
          }
        />
      ) : (
        <ul className="space-y-2" data-testid="settlement-participants">
          {participants.map((p) => (
            <li key={p.id}>
              <Link
                href={`${SETTLEMENTS_BASE}/nueva?participationId=${p.id}`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "flex h-auto min-h-14 w-full justify-between p-3"
                )}
              >
                <span className="font-medium">{p.player.name}</span>
                <span className="text-muted-foreground">{p.table.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
