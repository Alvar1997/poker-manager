import { HandCoins } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import type { SettlementListItem } from "@/modules/settlements/settlement.service"

/**
 * Piezas de presentación del Módulo 11 (sin lógica financiera: todos los
 * importes llegan calculados por el servidor). Nunca muestran
 * denominaciones: las fichas se liquidan por valor nominal.
 */

export const SETTLEMENTS_BASE = "/dashboard/liquidaciones"

export const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador (falta firma)",
  READY_FOR_CONFIRMATION: "Firmada · falta recibir fichas",
  PENDING_PAYOUT: "Pago pendiente",
  COMPLETED: "Pagada",
  CANCELLED: "Cancelada",
  REVERSED: "Revertida",
}

const STATUS_CLASS: Record<string, string> = {
  DRAFT: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  READY_FOR_CONFIRMATION: "border-sky-500/50 text-sky-700 dark:text-sky-400",
  PENDING_PAYOUT: "border-orange-500/60 text-orange-700 dark:text-orange-400",
  COMPLETED: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  CANCELLED: "text-muted-foreground line-through",
  REVERSED: "text-muted-foreground",
}

export const OFFSET_LABEL: Record<string, string> = {
  NO_COMPENSATE: "No compensar",
  PARTIAL: "Compensar parcialmente",
  MAXIMUM: "Compensar el máximo posible",
}

export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Transferencia en trámite",
  EXECUTED: "Pagado",
  FAILED: "No realizada",
  CANCELLED: "Cancelada",
}

export const PAYOUT_FUNDING_LABEL: Record<string, string> = {
  SESSION_CASH: "Efectivo · caja de la sesión",
  ADMIN_CUSTODY: "Efectivo · custodia administrativa",
  BANK: "Transferencia bancaria",
}

export const PARTICIPATION_LABEL: Record<string, string> = {
  ACTIVE: "Jugando",
  TRANSFERRED: "Cambió de mesa",
  SETTLING: "En liquidación (falta pagar)",
  SETTLED: "Liquidado",
}

export function SettlementStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status])}
      data-testid="settlement-status"
    >
      {SETTLEMENT_STATUS_LABEL[status] ?? status}
    </Badge>
  )
}

/** Renglón etiqueta → importe (alineado, tabular). */
export function AmountRow({
  label,
  value,
  testId,
  strong = false,
}: {
  label: string
  value: string
  testId?: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn(
          "text-right tabular-nums",
          strong && "text-lg font-semibold"
        )}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  )
}

export type FifoRow = {
  order: number
  purchaseFolio: string
  tableName: string
  sessionFolio?: string
  amount: string
  balanceAfter?: string
}

/** Distribución FIFO (automática, no editable): de la deuda más antigua a la más reciente. */
export function FifoTable({ rows }: { rows: FifoRow[] }) {
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground text-sm" data-testid="fifo-empty">
        Sin compensación: la deuda del jugador queda igual.
      </p>
    )
  return (
    <ol className="divide-y rounded-lg border" data-testid="fifo-allocations">
      {rows.map((r) => (
        <li
          key={`${r.order}-${r.purchaseFolio}`}
          className="flex items-baseline justify-between gap-2 p-2 text-sm"
          data-testid="fifo-row"
        >
          <span>
            {r.order}. <span className="font-mono">{r.purchaseFolio}</span>
            <span className="text-muted-foreground">
              {" "}
              · {r.tableName}
              {r.sessionFolio ? ` · ${r.sessionFolio}` : ""}
            </span>
          </span>
          <span className="text-right tabular-nums">
            {formatMXN(r.amount)}
            {r.balanceAfter !== undefined ? (
              <span className="text-muted-foreground block text-xs">
                resta {formatMXN(r.balanceAfter)}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function SettlementList({ items }: { items: SettlementListItem[] }) {
  if (items.length === 0)
    return (
      <EmptyState
        icon={HandCoins}
        title="Sin liquidaciones"
        description="Liquida a un jugador desde la lista de jugadores activos de su mesa."
      />
    )
  return (
    <ul className="space-y-2" data-testid="settlement-list">
      {items.map((s) => (
        <li key={s.id}>
          <Link href={`${SETTLEMENTS_BASE}/${s.id}`} className="block">
            <Card className="hover:bg-muted/40" data-testid="settlement-row">
              <CardContent className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    <span className="font-mono">{s.folio}</span> ·{" "}
                    {s.player.name}
                  </p>
                  <SettlementStatusBadge status={s.status} />
                </div>
                <p className="text-muted-foreground text-xs">
                  {s.table.name} · Sesión {s.session.folio} ·{" "}
                  {formatDateTime(s.receivedAt ?? s.createdAt)}
                </p>
                <dl className="grid grid-cols-3 gap-2">
                  <div>
                    <dt className="text-muted-foreground text-xs">Fichas</dt>
                    <dd className="tabular-nums">
                      {formatMXN(s.returnedNominalAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Neto</dt>
                    <dd className="tabular-nums">
                      {formatMXN(s.netPayoutAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Por pagar</dt>
                    <dd className="font-medium tabular-nums">
                      {formatMXN(s.pending)}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  )
}
