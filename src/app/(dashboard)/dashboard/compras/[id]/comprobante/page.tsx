import { CircleAlert } from "lucide-react"
import { notFound } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AppError, NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { PURCHASES_BASE } from "@/modules/purchases/components/purchase-ui"
import { ReceiptActions } from "@/modules/signatures/components/signature-actions"
import {
  receiptDate,
  receiptLines,
  receiptText,
} from "@/modules/signatures/receipt.content"
import { getReceipt } from "@/modules/signatures/receipt.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Comprobante — Poker Manager" }

export default async function ReceiptPage({
  params,
}: PageProps<"/dashboard/compras/[id]/comprobante">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASES_READ,
    PURCHASES_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const back = <BackLink href={`${PURCHASES_BASE}/${id}`} label="Compra" />
  let receipt: Awaited<ReturnType<typeof getReceipt>>
  try {
    receipt = await getReceipt(id, user)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    if (e instanceof AppError && e.status < 500)
      return (
        <div className="mx-auto max-w-xl space-y-4">
          {back}
          <p
            className="flex items-start gap-2 rounded-lg border p-3 text-sm"
            role="alert"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-600"
              aria-hidden
            />
            {e.message}
          </p>
        </div>
      )
    throw e
  }
  const c = receipt.content
  const voided = receipt.status === "VOIDED"
  const showSignature =
    receipt.hasSignature && can(user, PERMISSIONS.SIGNATURES_READ)

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      {back}
      <h1 className="text-xl font-semibold">Comprobante disponible</h1>
      {/* Documento: fondo claro también en modo oscuro (igual que la imagen PNG). */}
      <Card className="bg-white text-slate-900" data-testid="receipt">
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-slate-500">
                Poker Manager · Comprobante digital
              </p>
              <p
                className="font-mono text-2xl font-semibold"
                data-testid="receipt-folio"
              >
                {c.folio}
              </p>
              <p className="text-xs text-slate-500">
                {receiptDate(c.confirmedAt)}
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border-2 px-3 py-0.5 text-xs font-medium",
                voided
                  ? "border-red-700 text-red-700"
                  : "border-emerald-700 text-emerald-700"
              )}
              data-testid="receipt-status"
            >
              {voided ? "ANULADO" : "Entregado"}
            </span>
          </div>
          <dl className="divide-y divide-slate-100 border-t border-slate-200">
            {receiptLines(c).map((l, i) => (
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
          {showSignature ? (
            <div className="space-y-1">
              <p className="text-xs text-slate-500">
                Firma del jugador (reconocimiento de crédito)
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/purchases/${id}/signature-evidence`}
                alt="Firma del jugador"
                className="aspect-[5/2] w-full rounded-lg border border-slate-200 bg-white"
                data-testid="receipt-signature"
              />
            </div>
          ) : null}
          <p className="text-xs text-slate-400">
            Ref. {c.operationReference.deliveryId} · Fichas por importe (sin
            denominaciones).
          </p>
          {voided ? (
            <p className="text-xs text-red-700">
              Anulado el{" "}
              {receipt.voidedAt ? formatDateTime(receipt.voidedAt) : ""} ·{" "}
              {receipt.voidReason} · Referencia {receipt.voidReference}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ReceiptActions
        purchaseId={id}
        folio={c.folio}
        text={receiptText(c, receipt.status)}
      />
      <p className="text-muted-foreground text-xs">
        El comprobante no se envía automáticamente: descárgalo o compártelo
        manualmente. Los pagos posteriores no modifican este comprobante.
      </p>
    </div>
  )
}
