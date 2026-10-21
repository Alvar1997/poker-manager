import { PenLine, ReceiptText, Wallet } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  CancelSettlementButton,
  ReverseSettlementButton,
  SettlementAmountsForm,
} from "@/modules/settlements/components/settlement-actions"
import {
  AmountRow,
  FifoTable,
  OFFSET_LABEL,
  PARTICIPATION_LABEL,
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENTS_BASE,
  SettlementStatusBadge,
} from "@/modules/settlements/components/settlement-ui"
import {
  playerOutstanding,
  previewSettlement,
} from "@/modules/settlements/settlement.service"

import { BackLink } from "../../sesiones/back-link"
import { loadSettlement } from "./load-settlement"

export const metadata = { title: "Liquidación — Poker Manager" }

export default async function SettlementPage({
  params,
}: PageProps<"/dashboard/liquidaciones/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SETTLEMENTS_READ,
    SETTLEMENTS_BASE
  )
  const s = await loadSettlement(id)
  const canOperate = can(user, PERMISSIONS.SETTLEMENTS_OPERATE)
  const editable = s.status === "DRAFT" || s.status === "READY_FOR_CONFIRMATION"
  const received = s.receivedAt !== null
  const [preview, outstanding] = editable
    ? await Promise.all([previewSettlement(id), playerOutstanding(s.player.id)])
    : [null, "0.00"]
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      <BackLink href={SETTLEMENTS_BASE} label="Liquidaciones" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          Liquidación <span className="font-mono">{s.folio}</span>
        </h1>
        <SettlementStatusBadge status={s.status} />
      </div>
      <Card>
        <CardContent className="space-y-1 pt-4 text-sm">
          <p className="text-lg font-medium" data-testid="settlement-player">
            {s.player.name}
          </p>
          <p className="text-muted-foreground">
            {s.table.name} (mesa final) · Sesión {s.session.folio} · ciclo{" "}
            {s.cycleNumber}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-testid="participation-status"
          >
            Participación:{" "}
            {PARTICIPATION_LABEL[s.participationStatus] ??
              s.participationStatus}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {received ? "Liquidación confirmada" : "Resumen previsto"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="divide-y">
            <AmountRow
              label="Fichas devueltas (valor nominal)"
              value={formatMXN(s.returnedNominalAmount)}
              testId="detail-returned"
              strong
            />
            <AmountRow
              label="Decisión"
              value={OFFSET_LABEL[s.offsetDecision]}
              testId="detail-decision"
            />
            {received ? (
              <>
                <AmountRow
                  label="Deuda al recibir"
                  value={formatMXN(s.debtBalanceSnapshot)}
                />
                <AmountRow
                  label="Deuda compensada"
                  value={formatMXN(s.offsetAmount)}
                  testId="detail-offset"
                />
                <AmountRow
                  label="Pago neto acordado"
                  value={formatMXN(s.netPayoutAmount)}
                  testId="detail-net"
                  strong
                />
              </>
            ) : preview?.valid ? (
              <>
                <AmountRow
                  label="Deuda actual"
                  value={formatMXN(preview.outstandingDebt)}
                />
                <AmountRow
                  label="Compensación prevista"
                  value={formatMXN(preview.offsetAmount)}
                />
                <AmountRow
                  label="Pago neto previsto"
                  value={formatMXN(preview.netPayoutAmount)}
                  strong
                />
              </>
            ) : preview && !preview.valid ? (
              <p className="text-destructive py-2 text-sm" role="alert">
                {preview.message}
              </p>
            ) : null}
          </dl>
          <FifoTable
            rows={
              received
                ? s.offsets
                    .filter((o) => o.kind === "APPLICATION")
                    .map((o) => ({
                      order: o.order,
                      purchaseFolio: o.purchaseFolio,
                      tableName: o.tableName,
                      sessionFolio: o.sessionFolio,
                      amount: o.amount,
                    }))
                : preview?.valid
                  ? preview.allocations
                  : []
            }
          />
        </CardContent>
      </Card>

      {s.payable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pago al jugador</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <AmountRow
                label="Pagado"
                value={formatMXN(s.payable.paid)}
                testId="payable-paid"
              />
              {s.payable.inTransit !== "0.00" ? (
                <AmountRow
                  label="Transferencia en trámite (no pagada)"
                  value={formatMXN(s.payable.inTransit)}
                  testId="payable-in-transit"
                />
              ) : null}
              <AmountRow
                label="Pendiente de pago"
                value={formatMXN(s.payable.pending)}
                testId="payable-pending"
                strong
              />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3">
        {editable && canOperate ? (
          <Link
            href={`${SETTLEMENTS_BASE}/${id}/firma`}
            className={cn(buttonVariants(), "h-11")}
            data-testid="go-signature"
          >
            <PenLine />
            {s.status === "DRAFT" ? "Firma del jugador" : "Confirmar recepción"}
          </Link>
        ) : null}
        {received ? (
          <>
            <Link
              href={`${SETTLEMENTS_BASE}/${id}/pagos`}
              className={cn(
                buttonVariants({
                  variant:
                    s.status === "PENDING_PAYOUT" ? "default" : "outline",
                }),
                "h-11"
              )}
              data-testid="go-payouts"
            >
              <Wallet />
              Pagos
            </Link>
            <Link
              href={`${SETTLEMENTS_BASE}/${id}/comprobante`}
              className={cn(buttonVariants({ variant: "outline" }), "h-11")}
              data-testid="go-receipt"
            >
              <ReceiptText />
              Comprobante
            </Link>
          </>
        ) : null}
      </div>

      {editable && canOperate && s.session.status === "OPEN" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Corregir antes de recibir
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Cambiar el importe o la compensación invalida la firma: el jugador
              debe firmar el nuevo resumen.
            </p>
            <SettlementAmountsForm
              participationId={s.participationId}
              outstanding={outstanding}
              edit={{
                settlementId: s.id,
                version: s.version,
                returnedNominalAmount: s.returnedNominalAmount,
                offsetDecision: s.offsetDecision,
                requestedOffsetAmount: s.requestedOffsetAmount,
              }}
            />
            <CancelSettlementButton settlementId={s.id} />
          </CardContent>
        </Card>
      ) : null}

      {canOperate &&
      (s.status === "PENDING_PAYOUT" || s.status === "COMPLETED") &&
      s.payable?.paid === "0.00" &&
      s.payable?.inTransit === "0.00" &&
      s.session.status === "OPEN" ? (
        <ReverseSettlementButton
          settlementId={s.id}
          returned={s.returnedNominalAmount}
        />
      ) : null}

      <Card>
        <CardContent className="text-muted-foreground space-y-1 pt-4 text-xs">
          <p>
            Inició {s.createdBy.name} · {formatDateTime(s.createdAt)}
            {s.receivedBy
              ? ` · recibió ${s.receivedBy.name} ${formatDateTime(s.receivedAt!)}`
              : ""}
          </p>
          {s.cancellationReason ? (
            <p>Cancelada: {s.cancellationReason}</p>
          ) : null}
          {s.reversal ? (
            <p>
              Revertida por {s.reversal.createdBy.name}: {s.reversal.reason}
            </p>
          ) : null}
          <ol className="space-y-0.5" data-testid="settlement-history">
            {s.history.map((h, i) => (
              <li key={i}>
                {formatDateTime(h.changedAt)} ·{" "}
                {SETTLEMENT_STATUS_LABEL[h.toStatus] ?? h.toStatus} ·{" "}
                {h.changedBy.name}
                {h.reason ? ` — ${h.reason}` : ""}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
