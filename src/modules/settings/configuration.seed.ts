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
  // Folio de sesión S-0001-YYYYMMDD (ver session-folio.ts).
  SESSION: "S",
  PURCHASE: "CMP",
  DEBT_PAYMENT: "ABN",
  SETTLEMENT: "LIQ",
  CASH_MOVEMENT: "MOV",
  CHIP_MOVEMENT: "MFI",
  CASH_CLOSING: "CIE",
  CORRECTION: "COR",
  INCIDENT: "INC",
  REDEMPTION: "CAN",
  PURCHASE_REVERSAL: "REV",
  SETTLEMENT_CORRECTION: "AJL",
  SPECIAL_PAYOUT: "PES",
} as const

/** Código del inventario físico único de fichas (ver docs/MODULE_04_CHIP_INVENTORY.md). */
export const SHARED_CHIP_SET_CODE = "CHIPSET_MAIN"

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

  // UN inventario físico compartido por todas las mesas (corrección
  // arquitectónica previa al Módulo 06): ambas mesas usan CHIPSET_MAIN.
  const sharedChipSet = await db.chipSet.upsert({
    where: { code: SHARED_CHIP_SET_CODE },
    create: {
      code: SHARED_CHIP_SET_CODE,
      name: "Inventario General de Fichas",
      description: "Inventario físico único compartido por todas las mesas.",
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
      defaultChipSetId: sharedChipSet.id,
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
      defaultChipSetId: sharedChipSet.id,
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
  // Módulo 08: cobros con terminal física (débito y crédito por separado).
  await db.paymentMethod.upsert({
    where: { code: "CARD_DEBIT" },
    create: {
      code: "CARD_DEBIT",
      name: "Tarjeta de débito (terminal)",
      sortOrder: 3,
    },
    update: {},
  })
  await db.paymentMethod.upsert({
    where: { code: "CARD_CREDIT" },
    create: {
      code: "CARD_CREDIT",
      name: "Tarjeta de crédito (terminal)",
      sortOrder: 4,
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
        ...(documentType === "SESSION" ? { padding: 4 } : {}),
      },
      update: {},
    })
  }

  await db.operationalSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  })

  await db.systemMaintenance.upsert({
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
