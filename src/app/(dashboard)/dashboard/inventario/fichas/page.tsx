import { AlertTriangle, Briefcase, ChevronRight } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatNominal } from "@/modules/inventory/components/format"
import {
  INVENTORY_BASE,
  InventoryActions,
} from "@/modules/inventory/components/inventory-nav"
import { getInventorySummary } from "@/modules/inventory/inventory.service"

export const metadata = { title: "Inventario de fichas — Poker Manager" }

export default async function ChipInventoryPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CHIPS_READ,
    INVENTORY_BASE
  )
  const sets = await getInventorySummary()

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Inventario de fichas</h1>
        <p className="text-muted-foreground text-sm">
          Un solo inventario físico compartido por las mesas 25/25 y 10/10. El
          valor nominal de las fichas no es dinero en caja.
        </p>
      </div>
      <InventoryActions canOperate={can(user, PERMISSIONS.CHIPS_OPERATE)} />

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sets.map((s) => (
          <li key={s.chipSet.id}>
            <Link
              href={`${INVENTORY_BASE}/${s.chipSet.id}`}
              className="block h-full rounded-xl"
              data-testid="inventory-card"
            >
              <Card className="hover:bg-muted/50 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-start justify-between gap-2">
                    <span>
                      {s.chipSet.name}
                      <span className="text-muted-foreground block font-mono text-xs font-normal">
                        {s.chipSet.code}
                      </span>
                    </span>
                    <ChevronRight
                      className="text-muted-foreground size-4"
                      aria-hidden="true"
                    />
                  </CardTitle>
                  <p
                    className="text-muted-foreground flex items-center gap-1.5 text-sm"
                    data-testid="inventory-container"
                  >
                    <Briefcase className="size-3.5" aria-hidden="true" />
                    {s.container
                      ? `${s.container.name} (${s.container.code})`
                      : "Sin ubicación asignada"}
                  </p>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {!s.initialized ? (
                    <Badge
                      variant="outline"
                      className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
                      data-testid="inventory-pending"
                    >
                      <AlertTriangle aria-hidden="true" />
                      Inventario pendiente de inicialización
                    </Badge>
                  ) : (
                    <>
                      <dl className="grid grid-cols-2 gap-2">
                        {[
                          [
                            "Valor bajo custodia",
                            s.nominal.custody,
                            "inventory-total",
                          ],
                          [
                            "Disponible",
                            s.nominal.available,
                            "inventory-available",
                          ],
                          [
                            "Reservado",
                            s.nominal.reserved,
                            "inventory-reserved",
                          ],
                          [
                            "En circulación",
                            s.nominal.circulation,
                            "inventory-circulation",
                          ],
                        ].map(([label, value, testId]) => (
                          <div key={label}>
                            <dt className="text-muted-foreground text-xs">
                              {label}
                            </dt>
                            <dd className="font-medium" data-testid={testId}>
                              {formatNominal(value)}
                            </dd>
                          </div>
                        ))}
                        <div>
                          <dt className="text-muted-foreground text-xs">
                            Último arqueo
                          </dt>
                          <dd className="font-medium">
                            {s.lastCountAt
                              ? formatDateTime(s.lastCountAt)
                              : "Sin arqueos"}
                          </dd>
                        </div>
                      </dl>
                      {s.pendingDifferences > 0 ? (
                        <Badge
                          variant="destructive"
                          data-testid="inventory-pending-differences"
                        >
                          {s.pendingDifferences} arqueo(s) con diferencias
                          pendientes
                        </Badge>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          Sin diferencias pendientes
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
