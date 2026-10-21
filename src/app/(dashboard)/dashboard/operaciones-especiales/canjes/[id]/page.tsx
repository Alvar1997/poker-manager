import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  KeyValue,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import {
  CancelForm,
  RedemptionReceiptForm,
  RedemptionValidateForm,
} from "@/modules/special-operations/components/special-actions"
import {
  PayableCard,
  ReceiptsCard,
} from "@/modules/special-operations/components/special-ui"
import { getRedemption } from "@/modules/special-operations/redemption.service"
import { REDEMPTION_STATUS_LABEL } from "@/modules/special-operations/special-query.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Canje posterior — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function RedemptionPage({
  params,
}: PageProps<"/dashboard/operaciones-especiales/canjes/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/canjes`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const r = await getRedemption(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const canOperate = can(user, PERMISSIONS.SPECIAL_OPS_OPERATE)
  const canAuthorize = can(user, PERMISSIONS.SPECIAL_OPS_AUTHORIZE)
  const denominations =
    r.status === "REQUESTED" || r.status === "VALIDATING"
      ? await prisma.chipDenomination.findMany({
          where: { isActive: true, chipSet: { code: "CHIPSET_MAIN" } },
          orderBy: { value: "asc" },
          select: { id: true, value: true, name: true },
        })
      : []
  return (
    <>
      <BackLink href={`${SPECIAL_BASE}/canjes`} label="Canjes" />
      <PageHeader title={`Canje ${r.folio}`} description={r.presenterName} />
      <Card>
        <CardContent className="space-y-3">
          <p data-testid="redemption-status">
            <StatusBadge
              value={r.status}
              label={REDEMPTION_STATUS_LABEL[r.status]}
            />
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <KeyValue label="Presentado" testId="redemption-presented">
              {formatMXN(r.presented)}
            </KeyValue>
            <KeyValue label="Aceptado" testId="redemption-accepted-value">
              {r.accepted ? formatMXN(r.accepted) : "—"}
            </KeyValue>
            <KeyValue label="Rechazado">
              {r.rejected ? formatMXN(r.rejected) : "—"}
            </KeyValue>
            <KeyValue label="Jugador">
              {r.player?.name ?? "No registrado"}
            </KeyValue>
            <KeyValue label="Sesión de origen (informativa)">
              {r.originSession
                ? `${r.originSession.folio} · ${r.originSession.status}`
                : "Desconocida"}
            </KeyValue>
            <KeyValue label="Fichas en circulación (global)">
              {formatMXN(r.globalCirculation)}
            </KeyValue>
            <KeyValue label="Solicitó">
              {r.requestedBy} · {formatDateTime(r.requestedAt)}
            </KeyValue>
            <KeyValue label="Recepción física" testId="redemption-received">
              {r.received
                ? `${r.receivedBy} · ${formatDateTime(r.receivedAt!)}`
                : "Pendiente"}
            </KeyValue>
          </dl>
          {r.originEvidence ? (
            <p className="text-xs">Evidencia de origen: {r.originEvidence}</p>
          ) : null}
          {r.validationNotes ? (
            <p className="text-xs">Validación: {r.validationNotes}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            La circulación global solo es el máximo que podría regresar: no
            prueba el derecho a cobrar.
          </p>
        </CardContent>
      </Card>
      {r.status === "REQUESTED" || r.status === "VALIDATING" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {r.status === "REQUESTED"
                ? "Validación del valor (socio)"
                : "Recepción física"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canAuthorize ? (
              <RedemptionValidateForm
                id={r.id}
                version={r.version}
                presented={r.accepted ?? r.presented}
                denominations={denominations.map((d) => ({
                  id: d.id,
                  value: d.value.toFixed(2),
                  label: d.name
                    ? `${d.name} ($${d.value.toFixed(2)})`
                    : `$${d.value.toFixed(2)}`,
                }))}
              />
            ) : r.status === "REQUESTED" ? (
              <p className="text-sm" data-testid="cashier-cannot-validate">
                Un socio o superadministrador debe validar el valor aceptado
                antes de recibir las fichas.
              </p>
            ) : null}
            {r.status === "VALIDATING" && canOperate ? (
              <RedemptionReceiptForm
                id={r.id}
                version={r.version}
                accepted={r.accepted!}
              />
            ) : null}
            {canOperate ? (
              <CancelForm
                url={`/api/special-operations/redemptions/${r.id}/cancel`}
                version={r.version}
                testId="cancel-redemption"
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {r.payable ? (
        <PayableCard
          payable={r.payable}
          canOperate={canOperate}
          sessionCashAllowed={false}
          title="Pago del canje"
        />
      ) : null}
      <ReceiptsCard receipts={r.receipts} />
    </>
  )
}
