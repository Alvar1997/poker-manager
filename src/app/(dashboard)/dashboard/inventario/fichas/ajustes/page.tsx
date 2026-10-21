import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AdjustmentForm } from "@/modules/inventory/components/adjustment-form"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { operationChipSets } from "@/modules/inventory/components/operation-page-data"

export const metadata = { title: "Ajuste de inventario — Poker Manager" }

export default async function Page() {
  await requirePagePermission(
    PERMISSIONS.CHIPS_OPERATE,
    `${INVENTORY_BASE}/ajustes`
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
            Ajuste de inventario
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Faltantes, sobrantes y correcciones. Sin aprobación adicional; el
            motivo es obligatorio.
          </p>
        </CardHeader>
        <CardContent>
          {chipSets.length === 0 ? (
            <p className="text-sm">
              El inventario de fichas aún no está inicializado.
            </p>
          ) : (
            <AdjustmentForm chipSets={chipSets} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
