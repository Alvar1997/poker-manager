import type { PrismaClient } from "@/generated/prisma/client"

/**
 * Catálogo de cuentas financieras de la Caja Central (Módulo 05).
 * IDEMPOTENTE (upsert por `kind`, `update: {}`). Solo catálogo: NO crea
 * saldos, movimientos, transferencias, aportaciones ni gastos.
 */
export const FINANCIAL_ACCOUNTS = [
  {
    kind: "CASH_ON_HAND",
    code: "EFECTIVO",
    name: "Efectivo en caja",
    isMoney: true,
    scope: "SESSION",
    nonNegative: true,
  },
  {
    kind: "BANK",
    code: "BANCO",
    name: "Cuenta bancaria receptora",
    isMoney: true,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "CASH_IN_TRANSIT",
    code: "EN_TRANSITO",
    name: "Depósitos en tránsito al banco",
    isMoney: true,
    scope: "GLOBAL",
    nonNegative: true,
  },
  {
    kind: "OWNER_CONTRIBUTIONS",
    code: "APORTACIONES",
    name: "Aportaciones de efectivo",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "CASH_WITHDRAWALS",
    code: "RETIROS",
    name: "Retiros de efectivo",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "PLAYER_PURCHASES",
    code: "COBROS_COMPRAS",
    name: "Cobros por compras de fichas",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "PLAYER_DEBT_PAYMENTS",
    code: "COBROS_ABONOS",
    name: "Cobros por abonos a deuda",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "PLAYER_SETTLEMENTS",
    code: "PAGOS_LIQUIDACIONES",
    name: "Pagos por liquidaciones",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "CARD_TERMINAL_CLEARING",
    code: "TERMINAL_POR_LIQUIDAR",
    name: "Cobros con terminal por liquidar",
    isMoney: true,
    scope: "GLOBAL",
    nonNegative: true,
  },
  {
    kind: "ADMIN_CASH_CUSTODY",
    code: "CUSTODIA_ADMINISTRATIVA",
    name: "Efectivo administrativo en custodia",
    isMoney: true,
    scope: "CUSTODIAN",
    nonNegative: true,
  },
  {
    kind: "UNAPPLIED_PLAYER_FUNDS",
    code: "FONDOS_NO_APLICADOS",
    name: "Fondos recibidos no aplicados (por devolver)",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
  {
    kind: "RECONCILIATION_DIFFERENCES",
    code: "DIFERENCIAS_ARQUEO",
    name: "Diferencias de arqueo de efectivo",
    isMoney: false,
    scope: "GLOBAL",
    nonNegative: false,
  },
] as const

export type FinancialAccountKindValue =
  (typeof FINANCIAL_ACCOUNTS)[number]["kind"]

export async function seedFinancialAccounts(db: PrismaClient): Promise<void> {
  const cashBox = await db.cashBox.findUnique({
    where: { code: "MAIN" },
    select: { id: true },
  })
  if (!cashBox) return // Requiere la Caja Central del Módulo 02.
  for (const account of FINANCIAL_ACCOUNTS) {
    await db.financialAccount.upsert({
      where: { kind: account.kind },
      create: { ...account, cashBoxId: cashBox.id },
      update: {},
    })
  }
}
