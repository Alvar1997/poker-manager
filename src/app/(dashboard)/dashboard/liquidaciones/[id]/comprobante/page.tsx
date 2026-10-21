import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AppError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { SETTLEMENTS_BASE } from "@/modules/settlements/components/settlement-ui"
import {
  settlementReceiptLines,
  settlementReceiptText,
  settlementReceiptTitle,
} from "@/modules/settlements/settlement-receipt.content"
import {
  getSettlementReceipts,
  type SettlementReceiptView,
} from "@/modules/settlements/settlement-receipt.service"
import { ReceiptActions } from "@/modules/signatures/components/signature-actions"
import { receiptDate } from "@/modules/signatures/receipt.content"

import { BackLink } from "../../../sesiones/back-link"
import { loadSettlement } from "../load-settlement"

export const metadata = { title: "Comprobante de liquidación — Poker Manager" }

function ReceiptCard({
  settlementId,
  r,
}: {
  settlementId: string
  r: SettlementReceiptView
}) {
  const c = r.content
  return (
    <div className="space-y-2">
      <Card
        className="bg-white text-slate-900"
        data-testid={`settlement-receipt-${c.kind}`}
      >
        <CardContent className="space-y-3 pt-4 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-slate-500">
                Poker Manager ·{" "}
                {c.kind === "PAYOUT"
                  ? "Anexo de pago"
                  : "Comprobante de liquidación"}
              </p>
              <p className="font-mono text-2xl font-semibold">
                {settlementReceiptTitle(c)}
              </p>
              <p className="text-xs text-slate-500">
                {receiptDate(c.issuedAt)}
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border-2 px-3 py-0.5 text-xs font-medium",
                r.status === "VOIDED"
                  ? "border-red-700 text-red-700"
                  : "border-emerald-700 text-emerald-700"
              )}
              data-testid="receipt-status"
            >
              {r.status === "VOIDED"
                ? "ANULADO"
                : c.kind === "PAYOUT"
                  ? "Pago ejecutado"
                  : c.settlementStatus === "COMPLETED"
                    ? "Pagada"
                    : "Pendiente de pago"}
            </span>
          </div>
          <dl className="divide-y divide-slate-100 border-t border-slate-200">
            {settlementReceiptLines(c).map((l, i) => (
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
          {c.kind === "RECEPTION" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/settlements/${settlementId}/signature-evidence`}
              alt="Firma del jugador"
              className="aspect-[5/2] w-full rounded-lg border bg-white"
            />
          ) : null}
          {r.status === "VOIDED" ? (
            <p className="text-xs text-red-700">{r.voidReason}</p>
          ) : null}
          {!r.intact ? (
            <p className="text-xs text-red-700" role="alert">
              El contenido no coincide con su huella registrada.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ReceiptActions
        purchaseId={settlementId}
        folio={settlementReceiptTitle(c)}
        text={settlementReceiptText(c, r.status)}
        imageUrl={`/api/settlements/${settlementId}/receipt/image?receiptId=${r.id}`}
        shareEventsUrl={`/api/settlements/${settlementId}/receipt/share-events`}
        filename={
          c.kind === "PAYOUT" && c.payout
            ? `liquidacion-${c.folio}-pago-${c.payout.sequence}.png`
            : `liquidacion-${c.folio}.png`
        }
      />
    </div>
  )
}

export default async function SettlementReceiptPage({
  params,
}: PageProps<"/dashboard/liquidaciones/[id]/comprobante">) {
  const { id } = await params
  await requirePagePermission(PERMISSIONS.SETTLEMENTS_READ, SETTLEMENTS_BASE)
  const s = await loadSettlement(id)
  let receipts: Awaited<ReturnType<typeof getSettlementReceipts>> | null = null
  let error: string | null = null
  try {
    receipts = await getSettlementReceipts(id)
  } catch (e) {
    if (e instanceof AppError && e.status < 500) error = e.message
    else throw e
  }
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      <BackLink
        href={`${SETTLEMENTS_BASE}/${id}`}
        label={`Liquidación ${s.folio}`}
      />
      <h1 className="text-xl font-semibold">Comprobante</h1>
      {!receipts ? (
        <p className="rounded-lg border p-3 text-sm" role="alert">
          {error}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Fotografía al recibir las fichas: distingue el pago acordado de lo
            realmente pagado. Cada pago posterior genera un anexo. Sin PDF; se
            comparte manualmente.
          </p>
          <ReceiptCard settlementId={id} r={receipts.reception} />
          {receipts.annexes.length > 0 ? (
            <>
              <h2 className="text-base font-semibold">Anexos de pago</h2>
              {receipts.annexes.map((a) => (
                <ReceiptCard key={a.id} settlementId={id} r={a} />
              ))}
            </>
          ) : null}
        </>
      )}
    </div>
  )
}
