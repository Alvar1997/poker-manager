import { ClipboardCheck } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { listCashReconciliations } from "@/modules/cash/reconciliation.service"
import {
  CASH_BASE,
  DIFFERENCE_STATUS_LABEL,
  formatMXN,
  RECONCILIATION_STATUS_LABEL,
  RECONCILIATION_TYPE_LABEL,
} from "@/modules/cash/components/format"

import { BackToCash } from "../back-link"

export const metadata = { title: "Arqueos de efectivo — Poker Manager" }

export default async function CashReconciliationsPage() {
  await requirePagePermission(
    PERMISSIONS.CASH_READ,
    `${CASH_BASE}/conciliaciones`
  )
  const result = await listCashReconciliations({ page: 1, pageSize: 30 })

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BackToCash />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Arqueos de efectivo</h1>
        <Link
          href={`${CASH_BASE}/conciliaciones/nueva`}
          className={cn(buttonVariants(), "h-11 md:h-9")}
        >
          Nuevo arqueo
        </Link>
      </div>
      <p className="text-muted-foreground text-sm">
        Conteo físico del efectivo contra el registrado. Es independiente del
        arqueo de fichas.
      </p>
      {result.items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Sin arqueos de efectivo"
          description="Aún no se ha contado efectivo en ninguna sesión."
        />
      ) : (
        <ul className="space-y-2">
          {result.items.map((r) => (
            <li key={r.id}>
              <Link
                href={`${CASH_BASE}/conciliaciones/${r.id}`}
                className="block rounded-xl"
              >
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex gap-2">
                        <Badge variant="secondary">
                          {RECONCILIATION_TYPE_LABEL[r.reconciliationType]}
                        </Badge>
                        <Badge variant="outline">
                          {RECONCILIATION_STATUS_LABEL[r.status]}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {formatDateTime(r.createdAt)}
                      </span>
                    </div>
                    <p className="tabular-nums">
                      Esperado {formatMXN(r.expectedAmount)} · Contado{" "}
                      {formatMXN(r.countedAmount)} · Diferencia{" "}
                      {formatMXN(r.differenceAmount)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Sesión <span className="font-mono">{r.sessionId}</span> ·{" "}
                      {DIFFERENCE_STATUS_LABEL[r.differenceStatus]}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
