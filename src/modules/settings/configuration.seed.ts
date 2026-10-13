import type { PrismaClient } from "@/generated/prisma/client"

/**
 * Datos iniciales del Módulo 02. IDEMPOTENTE: cada registro se crea con
 * `upsert` por su clave estable (id singleton o código) y `update: {}`,
 * así que volver a ejecutarlo no duplica nada ni pisa lo que un
 * SUPERADMIN ya editó.
 *
 * Deliberadamente NO crea: denominaciones (se capturan cuando se conozcan
 * las fichas reales), cantidades de fichas, importes de caja, datos
 * bancarios, teléfonos, tokens ni movimientos financieros.
 */

export const DEFAULT_FOLIO_PREFIXES = {
  SESSION: "SES",
  PURCHASE: "CMP",
  DEBT_PAYMENT: "ABN",
  SETTLEMENT: "LIQ",
  CASH_MOVEMENT: "MOV",
  CHIP_MOVEMENT: "MFI",
  CASH_CLOSING: "CIE",
} as const

export async function seedConfiguration(db: PrismaClient): Promise<void> {
  await db.businessSettings.upsert({
    where: { id: 1 },
    create: { id: 1, businessName: "Poker Manager" },
    update: {},
  })

  await db.cashBox.upsert({
    where: { code: "MAIN" },
    create: { code: "MAIN", name: "Caja Central", currency: "MXN" },
    update: {},
  })

  const chipSet25 = await db.chipSet.upsert({
    where: { code: "CHIPSET_25_25" },
    create: {
      code: "CHIPSET_25_25",
      name: "Fichas Mesa 25/25",
      description: "Juego físico de fichas de la mesa 25/25.",
    },
    update: {},
  })
  const chipSet10 = await db.chipSet.upsert({
    where: { code: "CHIPSET_10_10" },
    create: {
      code: "CHIPSET_10_10",
      name: "Fichas Mesa 10/10",
      description: "Juego físico de fichas de la mesa 10/10.",
    },
    update: {},
  })

  await db.pokerTable.upsert({
    where: { code: "TABLE_25_25" },
    create: {
      code: "TABLE_25_25",
      name: "Mesa 25/25",
      smallBlind: "25",
      bigBlind: "25",
      defaultChipSetId: chipSet25.id,
      sortOrder: 1,
    },
    update: {},
  })
  await db.pokerTable.upsert({
    where: { code: "TABLE_10_10" },
    create: {
      code: "TABLE_10_10",
      name: "Mesa 10/10",
      smallBlind: "10",
      bigBlind: "10",
      defaultChipSetId: chipSet10.id,
      sortOrder: 2,
    },
    update: {},
  })

  await db.paymentMethod.upsert({
    where: { code: "CASH" },
    create: { code: "CASH", name: "Efectivo", sortOrder: 1 },
    update: {},
  })
  await db.paymentMethod.upsert({
    where: { code: "BANK_TRANSFER" },
    create: {
      code: "BANK_TRANSFER",
      name: "Transferencia bancaria",
      sortOrder: 2,
    },
    update: {},
  })

  // Cuenta receptora principal SIN datos bancarios: queda "pendiente de
  // captura" hasta que el SUPERADMIN registre banco, titular y CLABE.
  const primary = await db.paymentAccount.findFirst({
    where: { isPrimary: true, isActive: true },
    select: { id: true },
  })
  if (!primary) {
    await db.paymentAccount.create({
      data: { name: "Cuenta bancaria principal", isPrimary: true },
    })
  }

  for (const [documentType, prefix] of Object.entries(DEFAULT_FOLIO_PREFIXES)) {
    await db.folioSequence.upsert({
      where: {
        documentType: documentType as keyof typeof DEFAULT_FOLIO_PREFIXES,
      },
      create: {
        documentType: documentType as keyof typeof DEFAULT_FOLIO_PREFIXES,
        prefix,
      },
      update: {},
    })
  }

  await db.operationalSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  })

  await db.whatsAppSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  })
}
