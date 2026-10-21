import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import type { ReceivableView } from "@/modules/credits/receivable.service"
import type { ReceivablePaymentView } from "@/modules/credits/receivable-payment.service"

export const CREDITS_BASE = "/dashboard/creditos"

export const RECEIVABLE_STATUS_LABEL: Record<string, string> = {
  OPEN: "Pendiente",
  PARTIALLY_PAID: "Abonada",
  PAID: "Pagada",
  VOIDED: "Anulada",
}
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente de verificación",
  CONFIRMED: "Confirmado",
  REJECTED: "Rechazado",
  REVERSED: "Revertido",
}
export const METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
  CARD_CREDIT: "Tarjeta de crédito",
}
export const ORIGIN_LABEL: Record<string, string> = {
  SESSION: "En sesión",
  ADMINISTRATIVE: "Administrativo",
}

const STATUS_CLASS: Record<string, string> = {
  OPEN: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  PARTIALLY_PAID: "border-sky-500/50 text-sky-700 dark:text-sky-400",
  PAID: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  PENDING: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  CONFIRMED: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  REJECTED: "text-muted-foreground",
  REVERSED: "text-muted-foreground line-through",
}

export function StatusBadge({
  status,
  labels,
}: {
  status: string
  labels: Record<string, string>
}) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status])}
      data-testid="credit-status"
    >
      {labels[status] ?? status}
    </Badge>
  )
}

export function ReceivableList({
  items,
  showPlayer = false,
}: {
  items: ReceivableView[]
  showPlayer?: boolean
}) {
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">Sin créditos.</p>
  return (
    <ul className="space-y-2" data-testid="receivable-list">
      {items.map((r) => (
        <li key={r.id}>
          <Link href={`${CREDITS_BASE}/${r.id}`} className="block">
            <Card data-testid="receivable-row" className="hover:bg-muted/40">
              <CardContent className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    <span className="font-mono">{r.origin.purchaseFolio}</span>
                    {showPlayer ? ` · ${r.player.name}` : ""}
                  </p>
                  <StatusBadge
                    status={r.status}
                    labels={RECEIVABLE_STATUS_LABEL}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  {r.origin.table.name} · Sesión {r.origin.session.folio} ·{" "}
                  {formatDateTime(r.createdAt)} · Autorizó {r.partner.name}
                </p>
                <dl className="grid grid-cols-3 gap-2">
                  <div>
                    <dt className="text-muted-foreground text-xs">Original</dt>
                    <dd className="tabular-nums">
                      {formatMXN(r.originalAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Abonado</dt>
                    <dd className="tabular-nums">
                      {formatMXN(r.appliedAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Saldo</dt>
                    <dd
                      className="font-medium tabular-nums"
                      data-testid="receivable-balance"
                    >
                      {formatMXN(r.balance)}
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

export function PaymentList({
  items,
  showPlayer = true,
}: {
  items: ReceivablePaymentView[]
  showPlayer?: boolean
}) {
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">Sin abonos.</p>
  return (
    <ul className="space-y-2" data-testid="payment-list">
      {items.map((p) => (
        <li key={p.id}>
          <Link href={`${CREDITS_BASE}/abonos/${p.id}`} className="block">
            <Card
              data-testid="credit-payment-row"
              className="hover:bg-muted/40"
            >
              <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <p className="font-medium">
                    <span className="font-mono">{p.folio}</span> ·{" "}
                    {formatMXN(p.amount)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {showPlayer ? `${p.player.name} · ` : ""}
                    {METHOD_LABEL[p.method]} · {ORIGIN_LABEL[p.origin]}
                    {p.session ? ` ${p.session.folio}` : ""} ·{" "}
                    {formatDateTime(p.confirmedAt ?? p.createdAt)}
                  </p>
                </div>
                <StatusBadge status={p.status} labels={PAYMENT_STATUS_LABEL} />
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  )
}
