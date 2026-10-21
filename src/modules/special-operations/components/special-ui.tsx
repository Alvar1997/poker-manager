import Link from "next/link"
import type { ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { KeyValue, StatusBadge } from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import type { PayableView } from "@/modules/special-operations/special-payout.service"

import { PayoutForm, ResolvePayoutForm } from "./special-actions"

/** Presentación del Módulo 16: solo muestra lo que calculó el servidor. */

export const PAYABLE_STATUS_LABEL: Record<string, string> = {
  OPEN: "Pendiente de pago",
  PARTIALLY_PAID: "Pagado parcialmente",
  PAID: "Pagado",
}

const PAYOUT_STATUS_LABEL: Record<string, string> = {
  PENDING: "En trámite (no pagado)",
  EXECUTED: "Pagado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
}

export function ListCard({
  href,
  title,
  subtitle,
  right,
  testId,
}: {
  href: string
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  testId?: string
}) {
  return (
    <li>
      <Link
        href={href}
        className="hover:bg-muted/50 flex min-h-14 items-start justify-between gap-3 rounded-lg border p-3"
        data-testid={testId}
      >
        <span className="min-w-0">
          <span className="block font-medium break-words">{title}</span>
          {subtitle ? (
            <span className="text-muted-foreground block text-xs break-words">
              {subtitle}
            </span>
          ) : null}
        </span>
        {right ? (
          <span className="shrink-0 text-right text-sm">{right}</span>
        ) : null}
      </Link>
    </li>
  )
}

export function EmptyState({
  children,
  testId,
}: {
  children: ReactNode
  testId?: string
}) {
  return (
    <p
      className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm"
      data-testid={testId}
    >
      {children}
    </p>
  )
}

/** Obligación con su saldo DERIVADO, sus pagos y (si procede) el formulario de pago. */
export function PayableCard({
  payable,
  canOperate,
  sessionCashAllowed,
  title = "Obligación por pagar",
}: {
  payable: PayableView
  canOperate: boolean
  sessionCashAllowed: boolean
  title?: string
}) {
  return (
    <Card data-testid="payable-card">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p>
          <StatusBadge
            value={
              payable.status === "PAID"
                ? "COMPLETED"
                : payable.status === "PARTIALLY_PAID"
                  ? "PARTIAL"
                  : "WARNING"
            }
            label={PAYABLE_STATUS_LABEL[payable.status]}
            testId="payable-status"
          />
        </p>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <KeyValue label="Beneficiario">{payable.beneficiaryName}</KeyValue>
          <KeyValue label="Importe" testId="payable-original">
            {formatMXN(payable.original)}
          </KeyValue>
          <KeyValue label="Pagado" testId="payable-paid">
            {formatMXN(payable.paid)}
          </KeyValue>
          <KeyValue label="Pendiente" testId="payable-pending">
            {formatMXN(payable.pending)}
          </KeyValue>
        </dl>
        {payable.inTransit !== "0.00" ? (
          <p
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid="payable-in-transit"
          >
            {formatMXN(payable.inTransit)} en transferencias en trámite: no
            cuentan como pagadas.
          </p>
        ) : null}
        {payable.payouts.length > 0 ? (
          <ol className="space-y-2 text-sm" data-testid="payout-list">
            {payable.payouts.map((p) => (
              <li
                key={p.id}
                className="rounded-md border p-2"
                data-testid="payout-row"
                data-status={p.status}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {p.folio} · {formatMXN(p.amount)}
                  </span>
                  <StatusBadge
                    value={
                      p.status === "EXECUTED"
                        ? "EXECUTED"
                        : p.status === "PENDING"
                          ? "WARNING"
                          : "FAILED"
                    }
                    label={PAYOUT_STATUS_LABEL[p.status]}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  {p.method === "CASH" ? "Efectivo" : "Transferencia"} ·{" "}
                  {p.funding === "ADMIN_CUSTODY"
                    ? "custodia"
                    : p.funding === "SESSION_CASH"
                      ? "caja de sesión"
                      : "banco"}{" "}
                  · {formatDateTime(p.executedAt ?? p.createdAt)}
                  {p.bankReference ? ` · ref. ${p.bankReference}` : ""}
                  {p.failureReason ? ` · ${p.failureReason}` : ""}
                </p>
                {canOperate && p.status === "PENDING" ? (
                  <div className="mt-2">
                    <ResolvePayoutForm payoutId={p.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {canOperate &&
        payable.status !== "PAID" &&
        payable.available !== "0.00" ? (
          <PayoutForm
            payableId={payable.id}
            available={payable.available}
            sessionCashAllowed={sessionCashAllowed}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

export function ReceiptsCard({
  receipts,
}: {
  receipts: { id: string; kind: string; title: string; createdAt: string }[]
}) {
  if (receipts.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Comprobantes (PNG, inmutables)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm" data-testid="special-receipts">
          {receipts.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                {r.title} ·{" "}
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(r.createdAt)}
                </span>
              </span>
              <a
                href={`/api/special-operations/receipts/${r.id}/image`}
                className="font-medium underline"
                data-testid="special-receipt-download"
              >
                Descargar PNG
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
