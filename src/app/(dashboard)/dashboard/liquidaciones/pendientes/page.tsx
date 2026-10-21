import { Wallet } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { custodyBalanceOf } from "@/modules/credits/custody.service"
import { CustodyContributionForm } from "@/modules/settlements/components/settlement-actions"
import { SETTLEMENTS_BASE } from "@/modules/settlements/components/settlement-ui"
import { listPendingPayables } from "@/modules/settlements/settlement-payout.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = {
  title: "Pagos pendientes a jugadores — Poker Manager",
}

export default async function PendingPayoutsPage() {
  const user = await requirePagePermission(
    PERMISSIONS.SETTLEMENTS_READ,
    SETTLEMENTS_BASE
  )
  const [pending, custody] = await Promise.all([
    listPendingPayables(),
    custodyBalanceOf(user.id),
  ])
  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <BackLink href={SETTLEMENTS_BASE} label="Liquidaciones" />
      <h1 className="text-xl font-semibold">Pagos pendientes a jugadores</h1>
      <Card>
        <CardContent className="grid grid-cols-3 gap-2 pt-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Por pagar</p>
            <p
              className="text-lg font-semibold tabular-nums"
              data-testid="pending-total"
            >
              {formatMXN(pending.totals.pending)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">En trámite</p>
            <p className="tabular-nums">
              {formatMXN(pending.totals.inTransit)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Jugadores</p>
            <p className="tabular-nums">{pending.totals.players}</p>
          </div>
        </CardContent>
      </Card>
      {pending.items.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Sin pagos pendientes"
          description="Todas las liquidaciones confirmadas están pagadas."
        />
      ) : (
        <ul className="space-y-2" data-testid="pending-payables">
          {pending.items.map((i) => (
            <li key={i.payableId}>
              <Link
                href={`${SETTLEMENTS_BASE}/${i.settlement.id}/pagos`}
                className="block"
              >
                <Card
                  className="hover:bg-muted/40"
                  data-testid="pending-payable-row"
                >
                  <CardContent className="space-y-1 pt-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        <span className="font-mono">{i.settlement.folio}</span>{" "}
                        · {i.player.name}
                      </p>
                      <span className="font-semibold tabular-nums">
                        {formatMXN(i.pending)}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {i.settlement.table.name} · Sesión {i.session.folio}
                      {i.session.status === "CLOSED" ? " (cerrada)" : ""} ·{" "}
                      {i.settlement.receivedAt
                        ? formatDateTime(i.settlement.receivedAt)
                        : ""}{" "}
                      · neto {formatMXN(i.netPayout)} · pagado{" "}
                      {formatMXN(i.paid)}
                      {i.inTransit !== "0.00"
                        ? ` · en trámite ${formatMXN(i.inTransit)}`
                        : ""}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {can(user, PERMISSIONS.CASH_OPERATE) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Fondos para pagos administrativos
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Después del cierre, el efectivo NO sale de la caja de la sesión
              cerrada: sale de tu custodia administrativa ({formatMXN(custody)}
              ). Si un socio te entrega efectivo real para pagar, regístralo
              aquí.
            </p>
            <CustodyContributionForm />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
