import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { LinkButton, PageHeader } from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { getSpecialOperationsOverview } from "@/modules/special-operations/special-query.service"

export const metadata = { title: "Operaciones especiales — Poker Manager" }
export const dynamic = "force-dynamic"

const KIND_LABEL: Record<string, string> = {
  REDEMPTION: "Canjes posteriores",
  PURCHASE_REFUND: "Reembolsos por reverso de compra",
  SETTLEMENT_ADJUSTMENT: "Correcciones de liquidaciones",
  UNAPPLIED_REFUND: "Devoluciones de fondos no aplicados",
}

export default async function SpecialOperationsPage() {
  await requirePagePermission(PERMISSIONS.SPECIAL_OPS_READ, SPECIAL_BASE)
  const o = await getSpecialOperationsOverview()
  return (
    <>
      <PageHeader
        title="Operaciones especiales"
        description="Correcciones y pagos posteriores con movimientos reales. Lo original nunca se modifica."
        actions={
          <LinkButton
            href={`${SPECIAL_BASE}/canjes/nuevo`}
            testId="new-redemption"
            variant="default"
          >
            Registrar canje
          </LinkButton>
        }
      />
      <p
        className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-xs"
        data-testid="special-rules"
      >
        Autorizar no es ejecutar: solo PARTNER o SUPERADMIN autorizan (Módulo
        15) y nada cuenta como pagado hasta registrar un pago real. Las sesiones
        cerradas, su caja y su comprobante no cambian.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pendientes de acción</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm" data-testid="special-pending">
              <li>Canjes por validar o recibir: {o.redemptionsAwaiting}</li>
              <li>
                Reversos de compra autorizados por ejecutar: {o.reversalsReady}
              </li>
              <li>
                Correcciones de liquidación autorizadas por ejecutar:{" "}
                {o.correctionsReady}
              </li>
              <li>
                Fondos no aplicados sin resolver: {o.unappliedPendingReview}
              </li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Obligaciones por pagar</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm" data-testid="special-payables">
              {Object.entries(o.payablesByKind).map(([k, v]) => (
                <li
                  key={k}
                  className="flex justify-between gap-2"
                  data-testid={`special-payables-${k}`}
                >
                  <span>
                    {KIND_LABEL[k]} ({v.count})
                  </span>
                  <span className="tabular-nums">{formatMXN(v.pending)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
