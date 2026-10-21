import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { MoneyRow } from "@/modules/closure/components/closure-ui"
import { getOutstandingChips } from "@/modules/closure/chip-circulation.service"
import { getFinancialSummary } from "@/modules/closure/closure.data"
import { formatNominal } from "@/modules/inventory/components/format"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import { listPendingPayables } from "@/modules/settlements/settlement-payout.service"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Pendientes del cierre — Poker Manager" }

export default async function ClosurePendingPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/pendientes">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/pendientes`
  )
  const session = await loadSession(id, user)
  const [f, chips, payables] = await Promise.all([
    getFinancialSummary(prisma, id),
    getOutstandingChips(id),
    listPendingPayables({ sessionId: id }),
  ])

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Obligaciones pendientes"
        current="pendientes"
        description="Nada de esto bloquea el cierre ni se convierte en movimientos de caja: sobrevive al cierre y se resuelve después con sus flujos administrativos."
      />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Deudas de jugadores
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <MoneyRow
              label="Créditos originados en la sesión"
              value={f.credits.originated}
            />
            <MoneyRow
              label="Saldo pendiente (se conserva)"
              value={f.credits.outstanding}
              strong
              testId="pending-debts"
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Pagos pendientes a jugadores
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <dl className="divide-y">
            <MoneyRow
              label="Total por pagar"
              value={payables.totals.pending}
              strong
              testId="pending-payables"
            />
            <MoneyRow
              label="Transferencias en trámite (no pagadas)"
              value={payables.totals.inTransit}
            />
          </dl>
          <ul className="divide-y text-sm">
            {payables.items.map((p) => (
              <li
                key={p.payableId}
                className="flex justify-between gap-2 py-1.5"
              >
                <Link
                  className="underline"
                  href={`/dashboard/liquidaciones/${p.settlement.id}`}
                >
                  {p.player.name} · {p.settlement.folio}
                </Link>
                <span className="tabular-nums">{formatNominal(p.pending)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Banco y terminal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <MoneyRow
              label="Transferencias recibidas verificadas"
              value={f.bank.incomingConfirmed.amount}
            />
            <MoneyRow
              label="Transferencias recibidas por verificar"
              value={f.bank.incomingPending.amount}
              testId="pending-transfers"
            />
            <MoneyRow
              label="Transferencias rechazadas"
              value={f.bank.incomingRejected.amount}
            />
            <MoneyRow
              label="Transferencias a jugadores ejecutadas"
              value={f.bank.outgoingExecuted}
            />
            <MoneyRow
              label="Transferencias a jugadores en trámite"
              value={f.bank.outgoingPending}
            />
            <MoneyRow
              label="Depósitos de efectivo por verificar"
              value={f.bank.depositsPending.amount}
            />
            <MoneyRow
              label="Cobros aprobados con terminal (sesión)"
              value={f.card.approvedInSession}
            />
            <MoneyRow
              label="Terminal por liquidar (global)"
              value={f.card.clearingGlobal}
              hint="El depósito posterior no es otro ingreso."
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Fichas pendientes de retorno
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <dl className="divide-y">
            <MoneyRow
              label="Entregadas en la sesión"
              value={chips.session.delivered}
            />
            <MoneyRow
              label="Devueltas en la sesión"
              value={chips.session.returned}
            />
            <MoneyRow
              label="No retornadas (sesión)"
              value={chips.session.netNotReturned}
              strong
              testId="pending-chips-session"
            />
            <MoneyRow
              label="Circulación global"
              value={chips.global.circulation}
            />
          </dl>
          <p className="text-muted-foreground text-xs">
            {chips.treatment.note}
          </p>
          {chips.attributionByPlayer.length ? (
            <div>
              <p className="text-xs font-medium">
                Atribución informativa por jugador (no prueba quién tiene las
                fichas)
              </p>
              <ul className="divide-y text-sm">
                {chips.attributionByPlayer.map((p) => (
                  <li
                    key={p.player.id}
                    className="flex justify-between gap-2 py-1"
                  >
                    <span>{p.player.name}</span>
                    <span className="tabular-nums">
                      {formatNominal(p.delivered)} − {formatNominal(p.returned)}{" "}
                      = {formatNominal(p.net)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
