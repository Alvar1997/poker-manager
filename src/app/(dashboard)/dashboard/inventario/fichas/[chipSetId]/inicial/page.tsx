import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { InitialStockForm } from "@/modules/inventory/components/initial-stock-form"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { getInventoryByChipSet } from "@/modules/inventory/inventory.service"

export const metadata = { title: "Inventario inicial — Poker Manager" }

export default async function InitialStockPage({
  params,
}: PageProps<"/dashboard/inventario/fichas/[chipSetId]/inicial">) {
  await requirePagePermission(PERMISSIONS.CHIPS_OPERATE, INVENTORY_BASE)
  const { chipSetId } = await params
  if (!/^[A-Za-z0-9_-]+$/.test(chipSetId)) notFound()
  const inv = await getInventoryByChipSet(chipSetId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  if (inv.initialized) redirect(`${INVENTORY_BASE}/${chipSetId}`)
  const active = inv.denominations.filter((d) => d.isActive)

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href={`${INVENTORY_BASE}/${chipSetId}`}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {inv.chipSet.name}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Inventario inicial
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            {inv.container?.name} ({inv.container?.code}). Cuenta las fichas
            físicas del inventario común por denominación.
          </p>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-sm">
              El inventario no tiene denominaciones activas.
            </p>
          ) : (
            <InitialStockForm
              chipSetId={inv.chipSet.id}
              chipSetName={inv.chipSet.name}
              denominations={active}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
