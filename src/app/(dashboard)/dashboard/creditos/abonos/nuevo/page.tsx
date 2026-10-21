import { Users } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatMXN } from "@/modules/cash/components/format"
import { NewCreditPaymentForm } from "@/modules/credits/components/credit-actions"
import { CREDITS_BASE } from "@/modules/credits/components/credit-ui"
import { openSessionForPayments } from "@/modules/credits/receivable-payment.service"
import {
  getPlayerCreditSummary,
  listPlayersWithDebt,
} from "@/modules/credits/receivable.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Registrar abono — Poker Manager" }

export default async function NewCreditPaymentPage({
  searchParams,
}: PageProps<"/dashboard/creditos/abonos/nuevo">) {
  await requirePagePermission(PERMISSIONS.CREDITS_OPERATE, CREDITS_BASE)
  const sp = await searchParams
  const playerId = typeof sp.playerId === "string" ? sp.playerId : null
  if (!playerId) {
    const players = await listPlayersWithDebt()
    return (
      <div className="mx-auto max-w-md space-y-4">
        <BackLink href={CREDITS_BASE} label="Créditos" />
        <h1 className="text-xl font-semibold">Registrar abono</h1>
        <p className="text-muted-foreground text-sm">
          Elige al jugador. No necesita estar sentado en una mesa.
        </p>
        {players.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Sin deudas pendientes"
            description="No hay jugadores con saldo por pagar."
          />
        ) : (
          <ul className="space-y-2" data-testid="payment-player-picker">
            {players.map((p) => (
              <li key={p.player.id}>
                <Link
                  href={`${CREDITS_BASE}/abonos/nuevo?playerId=${p.player.id}`}
                  className="hover:bg-muted/40 flex min-h-14 items-center justify-between rounded-lg border p-3 text-sm"
                >
                  <span className="font-medium">{p.player.name}</span>
                  <span className="tabular-nums">
                    {formatMXN(p.outstanding)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(playerId)) notFound()
  const [summary, openSession] = await Promise.all([
    getPlayerCreditSummary(playerId, { showPhone: false }).catch(
      (e: unknown) => {
        if (e instanceof NotFoundError) notFound()
        throw e
      }
    ),
    openSessionForPayments(),
  ])
  return (
    <div className="mx-auto max-w-md space-y-4 pb-8">
      <BackLink
        href={`${CREDITS_BASE}/jugadores/${playerId}`}
        label={summary.player.name}
      />
      <h1 className="text-xl font-semibold">Registrar abono</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{summary.player.name}</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.outstanding === "0.00" ? (
            <p className="text-sm" role="alert">
              Este jugador no tiene deuda pendiente: no se registran abonos ni
              saldos a favor.
            </p>
          ) : (
            <NewCreditPaymentForm
              playerId={playerId}
              outstanding={summary.outstanding}
              openSession={openSession}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
