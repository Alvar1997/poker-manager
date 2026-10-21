import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { CustodyDepositForm } from "@/modules/credits/components/credit-actions"
import { CREDITS_BASE } from "@/modules/credits/components/credit-ui"
import {
  getCustodySummary,
  listCustodyDeposits,
  listCustodyMovements,
} from "@/modules/credits/custody.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = {
  title: "Custodia de efectivo administrativo — Poker Manager",
}

export default async function CustodyPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CREDITS_READ,
    CREDITS_BASE
  )
  const [summary, deposits, movements] = await Promise.all([
    getCustodySummary(),
    listCustodyDeposits(),
    listCustodyMovements(50),
  ])
  const holding = summary.custodians.filter((c) => c.balance !== "0.00")
  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <BackLink href={CREDITS_BASE} label="Créditos" />
      <div>
        <h1 className="text-xl font-semibold">
          Custodia de efectivo administrativo
        </h1>
        <p className="text-muted-foreground text-sm">
          Efectivo de abonos recibido fuera de sesión. No es una caja de juego
          ni pertenece a ninguna mesa; no se suma a la apertura de sesión (que
          siempre inicia en $0). Segrégalo antes del arqueo de apertura.
        </p>
      </div>
      <Card>
        <CardContent>
          <p className="text-muted-foreground text-xs">Pendiente de depósito</p>
          <p
            className="text-2xl font-semibold tabular-nums"
            data-testid="custody-total"
          >
            {formatMXN(summary.total)}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {summary.custodians.map((c) => (
              <li key={c.custodian.id} className="flex justify-between">
                <span>{c.custodian.name}</span>
                <span className="tabular-nums">{formatMXN(c.balance)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {can(user, PERMISSIONS.CASH_OPERATE) && holding.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Registrar depósito al banco
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CustodyDepositForm
              custodians={holding.map((c) => ({
                id: c.custodian.id,
                name: c.custodian.name,
                balance: c.balance,
              }))}
            />
            <p className="text-muted-foreground mt-2 text-xs">
              Es un traslado (custodia → banco): no es un abono nuevo ni un
              ingreso adicional.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Depósitos realizados</CardTitle>
        </CardHeader>
        <CardContent>
          {deposits.length === 0 ? (
            <p className="text-muted-foreground text-sm">Ninguno todavía.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="custody-deposits">
              {deposits.map((d) => (
                <li key={d.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {d.custodian.name} · {formatDateTime(d.createdAt)}
                    {d.bankReference ? ` · ref. ${d.bankReference}` : ""} ·{" "}
                    {d.transaction.folio}
                  </span>
                  <span className="tabular-nums">{formatMXN(d.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimientos</CardTitle>
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <p className="text-muted-foreground text-sm">Sin movimientos.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="custody-movements">
              {movements.map((m) => (
                <li key={m.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {m.direction === "IN" ? "Entrada" : "Salida"} ·{" "}
                    {m.custodian?.name ?? "—"} · {m.transaction.reason} ·{" "}
                    {formatDateTime(m.createdAt)}
                  </span>
                  <span className="tabular-nums">
                    {m.direction === "IN" ? "+" : "−"}
                    {formatMXN(m.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
