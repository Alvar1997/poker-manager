import "server-only"

import { getInventorySummary } from "@/modules/inventory/inventory.service"
import type { OperationChipSet } from "@/modules/inventory/components/stock-operation-form"

/** El inventario activo (compartido por todas las mesas), si ya está inicializado. */
export async function operationChipSets(): Promise<OperationChipSet[]> {
  const sets = await getInventorySummary()
  return sets
    .filter((s) => s.chipSet.isActive && s.initialized && s.container)
    .map((s) => ({
      id: s.chipSet.id,
      name: s.chipSet.name,
      containerLabel: `${s.container!.name} (${s.container!.code})`,
      denominations: s.denominations.map((d) => ({
        denominationId: d.denominationId,
        value: d.value,
        color: d.color,
        name: d.name,
        isActive: d.isActive,
        available: d.available,
        custody: d.custody,
      })),
    }))
}
