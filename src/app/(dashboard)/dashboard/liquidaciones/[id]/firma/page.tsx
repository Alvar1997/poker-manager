import { CircleAlert, CircleCheck } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AppError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  ConfirmReturnForm,
  SettlementSignatureCapture,
} from "@/modules/settlements/components/settlement-actions"
import {
  AmountRow,
  FifoTable,
  OFFSET_LABEL,
  SETTLEMENTS_BASE,
} from "@/modules/settlements/components/settlement-ui"
import {
  getSettlementSignatureStatus,
  prepareSettlementSignatureSummary,
  type SettlementSummaryView,
} from "@/modules/settlements/settlement-signature.service"
import { sessionCashAvailable } from "@/modules/settlements/settlement.service"

import { BackLink } from "../../../sesiones/back-link"
import { loadSettlement } from "../load-settlement"

export const metadata = { title: "Firma de liquidación — Poker Manager" }

/** Resumen EXACTO que firma el jugador (preparado por el servidor). */
function SummaryCard({ s }: { s: SettlementSummaryView }) {
  return (
    <Card data-testid="settlement-signature-summary">
      <CardHeader>
        <CardTitle className="text-base">Liquidación {s.folio}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="divide-y">
          <AmountRow
            label="Jugador"
            value={s.player.name}
            testId="summary-player"
          />
          <AmountRow label="Sesión" value={s.session.folio} />
          <AmountRow label="Mesa final" value={s.table.name} />
          <AmountRow
            label="Fichas devueltas (valor nominal)"
            value={formatMXN(s.returnedNominalAmount)}
            testId="summary-returned"
            strong
          />
          <AmountRow
            label="Deuda consultada"
            value={formatMXN(s.debtBalance)}
            testId="summary-debt"
          />
          <AmountRow
            label="Decisión de compensación"
            value={OFFSET_LABEL[s.offsetDecision]}
            testId="summary-decision"
          />
          <AmountRow
            label="Compensación"
            value={formatMXN(s.offsetAmount)}
            testId="summary-offset"
          />
        </dl>
        <FifoTable rows={s.allocations} />
        <dl className="divide-y">
          <AmountRow
            label="Deuda restante"
            value={formatMXN(s.remainingDebt)}
          />
          <AmountRow
            label="Importe neto a pagar"
            value={formatMXN(s.netPayoutAmount)}
            testId="summary-net"
            strong
          />
          <AmountRow
            label="Pagos ya realizados"
            value={formatMXN(s.confirmedPayoutAmount)}
          />
          <AmountRow
            label="Previsto pendiente de pago"
            value={formatMXN(s.pendingPayoutAmount)}
          />
          <AmountRow
            label="Fecha y hora del resumen"
            value={formatDateTime(s.preparedAt)}
          />
        </dl>
        <blockquote
          className="bg-muted rounded-lg p-3 text-sm leading-relaxed"
          data-testid="declaration"
        >
          {s.declarationText}
          <span className="text-muted-foreground mt-1 block text-xs">
            Declaración versión {s.declarationVersion} · resumen versión{" "}
            {s.settlementVersion}
          </span>
        </blockquote>
      </CardContent>
    </Card>
  )
}

export default async function SettlementSignaturePage({
  params,
}: PageProps<"/dashboard/liquidaciones/[id]/firma">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SETTLEMENTS_OPERATE,
    SETTLEMENTS_BASE
  )
  const s = await loadSettlement(id)
  const back = (
    <BackLink
      href={`${SETTLEMENTS_BASE}/${id}`}
      label={`Liquidación ${s.folio}`}
    />
  )

  if (s.receivedAt)
    return (
      <div className="mx-auto max-w-xl space-y-4 pb-8">
        {back}
        <h1 className="text-xl font-semibold">Firma del jugador</h1>
        <p
          className="flex items-center gap-2 rounded-lg border p-3 text-sm"
          data-testid="settlement-received"
        >
          <CircleCheck className="size-4 text-emerald-600" aria-hidden />
          Recepción confirmada por el cajero. Comprobante disponible.
        </p>
        <Link
          href={`${SETTLEMENTS_BASE}/${id}/comprobante`}
          className={cn(buttonVariants(), "h-11 w-full")}
        >
          Ver comprobante
        </Link>
      </div>
    )

  const status = await getSettlementSignatureStatus(id)
  if (status.validSignature?.current) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pb-8">
        {back}
        <h1 className="text-xl font-semibold">Firma del jugador</h1>
        <SummaryCard s={status.validSignature.summary} />
        <Card>
          <CardContent className="space-y-3 pt-4 text-sm">
            <p
              className="flex items-center gap-2 font-medium"
              data-testid="settlement-signature-registered"
            >
              <CircleCheck className="size-4 text-emerald-600" aria-hidden />
              Firma registrada. El cajero debe confirmar la recepción de las
              fichas.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/settlements/${id}/signature-evidence`}
              alt="Firma registrada del jugador"
              className="aspect-[5/2] w-full rounded-lg border bg-white"
            />
            <p className="text-muted-foreground text-xs">
              Registró {status.validSignature.capturedBy.name} ·{" "}
              {formatDateTime(status.validSignature.signedAt)}. La firma no
              recibe fichas ni mueve dinero por sí sola.
            </p>
          </CardContent>
        </Card>
        {can(user, PERMISSIONS.SETTLEMENTS_OPERATE) ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                8 · Confirmación del cajero
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ConfirmReturnForm
                settlementId={id}
                version={s.version}
                net={status.validSignature.summary.netPayoutAmount}
                cashAvailable={await sessionCashAvailable(s.sessionId)}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    )
  }

  let prepared: Awaited<
    ReturnType<typeof prepareSettlementSignatureSummary>
  > | null = null
  let error: string | null = null
  try {
    prepared = await prepareSettlementSignatureSummary(user, id)
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
          <p className="text-muted-foreground text-sm">
            Toda liquidación requiere la firma del jugador, incluso si devuelve
            $0.
          </p>
          <SummaryCard s={prepared.summary} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                7 · Firma en este dispositivo
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SettlementSignatureCapture
                settlementId={id}
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
