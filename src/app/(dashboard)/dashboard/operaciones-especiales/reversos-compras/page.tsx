import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import {
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import {
  EmptyState,
  ListCard,
} from "@/modules/special-operations/components/special-ui"
import { listPurchaseReversals } from "@/modules/special-operations/special-query.service"

export const metadata = { title: "Reversos de compras — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function PurchaseReversalsPage() {
  await requirePagePermission(PERMISSIONS.SPECIAL_OPS_READ, SPECIAL_BASE)
  const { executed, requests } = await listPurchaseReversals()
  return (
    <>
      <PageHeader
        title="Reversos de compras"
        description="Solo con autorización aprobada y devolución física completa de las fichas. La compra original se conserva."
        actions={
          <LinkButton
            href="/dashboard/administracion/correcciones/nueva?type=PURCHASE_REVERSAL"
            testId="request-reversal"
          >
            Solicitar reverso
          </LinkButton>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solicitudes</CardTitle>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <EmptyState>No hay solicitudes de reverso abiertas.</EmptyState>
          ) : (
            <ul className="space-y-2" data-testid="reversal-requests">
              {requests.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/dashboard/administracion/correcciones/${c.id}`}
                      className="font-medium underline"
                    >
                      {c.folio}
                    </Link>
                    <span className="text-muted-foreground block text-xs">
                      {c.reason}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge value={c.status} label={c.statusLabel} />
                    {c.status === "APPROVED" || c.status === "FAILED" ? (
                      <Link
                        href={`${SPECIAL_BASE}/reversos-compras/nuevo?purchaseId=${c.purchaseId}&correctionId=${c.id}`}
                        className="font-medium underline"
                        data-testid="open-reversal"
                      >
                        Ejecutar
                      </Link>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {executed.length === 0 ? (
        <EmptyState testId="no-reversals">
          No hay reversos ejecutados.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="reversal-list">
          {executed.map((r) => (
            <ListCard
              key={r.id}
              href={`${SPECIAL_BASE}/reversos-compras/${r.id}`}
              testId="reversal-row"
              title={`${r.folio} · compra ${r.purchase.folio} · ${r.purchase.player.name}`}
              subtitle={`${formatDateTime(r.executedAt)} · fichas ${formatMXN(r.returned)} · extinguido ${formatMXN(r.extinguished)}`}
              right={`Reembolso pendiente ${formatMXN(r.refundPending)}`}
            />
          ))}
        </ul>
      )}
    </>
  )
}
