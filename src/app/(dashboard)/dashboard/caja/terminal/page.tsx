import { CreditCard } from "lucide-react"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import {
  listCardSettlements,
  listUnsettledCardPayments,
} from "@/modules/cash/card-settlement.service"
import { CardSettlementForm } from "@/modules/cash/components/card-settlement-form"
import { CASH_BASE, formatMXN } from "@/modules/cash/components/format"

import { BackToCash } from "../back-link"

export const metadata = { title: "Terminal bancaria — Poker Manager" }

export default async function CardTerminalPage() {
  const user = await requirePagePermission(PERMISSIONS.CASH_READ, CASH_BASE)
  const [pending, settlements] = await Promise.all([
    listUnsettledCardPayments(),
    listCardSettlements(),
  ])
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackToCash />
      <div>
        <h1 className="text-xl font-semibold">Terminal bancaria</h1>
        <p className="text-muted-foreground text-sm">
          Los cobros con tarjeta aprobados quedan «por liquidar» hasta que la
          terminal deposita en el banco. No son efectivo. Registrar el depósito
          no reconoce la venta otra vez. No hay comisiones configuradas: si el
          depósito es menor, la diferencia queda pendiente de conciliar.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cobros por liquidar</CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="Sin cobros por liquidar"
              description="Los cobros con terminal de compras entregadas aparecerán aquí."
            />
          ) : can(user, PERMISSIONS.CASH_OPERATE) ? (
            <CardSettlementForm payments={pending} />
          ) : (
            <ul className="space-y-1 text-sm">
              {pending.map((p) => (
                <li key={p.id}>
                  {formatMXN(p.amount)} · {p.reference.folio}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Depósitos registrados</CardTitle>
        </CardHeader>
        <CardContent>
          {settlements.length === 0 ? (
            <p className="text-muted-foreground text-sm">Ninguno todavía.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {settlements.map((s) => (
                <li key={s.id} className="rounded-lg border p-3">
                  <p className="font-medium">
                    {formatMXN(s.depositedAmount)} de {formatMXN(s.grossAmount)}{" "}
                    · {s._count.payments + s._count.receivablePayments} cobro
                    {s._count.payments + s._count.receivablePayments === 1
                      ? ""
                      : "s"}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {s.status === "RECONCILED"
                      ? "Conciliado"
                      : `Diferencia pendiente de conciliar: ${formatMXN(s.pendingDifference)}`}{" "}
                    · {s.transaction.folio} · {s.createdBy.name} ·{" "}
                    {formatDateTime(s.createdAt)}
                    {s.notes ? ` · ${s.notes}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
