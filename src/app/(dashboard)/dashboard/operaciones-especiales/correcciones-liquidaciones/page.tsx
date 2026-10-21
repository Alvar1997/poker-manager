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
import { listSettlementCorrections } from "@/modules/special-operations/special-query.service"

export const metadata = {
  title: "Correcciones de liquidaciones — Poker Manager",
}
export const dynamic = "force-dynamic"

export default async function SettlementCorrectionsPage() {
  await requirePagePermission(PERMISSIONS.SPECIAL_OPS_READ, SPECIAL_BASE)
  const { executed, requests } = await listSettlementCorrections()
  return (
    <>
      <PageHeader
        title="Correcciones de liquidaciones"
        description="Efectos nuevos (contraasientos y obligaciones). La liquidación, su firma y sus pagos se conservan."
        actions={
          <LinkButton
            href="/dashboard/administracion/correcciones/nueva?type=SETTLEMENT_REVERSAL_WITH_PAYOUTS"
            testId="request-settlement-correction"
          >
            Solicitar corrección
          </LinkButton>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solicitudes</CardTitle>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <EmptyState>No hay solicitudes abiertas.</EmptyState>
          ) : (
            <ul
              className="space-y-2"
              data-testid="settlement-correction-requests"
            >
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
                        href={`${SPECIAL_BASE}/correcciones-liquidaciones/nuevo?settlementId=${c.settlementId}&correctionId=${c.id}`}
                        className="font-medium underline"
                        data-testid="open-settlement-correction"
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
        <EmptyState testId="no-settlement-corrections">
          No hay correcciones ejecutadas.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="settlement-correction-list">
          {executed.map((r) => (
            <ListCard
              key={r.id}
              href={`${SPECIAL_BASE}/correcciones-liquidaciones/${r.id}`}
              testId="settlement-correction-row"
              title={`${r.folio} · liquidación ${r.settlement.folio} · ${r.settlement.player.name}`}
              subtitle={`${formatDateTime(r.executedAt)} · ${r.kind === "OFFSET_REVERSAL" ? "reverso de compensación" : "pago adicional"} ${formatMXN(r.amount)}`}
              right={`Pendiente ${formatMXN(r.pending)}`}
            />
          ))}
        </ul>
      )}
    </>
  )
}
