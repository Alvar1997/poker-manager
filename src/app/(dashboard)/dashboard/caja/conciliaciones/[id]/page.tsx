import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { getCashReconciliation } from "@/modules/cash/reconciliation.service"
import {
  CASH_BASE,
  DIFFERENCE_STATUS_LABEL,
  formatMXN,
  RECONCILIATION_STATUS_LABEL,
  RECONCILIATION_TYPE_LABEL,
} from "@/modules/cash/components/format"

import { BackToCash } from "../../back-link"

export const metadata = { title: "Arqueo de efectivo — Poker Manager" }

export default async function CashReconciliationPage({
  params,
}: PageProps<"/dashboard/caja/conciliaciones/[id]">) {
  const { id } = await params
  await requirePagePermission(
    PERMISSIONS.CASH_READ,
    `${CASH_BASE}/conciliaciones/${id}`
  )
  const r = await getCashReconciliation(id).catch((e) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <div>
        <dt className="text-muted-foreground text-xs">{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackToCash
        href={`${CASH_BASE}/conciliaciones`}
        label="Arqueos de efectivo"
      />
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">
          Arqueo de{" "}
          {RECONCILIATION_TYPE_LABEL[r.reconciliationType].toLowerCase()}
        </h1>
        <Badge variant="outline">{RECONCILIATION_STATUS_LABEL[r.status]}</Badge>
      </div>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {row("Sesión", <span className="font-mono">{r.sessionId}</span>)}
            {row("Esperado", formatMXN(r.expectedAmount))}
            {row("Contado", formatMXN(r.countedAmount))}
            {row(
              "Diferencia",
              `${formatMXN(r.differenceAmount)} · ${DIFFERENCE_STATUS_LABEL[r.differenceStatus]}`
            )}
            {row("Explicación", r.explanation)}
            {row("Notas", r.notes)}
            {row(
              "Registró",
              `${r.createdBy?.name ?? "—"} · ${formatDateTime(r.createdAt)}`
            )}
            {row(
              "Confirmó",
              r.confirmedBy &&
                r.confirmedAt &&
                `${r.confirmedBy.name} · ${formatDateTime(r.confirmedAt)}`
            )}
            {row("Ajuste", r.adjustmentTransaction?.folio)}
          </dl>
          {r.details.length ? (
            <ul className="mt-3 divide-y border-t text-sm">
              {r.details.map((d) => (
                <li
                  key={d.unitValue}
                  className="flex justify-between py-1.5 tabular-nums"
                >
                  <span>{formatMXN(d.unitValue)}</span>
                  <span>× {d.quantity}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
