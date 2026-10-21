import { Plus } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  CREDITS_BASE,
  PaymentList,
  ReceivableList,
} from "@/modules/credits/components/credit-ui"
import { listPayments } from "@/modules/credits/receivable-payment.service"
import {
  getPlayerCreditSummary,
  getPlayerStatement,
} from "@/modules/credits/receivable.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Estado de cuenta — Poker Manager" }

export default async function PlayerCreditPage({
  params,
}: PageProps<"/dashboard/creditos/jugadores/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.CREDITS_READ,
    CREDITS_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const summary = await getPlayerCreditSummary(id, {
    showPhone: can(user, PERMISSIONS.PLAYERS_READ),
  }).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const [statement, payments] = await Promise.all([
    getPlayerStatement(id),
    listPayments({ playerId: id, page: 1, pageSize: 50 }),
  ])
  const open = summary.receivables.filter((r) => r.status !== "PAID")
  const paid = summary.receivables.filter((r) => r.status === "PAID")
  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <BackLink
        href={`${CREDITS_BASE}/jugadores`}
        label="Jugadores con deuda"
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1
            className="text-xl font-semibold"
            data-testid="credit-player-name"
          >
            {summary.player.name}
          </h1>
          {summary.player.phone ? (
            <p className="text-muted-foreground text-sm">
              {summary.player.phone}
            </p>
          ) : null}
        </div>
        {can(user, PERMISSIONS.CREDITS_OPERATE) &&
        summary.outstanding !== "0.00" ? (
          <Link
            href={`${CREDITS_BASE}/abonos/nuevo?playerId=${id}`}
            className={cn(buttonVariants(), "h-11 w-full sm:w-auto md:h-9")}
            data-testid="register-payment"
          >
            <Plus />
            Registrar abono
          </Link>
        ) : null}
      </div>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-xs">Deuda global</dt>
              <dd
                className="text-lg font-semibold tabular-nums"
                data-testid="player-outstanding"
              >
                {formatMXN(summary.outstanding)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Créditos otorgados
              </dt>
              <dd className="tabular-nums">
                {formatMXN(summary.totalOriginal)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Abonado</dt>
              <dd className="tabular-nums">
                {formatMXN(summary.totalApplied)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Por verificar</dt>
              <dd className="tabular-nums" data-testid="player-pending">
                {summary.pendingTransfers.count} ·{" "}
                {formatMXN(summary.pendingTransfers.amount)}
              </dd>
            </div>
          </dl>
          {summary.unappliedFunds !== "0.00" ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Recibido sin aplicar (pendiente de devolución):{" "}
              {formatMXN(summary.unappliedFunds)}. No es saldo a favor.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Créditos pendientes</h2>
        <ReceivableList items={open} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Estado de cuenta</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1 text-sm" data-testid="statement">
            {statement.lines.map((l, i) => (
              <li
                key={i}
                className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0"
              >
                <span>
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(l.at)} ·{" "}
                  </span>
                  {l.description}
                </span>
                <span className="tabular-nums">
                  {l.direction === "INCREASE" ? "+" : "−"}
                  {formatMXN(l.amount)} · saldo {formatMXN(l.balance)}
                </span>
              </li>
            ))}
          </ol>
          {statement.pending.length ? (
            <div className="mt-3 text-xs">
              <p className="font-medium">Pendientes (no cambian el saldo):</p>
              <ul>
                {statement.pending.map((p) => (
                  <li key={p.id}>
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`${CREDITS_BASE}/abonos/${p.id}`}
                    >
                      {p.folio}
                    </Link>{" "}
                    · transferencia {formatMXN(p.amount)} ·{" "}
                    {formatDateTime(p.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Historial de abonos</h2>
        <PaymentList items={payments.items} showPlayer={false} />
      </section>
      {paid.length ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Créditos pagados</h2>
          <ReceivableList items={paid} />
        </section>
      ) : null}
    </div>
  )
}
