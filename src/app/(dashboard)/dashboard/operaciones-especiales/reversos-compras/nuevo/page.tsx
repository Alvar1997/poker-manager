import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { KeyValue, PageHeader } from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { PurchaseReversalForm } from "@/modules/special-operations/components/special-actions"
import { previewPurchaseReversal } from "@/modules/special-operations/purchase-reversal.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Ejecutar reverso de compra — Poker Manager" }
export const dynamic = "force-dynamic"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function NewPurchaseReversalPage({
  searchParams,
}: PageProps<"/dashboard/operaciones-especiales/reversos-compras/nuevo">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/reversos-compras`
  )
  const sp = await searchParams
  const purchaseId = typeof sp.purchaseId === "string" ? sp.purchaseId : ""
  const correctionId =
    typeof sp.correctionId === "string" ? sp.correctionId : ""
  if (!ID.test(purchaseId)) notFound()
  const v = await previewPurchaseReversal(purchaseId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const plan = v.plan
  return (
    <>
      <BackLink
        href={`${SPECIAL_BASE}/reversos-compras`}
        label="Reversos de compras"
      />
      <PageHeader
        title={`Reverso de la compra ${v.purchase.folio}`}
        description={v.purchase.player.name}
      />
      <Card>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <KeyValue label="Valor entregado">
              {formatMXN(v.purchase.nominal)}
            </KeyValue>
            <KeyValue label="Sesión">{`${v.purchase.session.folio} · ${v.purchase.session.status}`}</KeyValue>
            <KeyValue label="Mesa">{v.purchase.table}</KeyValue>
            <KeyValue label="Autorización">
              {v.correction ? v.correction.folio : "Sin solicitud aprobada"}
            </KeyValue>
          </dl>
          {plan.effects ? (
            <ul className="space-y-0.5 text-xs" data-testid="reversal-effects">
              <li>
                Debe regresar físicamente:{" "}
                {formatMXN(plan.effects.chipsToReturn)}
              </li>
              <li>
                Saldo de deuda que se extingue (sin dinero):{" "}
                {formatMXN(plan.effects.extinguish)}
              </li>
              <li>
                Dinero realmente pagado que se reembolsa:{" "}
                {formatMXN(plan.effects.refund)} (efectivo{" "}
                {formatMXN(plan.effects.refundBreakdown.cash)}, terminal{" "}
                {formatMXN(plan.effects.refundBreakdown.card)}, transferencias{" "}
                {formatMXN(plan.effects.refundBreakdown.transferVerified)},
                abonos {formatMXN(plan.effects.refundBreakdown.abonos)},
                compensaciones {formatMXN(plan.effects.refundBreakdown.offsets)}
                )
              </li>
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ejecutar</CardTitle>
        </CardHeader>
        <CardContent>
          {plan.classification === "ALREADY_REVERSED" ||
          plan.classification === "CANCEL_PURCHASE" ? (
            <p className="text-sm" data-testid="reversal-not-applicable">
              {plan.blockers.join(" ")}
            </p>
          ) : !v.correction ||
            (correctionId && correctionId !== v.correction.id) ? (
            <p className="text-sm" data-testid="reversal-needs-approval">
              Requiere una solicitud de corrección APROBADA por PARTNER o
              SUPERADMIN (Administración → Correcciones).
            </p>
          ) : can(user, PERMISSIONS.SPECIAL_OPS_OPERATE) ? (
            <PurchaseReversalForm
              purchaseId={v.purchase.id}
              correctionId={v.correction.id}
              version={v.purchase.version}
              nominal={v.purchase.nominal}
            />
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
