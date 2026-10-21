import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  creditReceiptLines,
  creditReceiptText,
} from "@/modules/credits/credit-receipt.content"
import { getCreditReceipt } from "@/modules/credits/credit-receipt.service"
import {
  ReversePaymentButton,
  VerifyTransferButton,
} from "@/modules/credits/components/credit-actions"
import {
  CREDITS_BASE,
  METHOD_LABEL,
  ORIGIN_LABEL,
  PAYMENT_STATUS_LABEL,
  StatusBadge,
} from "@/modules/credits/components/credit-ui"
import { getPayment } from "@/modules/credits/receivable-payment.service"
import { ReceiptActions } from "@/modules/signatures/components/signature-actions"
import { receiptDate } from "@/modules/signatures/receipt.content"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Abono — Poker Manager" }

export default async function CreditPaymentPage({
  params,
}: PageProps<"/dashboard/creditos/abonos/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.CREDITS_READ,
    CREDITS_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const p = await getPayment(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const receipt = p.receipt ? await getCreditReceipt(id) : null
  const canOperate = can(user, PERMISSIONS.CREDITS_OPERATE)
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      <BackLink
        href={`${CREDITS_BASE}/jugadores/${p.player.id}`}
        label={p.player.name}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          Abono <span className="font-mono">{p.folio}</span>
        </h1>
        <StatusBadge status={p.status} labels={PAYMENT_STATUS_LABEL} />
      </div>
      {p.status === "PENDING" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Transferencia pendiente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p data-testid="pending-note">
              {formatMXN(p.amount)} anunciados
              {p.externalReference ? ` (ref. ${p.externalReference})` : ""}. La
              deuda no baja hasta verificar el ingreso en el banco.
            </p>
            {can(user, PERMISSIONS.CASH_OPERATE) ? (
              <VerifyTransferButton paymentId={p.id} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {p.status === "REJECTED" ? (
        <p className="rounded-lg border p-3 text-sm" role="alert">
          Rechazado: este cobro no redujo ninguna deuda.
        </p>
      ) : null}
      {receipt ? (
        <>
          <h2 className="text-base font-semibold">Comprobante disponible</h2>
          <Card
            className="bg-white text-slate-900"
            data-testid="credit-receipt"
          >
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-slate-500">
                    Poker Manager · Comprobante de abono
                  </p>
                  <p className="font-mono text-2xl font-semibold">
                    {receipt.content.folio}
                  </p>
                  <p className="text-xs text-slate-500">
                    {receiptDate(receipt.content.confirmedAt)}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full border-2 px-3 py-0.5 text-xs font-medium",
                    receipt.status === "VOIDED"
                      ? "border-red-700 text-red-700"
                      : "border-emerald-700 text-emerald-700"
                  )}
                  data-testid="credit-receipt-status"
                >
                  {receipt.status === "VOIDED" ? "ANULADO" : "Abono confirmado"}
                </span>
              </div>
              <dl className="divide-y divide-slate-100 border-t border-slate-200">
                {creditReceiptLines(receipt.content).map((l, i) => (
                  <div
                    key={`${i}-${l.label}`}
                    className="flex items-baseline justify-between gap-3 py-1.5"
                  >
                    <dt className="text-slate-600">{l.label}</dt>
                    <dd
                      className={cn(
                        "text-right tabular-nums",
                        l.strong && "font-semibold"
                      )}
                    >
                      {l.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {receipt.status === "VOIDED" ? (
                <p className="text-xs text-red-700">{receipt.voidReason}</p>
              ) : null}
            </CardContent>
          </Card>
          <ReceiptActions
            purchaseId={p.id}
            folio={receipt.content.folio}
            text={creditReceiptText(receipt.content, receipt.status)}
            imageUrl={`/api/credits/payments/${p.id}/receipt/image`}
            shareEventsUrl={`/api/credits/payments/${p.id}/receipt/share-events`}
            filename={`abono-${receipt.content.folio}.png`}
          />
        </>
      ) : null}
      <Card>
        <CardContent className="text-muted-foreground space-y-1 text-xs">
          <p>
            {METHOD_LABEL[p.method]} · {ORIGIN_LABEL[p.origin]}
            {p.session ? ` · sesión ${p.session.folio}` : ""}
            {p.custodian ? ` · custodia de ${p.custodian.name}` : ""}
          </p>
          <p>
            Registró {p.createdBy.name} · {formatDateTime(p.createdAt)}
            {p.confirmedBy ? ` · confirmó ${p.confirmedBy.name}` : ""}
          </p>
          {p.financialTransaction ? (
            <p>Movimiento {p.financialTransaction.folio}</p>
          ) : null}
          {p.reversal ? (
            <p>
              Revertido: {p.reversal.reason} ·{" "}
              {formatDateTime(p.reversal.createdAt)}
            </p>
          ) : null}
          <p>
            Aplicado {formatMXN(p.applied)}
            {p.unapplied !== "0.00"
              ? ` · sin aplicar (por devolver) ${formatMXN(p.unapplied)}`
              : ""}
          </p>
        </CardContent>
      </Card>
      {canOperate && p.status === "CONFIRMED" ? (
        <ReversePaymentButton paymentId={p.id} />
      ) : null}
      <Link
        href={`${CREDITS_BASE}/jugadores/${p.player.id}`}
        className="text-muted-foreground block text-sm underline-offset-4 hover:underline"
      >
        Ver estado de cuenta
      </Link>
    </div>
  )
}
