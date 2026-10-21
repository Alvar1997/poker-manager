import type { PrismaClient } from "@/generated/prisma/client"
import { SHARED_CHIP_SET_CODE } from "@/modules/settings/configuration.seed"

/**
 * Ubicación física del inventario de fichas. IDEMPOTENTE (upsert por
 * código con `update: {}`). Hay UN inventario compartido por ambas mesas y
 * una sola ubicación real: NO se crean maletines por mesa, cantidades,
 * movimientos, arqueos ni reservas.
 */
export const SHARED_CONTAINER = {
  code: "INVENTARIO-GENERAL",
  name: "Inventario general",
} as const

export async function seedChipContainers(db: PrismaClient): Promise<void> {
  const chipSet = await db.chipSet.findUnique({
    where: { code: SHARED_CHIP_SET_CODE },
    select: { id: true },
  })
  if (!chipSet) return // Sin el inventario del Módulo 02 no hay a qué vincularlo.

  await db.chipContainer.upsert({
    where: { code: SHARED_CONTAINER.code },
    create: {
      code: SHARED_CONTAINER.code,
      name: SHARED_CONTAINER.name,
      chipSetId: chipSet.id,
      description:
        "Ubicación física única del inventario compartido (no hay maletines por mesa).",
      isPrimary: true,
    },
    update: {},
  })
}
