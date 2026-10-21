import { PenLine, ReceiptText, ShoppingCart } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { purchaseTypeLabel } from "@/modules/purchases/purchase.math"
import type { PurchaseListItem } from "@/modules/purchases/purchase.service"

export const PURCHASES_BASE = "/dashboard/compras"

export const PURCHASE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "En preparación",
  READY_FOR_DELIVERY: "Fichas apartadas",
  CONFIRMED: "Entregada",
  CANCELLED: "Cancelada",
  REVERSED: "Revertida",
}

const STATUS_CLASS: Record<string, string> = {
  DRAFT: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  READY_FOR_DELIVERY: "border-sky-500/50 text-sky-700 dark:text-sky-400",
  CONFIRMED: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  CANCELLED: "text-muted-foreground line-through",
  REVERSED: "text-muted-foreground",
}

export const METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
  CARD_CREDIT: "Tarjeta de crédito",
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Recibido",
  APPROVED: "Aprobado",
  DECLINED: "Rechazado",
  VOIDED: "Anulado",
  CANCELLED: "Retirado",
}

export const CHANNEL_LABEL: Record<string, string> = {
  VERBAL: "Verbal",
  MESSAGE: "Mensaje",
}

export function PurchaseStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status])}
      data-testid="purchase-status"
    >
      {PURCHASE_STATUS_LABEL[status] ?? status}
    </Badge>
  )
}

const SIGNATURE_LABEL: Record<string, string> = {
  SIGNED: "Firmada",
  REQUIRED: "Requiere firma",
  NOT_REQUIRED: "Sin firma (pagada)",
}

/** Lista de compras (tarjetas, Mobile First). Los importes vienen calculados del servidor. */
export function PurchaseList({
  items,
  showTable = true,
  showPlayer = true,
}: {
  items: PurchaseListItem[]
  showTable?: boolean
  showPlayer?: boolean
}) {
  if (items.length === 0)
    return (
      <EmptyState
        icon={ShoppingCart}
        title="Sin compras"
        description="Las compras y recompras aparecerán aquí."
      />
    )
  return (
    <ul className="space-y-2" data-testid="purchase-list">
      {items.map((p) => (
        <li key={p.id}>
          <Card data-testid="purchase-row">
            <CardContent className="space-y-2 text-sm">
              <Link
                href={`${PURCHASES_BASE}/${p.id}`}
                className="hover:bg-muted/40 -m-2 block space-y-2 rounded-lg p-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    <span className="font-mono">{p.folio}</span>
                    {" · "}
                    <span data-testid="purchase-type">
                      {p.status === "CONFIRMED"
                        ? purchaseTypeLabel(p.purchaseType, p.rebuyNumber)
                        : "Sin numerar"}
                    </span>
                  </p>
                  <PurchaseStatusBadge status={p.status} />
                </div>
                <p className="text-muted-foreground text-xs">
                  {showPlayer ? `${p.player.name} · ` : ""}
                  {showTable ? `${p.table.name} · ` : ""}
                  {formatDateTime(p.confirmedAt ?? p.createdAt)}
                </p>
                <dl className="grid grid-cols-3 gap-2">
                  <div>
                    <dt className="text-muted-foreground text-xs">Importe</dt>
                    <dd className="font-medium tabular-nums">
                      {formatMXN(p.nominalAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Pagado</dt>
                    <dd className="tabular-nums">
                      {formatMXN(p.confirmedPayments)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Por cobrar
                    </dt>
                    <dd
                      className={cn(
                        "tabular-nums",
                        p.outstanding !== "0.00" && "font-medium"
                      )}
                      data-testid="purchase-outstanding"
                    >
                      {formatMXN(p.outstanding)}
                    </dd>
                  </div>
                </dl>
                <p className="text-muted-foreground text-xs">
                  {p.methods.map((m) => METHOD_LABEL[m]).join(" + ") ||
                    "Sin pagos"}
                  {p.pendingTransfers !== "0.00"
                    ? ` · Transferencia pendiente ${formatMXN(p.pendingTransfers)}`
                    : ""}
                  {p.partnerName ? ` · Autorizó ${p.partnerName}` : ""}
                  {p.status === "CONFIRMED"
                    ? ` · ${SIGNATURE_LABEL[p.signature]}`
                    : ""}
                </p>
              </Link>
              {p.status === "CONFIRMED" ? (
                <Link
                  href={`${PURCHASES_BASE}/${p.id}/comprobante`}
                  className="text-primary inline-flex min-h-11 items-center gap-1 text-xs font-medium underline-offset-4 hover:underline md:min-h-0"
                  data-testid="purchase-receipt-link"
                >
                  <ReceiptText className="size-3.5" aria-hidden="true" />
                  Comprobante
                </Link>
              ) : p.signature === "REQUIRED" &&
                (p.status === "DRAFT" || p.status === "READY_FOR_DELIVERY") ? (
                <Link
                  href={`${PURCHASES_BASE}/${p.id}/firma`}
                  className="text-primary inline-flex min-h-11 items-center gap-1 text-xs font-medium underline-offset-4 hover:underline md:min-h-0"
                >
                  <PenLine className="size-3.5" aria-hidden="true" />
                  Firma del jugador
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
