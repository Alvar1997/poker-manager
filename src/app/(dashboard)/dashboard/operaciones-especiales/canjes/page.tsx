import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { formatDateTime } from "@/lib/format"
import {
  EmptyState,
  ListCard,
} from "@/modules/special-operations/components/special-ui"
import { listRedemptions } from "@/modules/special-operations/special-query.service"

export const metadata = { title: "Canjes posteriores — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function RedemptionsPage() {
  await requirePagePermission(PERMISSIONS.SPECIAL_OPS_READ, SPECIAL_BASE)
  const rows = await listRedemptions()
  return (
    <>
      <PageHeader
        title="Canjes posteriores de fichas"
        description="Fichas no retornadas que se presentan después. Solo se paga lo recibido físicamente y validado."
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
      {rows.length === 0 ? (
        <EmptyState testId="no-redemptions">
          No hay canjes registrados.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="redemption-list">
          {rows.map((r) => (
            <ListCard
              key={r.id}
              href={`${SPECIAL_BASE}/canjes/${r.id}`}
              testId="redemption-row"
              title={`${r.folio} · ${r.presenterName}`}
              subtitle={`${formatDateTime(r.requestedAt)} · presentado ${formatMXN(r.presented)}${r.accepted ? ` · aceptado ${formatMXN(r.accepted)}` : ""}`}
              right={<StatusBadge value={r.status} label={r.statusLabel} />}
            />
          ))}
        </ul>
      )}
    </>
  )
}
