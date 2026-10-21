import { UserRound } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { NewPurchaseForm } from "@/modules/purchases/components/purchase-actions"
import { PURCHASES_BASE } from "@/modules/purchases/components/purchase-ui"
import {
  getPurchaseAvailability,
  getPurchaseContext,
} from "@/modules/purchases/purchase.service"
import { listParticipations } from "@/modules/session-tables/participation.service"
import { getActiveSession } from "@/modules/sessions/session.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Nueva compra — Poker Manager" }

export default async function NewPurchasePage({
  searchParams,
}: PageProps<"/dashboard/compras/nueva">) {
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASES_CREATE,
    PURCHASES_BASE
  )
  const sp = await searchParams
  const participationId =
    typeof sp.participationId === "string" ? sp.participationId : null

  if (participationId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(participationId)) notFound()
    const [ctx, availability] = await Promise.all([
      getPurchaseContext(participationId).catch((e: unknown) => {
        if (e instanceof NotFoundError) notFound()
        throw e
      }),
      getPurchaseAvailability(),
    ])
    const ready =
      ctx.session.status === "OPEN" &&
      ctx.tableStatus === "OPEN" &&
      ctx.participationStatus === "ACTIVE"
    return (
      <div className="mx-auto max-w-md space-y-4">
        <BackLink href={PURCHASES_BASE} label="Compras" />
        <h1 className="text-xl font-semibold">Nueva compra</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1 · Jugador y mesa</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-lg font-medium" data-testid="context-player">
              {ctx.player.name}
              {ctx.player.nickname ? ` · ${ctx.player.nickname}` : ""}
            </p>
            <p className="text-muted-foreground" data-testid="context-table">
              {ctx.table.name} · Sesión {ctx.session.folio} · {ctx.nextLabel}
            </p>
          </CardContent>
        </Card>
        {ready ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">2 · Importe</CardTitle>
            </CardHeader>
            <CardContent>
              <NewPurchaseForm
                participationId={ctx.participationId}
                available={availability.available}
              />
            </CardContent>
          </Card>
        ) : (
          <p className="rounded-lg border p-3 text-sm" role="alert">
            Para comprar, la sesión y la mesa deben estar abiertas y el jugador
            activo en esa mesa.
          </p>
        )}
      </div>
    )
  }

  // Sin contexto: elegir a un jugador activo de la sesión abierta.
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
      <BackLink href={PURCHASES_BASE} label="Compras" />
      <h1 className="text-xl font-semibold">Nueva compra</h1>
      <p className="text-muted-foreground text-sm">
        Elige al jugador. Si aún no está sentado, regístralo primero en su mesa.
      </p>
      {participants.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="Sin jugadores activos"
          description={
            session?.status === "OPEN"
              ? "Registra jugadores en una mesa abierta para venderles fichas."
              : "No hay una sesión abierta."
          }
        />
      ) : (
        <ul className="space-y-2" data-testid="purchase-participants">
          {participants.map((p) => (
            <li key={p.id}>
              <Link
                href={`${PURCHASES_BASE}/nueva?participationId=${p.id}`}
                className="hover:bg-muted/40 flex min-h-14 items-center justify-between rounded-lg border p-3 text-sm"
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
