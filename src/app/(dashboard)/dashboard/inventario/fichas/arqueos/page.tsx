import { ArrowLeft, ClipboardCheck, Plus } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  COUNT_TYPE_LABEL,
  CountStatusBadges,
} from "@/modules/inventory/components/count-status"
import { formatNominal } from "@/modules/inventory/components/format"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { listStockCounts } from "@/modules/inventory/stock-count.service"

export const metadata = { title: "Arqueos de fichas — Poker Manager" }

export default async function CountsPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CHIPS_READ,
    `${INVENTORY_BASE}/arqueos`
  )
  const counts = await listStockCounts({ page: 1, pageSize: 50 })

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href={INVENTORY_BASE}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Inventario de fichas
      </Link>
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Arqueos</h1>
        {can(user, PERMISSIONS.CHIPS_OPERATE) ? (
          <Link
            href={`${INVENTORY_BASE}/arqueos/nuevo`}
            className={cn(buttonVariants(), "h-11 md:h-9")}
          >
            <Plus />
            Nuevo arqueo
          </Link>
        ) : null}
      </div>
      {counts.items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Sin arqueos"
          description="Aún no se ha realizado ningún arqueo."
        />
      ) : (
        <ul className="space-y-2">
          {counts.items.map((c) => (
            <li key={c.id}>
              <Link
                href={`${INVENTORY_BASE}/arqueos/${c.id}`}
                className="block rounded-xl"
                data-testid="count-card"
              >
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        {c.chipSet.name} · {COUNT_TYPE_LABEL[c.countType]}
                      </p>
                      <CountStatusBadges
                        status={c.status}
                        reconciliationStatus={c.reconciliationStatus}
                      />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {formatDateTime(c.confirmedAt ?? c.createdAt)} ·{" "}
                      {c.container.code}
                      {c.status === "CONFIRMED"
                        ? ` · diferencia nominal ${formatNominal(c.differenceTotal)}`
                        : ""}
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
