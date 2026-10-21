import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { PageHeader, StatusBadge } from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import {
  EmptyState,
  ListCard,
} from "@/modules/special-operations/components/special-ui"
import { UNAPPLIED_STATUS_LABEL } from "@/modules/special-operations/special-query.service"
import { listUnappliedFunds } from "@/modules/special-operations/unapplied-funds.service"

export const metadata = { title: "Fondos no aplicados — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function UnappliedFundsPage() {
  await requirePagePermission(PERMISSIONS.SPECIAL_OPS_READ, SPECIAL_BASE)
  const rows = await listUnappliedFunds()
  return (
    <>
      <PageHeader
        title="Fondos no aplicados"
        description="Dinero real recibido que excedió la deuda. No es saldo a favor: se devuelve con pagos reales."
      />
      {rows.length === 0 ? (
        <EmptyState testId="no-unapplied">
          No hay fondos no aplicados.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="unapplied-list">
          {rows.map((r) => (
            <ListCard
              key={r.id}
              href={`${SPECIAL_BASE}/fondos-no-aplicados/${r.id}`}
              testId="unapplied-row"
              title={`${r.player.name} · ${formatMXN(r.amount)}`}
              subtitle={`${formatDateTime(r.createdAt)} · ${r.reason}`}
              right={
                <StatusBadge
                  value={r.status === "REFUNDED" ? "COMPLETED" : "WARNING"}
                  label={UNAPPLIED_STATUS_LABEL[r.status]}
                />
              }
            />
          ))}
        </ul>
      )}
    </>
  )
}
