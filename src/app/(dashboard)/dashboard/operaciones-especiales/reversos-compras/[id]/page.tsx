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
import { getPurchaseReversal } from "@/modules/special-operations/purchase-reversal.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Reverso de compra — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function PurchaseReversalPage({
  params,
}: PageProps<"/dashboard/operaciones-especiales/reversos-compras/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/reversos-compras`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const r = await getPurchaseReversal(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  return (
    <>
      <BackLink
        href={`${SPECIAL_BASE}/reversos-compras`}
        label="Reversos de compras"
      />
      <PageHeader
        title={`Reverso ${r.folio}`}
        description={`Compra ${r.purchase.folio} · ${r.purchase.player.name}`}
      />
      <Card>
        <CardContent className="space-y-3">
          <p data-testid="reversal-status">
            <StatusBadge value="EXECUTED" label="Reverso ejecutado" />
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <KeyValue label="Fichas devueltas" testId="reversal-returned-value">
              {formatMXN(r.returned)}
            </KeyValue>
            <KeyValue
              label="Deuda extinguida (sin dinero)"
              testId="reversal-extinguished"
            >
              {formatMXN(r.extinguished)}
            </KeyValue>
            <KeyValue label="Reembolso" testId="reversal-refund">
              {formatMXN(r.refund)}
            </KeyValue>
            <KeyValue label="Sesión">{`${r.purchase.session.folio} · ${r.purchase.session.status}`}</KeyValue>
            <KeyValue label="Autorización">{r.correction.folio}</KeyValue>
            <KeyValue label="Ejecutó">{`${r.executedBy} · ${formatDateTime(r.executedAt)}`}</KeyValue>
          </dl>
          <p className="text-sm">Motivo: {r.reason}</p>
        </CardContent>
      </Card>
      {r.payable ? (
        <PayableCard
          payable={r.payable}
          canOperate={can(user, PERMISSIONS.SPECIAL_OPS_OPERATE)}
          sessionCashAllowed={r.purchase.session.status === "OPEN"}
          title="Reembolso al jugador"
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          Sin reembolso: el jugador no había pagado dinero por esta compra.
        </p>
      )}
      <ReceiptsCard receipts={r.receipts} />
    </>
  )
}
