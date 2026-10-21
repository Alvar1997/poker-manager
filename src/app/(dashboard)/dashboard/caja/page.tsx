import { Landmark, Wallet } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { getCashBoxOverview } from "@/modules/cash/cash.service"
import { CashActions } from "@/modules/cash/components/cash-nav"
import { CASH_BASE, formatMXN } from "@/modules/cash/components/format"
import { NoSessionNotice } from "@/modules/cash/components/no-session-notice"

import { MovementCard } from "./movement-card"

export const metadata = { title: "Caja central — Poker Manager" }

export default async function CashBoxPage() {
  await requirePagePermission(PERMISSIONS.CASH_READ, CASH_BASE)
  const o = await getCashBoxOverview()

  const stat = (
    label: string,
    value: string,
    testId: string,
    hint?: string
  ) => (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium tabular-nums" data-testid={testId}>
        {value}
      </dd>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          {o.cashBox?.name ?? "Caja central"}
        </h1>
        <p className="text-muted-foreground text-sm">
          Caja única para ambas mesas. Cada sesión abre con $0.00 y cierra con
          retiro total. La caja no registra gastos.
        </p>
      </div>

      {o.session ? (
        <p className="rounded-lg border p-3 text-sm" data-testid="open-session">
          Sesión abierta: <span className="font-mono">{o.session.id}</span>
        </p>
      ) : (
        <NoSessionNotice />
      )}

      <CashActions />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4" aria-hidden="true" />
              Efectivo
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {stat(
                "Efectivo de la sesión",
                o.session ? formatMXN(o.cashOnHand) : "Sin sesión",
                "cash-on-hand"
              )}
              {stat(
                "En tránsito al banco",
                formatMXN(o.cashInTransit),
                "cash-in-transit"
              )}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="size-4" aria-hidden="true" />
              Banco
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {stat(
                "Neto registrado",
                formatMXN(o.bankKnownNet),
                "bank-known-net",
                o.bankNote
              )}
              {stat(
                "Transferencias pendientes",
                `${o.flows.pendingTransfers.count} · ${formatMXN(o.flows.pendingTransfers.amount)}`,
                "pending-transfers",
                "No cuentan como cobradas hasta verificarse."
              )}
              {stat(
                "Terminal por liquidar",
                formatMXN(o.cardPendingSettlement),
                "card-pending-settlement",
                "Cobros con tarjeta aprobados que la terminal aún no deposita. No es efectivo."
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flujos registrados</CardTitle>
          <p className="text-muted-foreground text-xs">
            Entradas y salidas separadas por tipo. No representan ganancia ni
            utilidad.
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            {stat(
              "Cobros en efectivo",
              formatMXN(o.flows.cashCollections),
              "flow-cash"
            )}
            {stat(
              "Transferencias confirmadas",
              formatMXN(o.flows.bankCollectionsConfirmed),
              "flow-bank"
            )}
            {stat(
              "Pagos de liquidación",
              formatMXN(o.flows.settlementPayouts),
              "flow-settlements"
            )}
            {stat(
              "Aportaciones",
              formatMXN(o.flows.contributions),
              "flow-contributions"
            )}
            {stat(
              "Retiros",
              formatMXN(o.flows.withdrawals),
              "flow-withdrawals"
            )}
          </dl>
        </CardContent>
      </Card>

      <section className="space-y-2" aria-labelledby="recent-heading">
        <div className="flex items-center justify-between">
          <h2 id="recent-heading" className="font-medium">
            Últimos movimientos
          </h2>
          <Link href={`${CASH_BASE}/movimientos`} className="text-sm underline">
            Ver todos
          </Link>
        </div>
        {o.recentMovements.length === 0 ? (
          <EmptyState
            title="Sin movimientos"
            description="Todavía no se ha registrado ningún movimiento de dinero."
          />
        ) : (
          <ul className="space-y-2">
            {o.recentMovements.map((m) => (
              <li key={m.id}>
                <MovementCard m={m} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
