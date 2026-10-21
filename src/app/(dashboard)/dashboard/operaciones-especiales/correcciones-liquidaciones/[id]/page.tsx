import { notFound } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  KeyValue,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import {
  PayableCard,
  ReceiptsCard,
} from "@/modules/special-operations/components/special-ui"
import { getSettlementCorrection } from "@/modules/special-operations/settlement-correction.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Corrección de liquidación — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function SettlementCorrectionPage({
  params,
}: PageProps<"/dashboard/operaciones-especiales/correcciones-liquidaciones/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/correcciones-liquidaciones`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const r = await getSettlementCorrection(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  return (
    <>
      <BackLink
        href={`${SPECIAL_BASE}/correcciones-liquidaciones`}
        label="Correcciones de liquidaciones"
      />
      <PageHeader
        title={`Corrección ${r.folio}`}
        description={`Liquidación ${r.settlement.folio} · ${r.settlement.player.name}`}
      />
      <Card>
        <CardContent className="space-y-3">
          <p data-testid="settlement-correction-status">
            <StatusBadge value="EXECUTED" label="Corrección ejecutada" />
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <KeyValue label="Tipo">
              {r.kind === "OFFSET_REVERSAL"
                ? "Reverso de compensación"
                : "Pago adicional"}
            </KeyValue>
            <KeyValue label="Importe" testId="settlement-correction-amount">
              {formatMXN(r.amount)}
            </KeyValue>
            <KeyValue label="Autorización">{r.correction.folio}</KeyValue>
            <KeyValue label="Sesión">{`${r.settlement.session.folio} · ${r.settlement.session.status}`}</KeyValue>
            <KeyValue label="Ejecutó">{`${r.executedBy} · ${formatDateTime(r.executedAt)}`}</KeyValue>
          </dl>
          <p className="text-sm">Motivo: {r.reason}</p>
        </CardContent>
      </Card>
      {r.payable ? (
        <PayableCard
          payable={r.payable}
          canOperate={can(user, PERMISSIONS.SPECIAL_OPS_OPERATE)}
          sessionCashAllowed={r.settlement.session.status === "OPEN"}
          title="Importe por pagar al jugador"
        />
      ) : null}
      <ReceiptsCard receipts={r.receipts} />
    </>
  )
}
