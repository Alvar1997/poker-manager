import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { NewCountButton } from "@/modules/inventory/components/new-count-button"
import { getInventorySummary } from "@/modules/inventory/inventory.service"

export const metadata = { title: "Nuevo arqueo — Poker Manager" }

export default async function NewCountPage() {
  await requirePagePermission(
    PERMISSIONS.CHIPS_OPERATE,
    `${INVENTORY_BASE}/arqueos/nuevo`
  )
  const sets = (await getInventorySummary()).filter((s) => s.initialized)

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href={`${INVENTORY_BASE}/arqueos`}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Arqueos
      </Link>
      <h1 className="text-xl font-semibold">Nuevo arqueo</h1>
      <p className="text-muted-foreground text-sm">
        Se cuenta el inventario completo, común a ambas mesas (un solo arqueo
        general); guardar o revisar el conteo no modifica el inventario.
      </p>
      {sets.length === 0 ? (
        <p className="text-sm">
          El inventario de fichas aún no está inicializado.
        </p>
      ) : (
        <ul className="space-y-3">
          {sets.map((s) => (
            <li key={s.chipSet.id}>
              <Card>
                <CardHeader>
                  <CardTitle>{s.chipSet.name}</CardTitle>
                  <p className="text-muted-foreground text-sm">
                    {s.container?.name} ({s.container?.code})
                  </p>
                </CardHeader>
                <CardContent>
                  <NewCountButton
                    chipSetId={s.chipSet.id}
                    label={
                      s.hasDraftCount
                        ? "Continuar arqueo en borrador"
                        : "Iniciar arqueo"
                    }
                  />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
