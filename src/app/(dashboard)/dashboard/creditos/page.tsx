import { Plus } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  CREDITS_BASE,
  ReceivableList,
} from "@/modules/credits/components/credit-ui"
import { getCreditsDashboard } from "@/modules/credits/receivable.service"

export const metadata = { title: "Créditos y deudas — Poker Manager" }

export default async function CreditsPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CREDITS_READ,
    CREDITS_BASE
  )
  const d = await getCreditsDashboard()
  const stat = (
    label: string,
    value: string,
    testId: string,
    hint?: string
  ) => (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
    >
      {label}
    </Link>
  )
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Créditos y deudas</h1>
          <p className="text-muted-foreground text-sm">
            Saldos derivados de compras a crédito y abonos aplicados por FIFO.
            Sin saldos a favor.
          </p>
        </div>
        {can(user, PERMISSIONS.CREDITS_OPERATE) ? (
          <Link
            href={`${CREDITS_BASE}/abonos/nuevo`}
            className={cn(buttonVariants(), "h-11 w-full sm:w-auto md:h-9")}
            data-testid="new-credit-payment"
          >
            <Plus />
            Registrar abono
          </Link>
        ) : null}
      </div>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {stat(
              "Total pendiente",
              formatMXN(d.totalOutstanding),
              "credits-total"
            )}
            {stat(
              "Jugadores con deuda",
              String(d.playersWithDebt),
              "credits-players"
            )}
            {stat(
              "Créditos pendientes",
              String(d.openReceivables),
              "credits-open"
            )}
            {stat(
              `Abonos confirmados (${d.periodDays} días)`,
              `${d.confirmedPayments.count} · ${formatMXN(d.confirmedPayments.amount)}`,
              "credits-confirmed"
            )}
            {stat(
              "Abonos por verificar",
              `${d.pendingVerification.count} · ${formatMXN(d.pendingVerification.amount)}`,
              "credits-pending",
              "Transferencias: no reducen deuda hasta verificarse."
            )}
            {stat(
              "Recibido sin aplicar",
              formatMXN(d.unappliedFunds.amount),
              "credits-unapplied",
              "Pendiente de devolución; nunca es saldo a favor."
            )}
          </dl>
        </CardContent>
      </Card>
      <nav
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        aria-label="Secciones de créditos"
      >
        {link(`${CREDITS_BASE}/jugadores`, "Jugadores con deuda")}
        {link(`${CREDITS_BASE}/administrativos`, "Abonos administrativos")}
        {link(`${CREDITS_BASE}/custodia`, "Custodia de efectivo")}
      </nav>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mayores saldos</CardTitle>
        </CardHeader>
        <CardContent>
          {d.topPlayers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nadie tiene deuda pendiente.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.topPlayers.map((p) => (
                <li key={p.player.id} className="flex justify-between gap-2">
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`${CREDITS_BASE}/jugadores/${p.player.id}`}
                  >
                    {p.player.name}
                  </Link>
                  <span className="tabular-nums">
                    {formatMXN(p.outstanding)} · desde{" "}
                    {p.oldestAt ? formatDateTime(p.oldestAt) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Deudas más antiguas</h2>
        <ReceivableList items={d.oldest} showPlayer />
      </section>
    </div>
  )
}
