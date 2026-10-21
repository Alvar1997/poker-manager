import { CircleAlert, CircleCheck } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AppError, NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { ConfirmDeliveryForm } from "@/modules/purchases/components/purchase-actions"
import {
  CHANNEL_LABEL,
  METHOD_LABEL,
  PURCHASES_BASE,
} from "@/modules/purchases/components/purchase-ui"
import { getPurchase } from "@/modules/purchases/purchase.service"
import { SignatureCapture } from "@/modules/signatures/components/signature-actions"
import {
  getSignatureStatus,
  prepareSignatureSummary,
  type SignatureSummaryView,
} from "@/modules/signatures/signature.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Firma del jugador — Poker Manager" }

function SummaryCard({ s }: { s: SignatureSummaryView }) {
  const row = (
    label: string,
    value: string,
    testId?: string,
    strong = false
  ) => (
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
  return (
    <Card data-testid="signature-summary">
      <CardHeader>
        <CardTitle className="text-base">Reconocimiento de crédito</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="divide-y">
          {row("Jugador", s.playerName, "summary-player")}
          {row("Folio de compra", s.purchaseFolio)}
          {row("Sesión", s.sessionFolio)}
          {row("Mesa", s.tableName)}
          {row(
            "Tipo",
            s.purchaseType === "INITIAL_PURCHASE"
              ? "Compra inicial"
              : `Recompra ${s.rebuyNumber}`,
            "summary-kind"
          )}
          {row(
            "Importe solicitado",
            formatMXN(s.nominalAmount),
            "summary-amount",
            true
          )}
          {s.payments.map((p, i) => (
            <div key={i}>
              {row(
                `· ${METHOD_LABEL[p.method] ?? p.method}`,
                formatMXN(p.amount)
              )}
            </div>
          ))}
          {row("Pagos confirmados", formatMXN(s.confirmedPaymentsAmount))}
          {s.pendingTransferAmount !== "0.00"
            ? row(
                "Transferencias pendientes (aún no recibidas)",
                formatMXN(s.pendingTransferAmount)
              )
            : null}
          {row(
            "Saldo a crédito",
            formatMXN(s.outstandingCreditAmount),
            "summary-credit",
            true
          )}
          {row(
            "Autorizó el crédito",
            `${s.partnerName} (${CHANNEL_LABEL[s.authorizationChannel].toLowerCase()})`,
            "summary-partner"
          )}
          {row("Fecha y hora del resumen", formatDateTime(s.preparedAt))}
        </dl>
        <blockquote
          className="bg-muted rounded-lg p-3 text-sm leading-relaxed"
          data-testid="declaration"
        >
          {s.declarationText}
          <span className="text-muted-foreground mt-1 block text-xs">
            Declaración versión {s.declarationVersion}
          </span>
        </blockquote>
      </CardContent>
    </Card>
  )
}

export default async function PurchaseSignaturePage({
  params,
}: PageProps<"/dashboard/compras/[id]/firma">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SIGNATURES_CAPTURE,
    PURCHASES_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const purchase = await getPurchase(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const back = (
    <BackLink
      href={`${PURCHASES_BASE}/${id}`}
      label={`Compra ${purchase.folio}`}
    />
  )

  if (purchase.status === "CONFIRMED")
    return (
      <div className="mx-auto max-w-xl space-y-4 pb-8">
        {back}
        <h1 className="text-xl font-semibold">Firma del jugador</h1>
        <p
          className="flex items-center gap-2 rounded-lg border p-3 text-sm"
          data-testid="signature-delivered"
        >
          <CircleCheck className="size-4 text-emerald-600" aria-hidden />
          Entrega confirmada por el cajero. Comprobante disponible.
        </p>
        <Link
          href={`${PURCHASES_BASE}/${id}/comprobante`}
          className={cn(buttonVariants(), "h-11 w-full")}
          data-testid="go-receipt"
        >
          Ver comprobante
        </Link>
      </div>
    )

  // Ya existe una firma vigente: mostrarla y dejar la entrega al cajero.
  const status = await getSignatureStatus(id)
  if (status.validSignature?.current) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pb-8">
        {back}
        <h1 className="text-xl font-semibold">Firma del jugador</h1>
        <SummaryCard s={status.validSignature.summary} />
        <Card>
          <CardContent className="space-y-3 text-sm">
            <p
              className="flex items-center gap-2 font-medium"
              data-testid="signature-registered"
            >
              <CircleCheck className="size-4 text-emerald-600" aria-hidden />
              Firma registrada. El cajero debe confirmar la entrega.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/purchases/${id}/signature-evidence`}
              alt="Firma registrada del jugador"
              className="aspect-[5/2] w-full rounded-lg border bg-white"
            />
            <p className="text-muted-foreground text-xs">
              Registró {status.validSignature.capturedBy.name} ·{" "}
              {formatDateTime(status.validSignature.signedAt)}. La firma no
              entrega fichas ni genera deuda por sí sola.
            </p>
          </CardContent>
        </Card>
        {can(user, PERMISSIONS.PURCHASES_CREATE) &&
        purchase.blockers.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Confirmación del cajero
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ConfirmDeliveryForm
                purchaseId={id}
                version={purchase.version}
                blocked={false}
              />
            </CardContent>
          </Card>
        ) : (
          <Link
            href={`${PURCHASES_BASE}/${id}`}
            className={cn(buttonVariants(), "h-11 w-full")}
          >
            Volver a la compra
          </Link>
        )}
      </div>
    )
  }

  let prepared: Awaited<ReturnType<typeof prepareSignatureSummary>> | null =
    null
  let error: string | null = null
  try {
    prepared = await prepareSignatureSummary(user, id)
  } catch (e) {
    if (e instanceof AppError && e.status < 500) error = e.message
    else throw e
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      {back}
      <h1 className="text-xl font-semibold">Firma del jugador</h1>
      {error || !prepared ? (
        <p
          className="flex items-start gap-2 rounded-lg border p-3 text-sm"
          role="alert"
          data-testid="signature-unavailable"
        >
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600"
            aria-hidden
          />
          {error}
        </p>
      ) : (
        <>
          <SummaryCard s={prepared.summary} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Firma en este dispositivo
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SignatureCapture
                purchaseId={id}
                snapshotId={prepared.summary.snapshotId}
                payloadHash={prepared.summary.payloadHash}
              />
            </CardContent>
          </Card>
          <p className="text-muted-foreground text-xs">
            La firma es evidencia operativa de aceptación de este resumen; no es
            una firma electrónica avanzada ni verifica la identidad.
          </p>
        </>
      )}
    </div>
  )
}
