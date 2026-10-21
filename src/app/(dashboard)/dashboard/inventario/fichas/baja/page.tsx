import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { StockOperationForm } from "@/modules/inventory/components/stock-operation-form"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { operationChipSets } from "@/modules/inventory/components/operation-page-data"

export const metadata = { title: "Baja de fichas — Poker Manager" }

export default async function Page() {
  await requirePagePermission(
    PERMISSIONS.CHIPS_OPERATE,
    `${INVENTORY_BASE}/baja`
  )
  const chipSets = await operationChipSets()

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href={INVENTORY_BASE}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Inventario de fichas
      </Link>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Baja de fichas
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Retira definitivamente fichas dañadas, perdidas o fuera de uso. Solo
            fichas disponibles en el inventario común.
          </p>
        </CardHeader>
        <CardContent>
          {chipSets.length === 0 ? (
            <p className="text-sm">
              El inventario de fichas aún no está inicializado.
            </p>
          ) : (
            <StockOperationForm mode="withdrawal" chipSets={chipSets} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
