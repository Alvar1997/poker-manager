import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  TRANSACTION_TYPE_LABEL,
  WITHDRAWAL_DESTINATION_LABEL,
} from "@/modules/cash/cash.schemas"
import { getMovement } from "@/modules/cash/cash.service"
import {
  CASH_BASE,
  formatMXN,
  MOVEMENT_STATUS_LABEL,
} from "@/modules/cash/components/format"
import { ReverseButton } from "@/modules/cash/components/reverse-button"

import { BackToCash } from "../../back-link"

export const metadata = { title: "Movimiento de caja — Poker Manager" }

const REVERSIBLE = new Set([
  "CASH_CONTRIBUTION",
  "CASH_WITHDRAWAL",
  "BANK_TRANSFER_RECEIPT",
  "CASH_RECONCILIATION_ADJUSTMENT",
])

export default async function CashMovementPage({
  params,
}: PageProps<"/dashboard/caja/movimientos/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.CASH_READ,
    `${CASH_BASE}/movimientos/${id}`
  )
  const m = await getMovement(id).catch((e) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const canReverse =
    can(user, PERMISSIONS.CASH_OPERATE) &&
    m.status === "ACTIVE" &&
    REVERSIBLE.has(m.type) &&
    m.withdrawalDestination !== "SESSION_CLOSING"

  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <div>
        <dt className="text-muted-foreground text-xs">{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackToCash href={`${CASH_BASE}/movimientos`} label="Movimientos" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1
          className="font-mono text-xl font-semibold"
          data-testid="movement-folio"
        >
          {m.folio}
        </h1>
        <span className="flex gap-2">
          <Badge variant="secondary">
            {TRANSACTION_TYPE_LABEL[
              m.type as keyof typeof TRANSACTION_TYPE_LABEL
            ] ?? m.type}
          </Badge>
          <Badge variant="outline">{MOVEMENT_STATUS_LABEL[m.status]}</Badge>
        </span>
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {row(
              "Importe",
              <span className="font-medium tabular-nums">
                {formatMXN(m.amount)}
              </span>
            )}
            {row("Fecha", formatDateTime(m.createdAt))}
            {row("Registró", m.createdBy?.name ?? "Sistema")}
            {row(
              "Sesión",
              m.sessionId && <span className="font-mono">{m.sessionId}</span>
            )}
            {row("Mesa", m.table?.name)}
            {row("Jugador", m.player?.name)}
            {row("Persona", m.counterpartyName)}
            {row(
              "Destino",
              m.withdrawalDestination &&
                WITHDRAWAL_DESTINATION_LABEL[
                  m.withdrawalDestination as keyof typeof WITHDRAWAL_DESTINATION_LABEL
                ]
            )}
            {row("Motivo", m.reason)}
            {row("Notas", m.notes)}
            {row(
              "Referencia",
              m.referenceType && `${m.referenceType} ${m.referenceId ?? ""}`
            )}
            {row(
              "Revierte a",
              m.reverses && (
                <Link
                  className="font-mono underline"
                  href={`${CASH_BASE}/movimientos/${m.reverses.id}`}
                >
                  {m.reverses.folio}
                </Link>
              )
            )}
            {row(
              "Revertido por",
              m.reversedBy && (
                <Link
                  className="font-mono underline"
                  href={`${CASH_BASE}/movimientos/${m.reversedBy.id}`}
                >
                  {m.reversedBy.folio}
                </Link>
              )
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Partidas</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {m.entries.map((e, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span>
                  {e.accountName}
                  {e.scopeKey !== "GLOBAL" ? (
                    <span className="text-muted-foreground block font-mono text-xs">
                      {e.scopeKey}
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums">
                  {e.direction === "DEBIT" ? "Cargo" : "Abono"}{" "}
                  {formatMXN(e.amount)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {canReverse ? <ReverseButton id={m.id} folio={m.folio} /> : null}
    </div>
  )
}
