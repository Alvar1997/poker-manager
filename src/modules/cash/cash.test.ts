import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { OPERATIONAL_RULES } from "@/config/operational-rules"
import { Prisma } from "@/generated/prisma/client"
import {
  formatMoney,
  isBalanced,
  looksLikeOperatingExpense,
  money,
  settlementCashOut,
  shortfall,
  signedAmount,
  splitPayment,
} from "@/modules/cash/cash.math"
import {
  confirmBankTransferSchema,
  contributionSchema,
  createReconciliationSchema,
  reverseSchema,
  TRANSACTION_TYPES,
  withdrawalSchema,
} from "@/modules/cash/cash.schemas"
import {
  fixtureSessionGateway,
  NO_SESSION_MESSAGE,
  pendingSessionGateway,
  requireSessionStatus,
} from "@/modules/cash/session-gateway"

const D = (v: string) => new Prisma.Decimal(v)
const KEY = "key-12345678"

describe("aritmética de dinero (Decimal)", () => {
  it("redondea a 2 decimales sin errores de punto flotante", () => {
    expect(formatMoney(money("0.1").add(money("0.2")))).toBe("0.30")
    expect(formatMoney(money("10.005"))).toBe("10.01")
  })

  it("la apertura siempre parte de $0.00", () => {
    expect(formatMoney(money(0))).toBe("0.00")
  })

  it("débito suma y crédito resta", () => {
    expect(signedAmount("DEBIT", D("5")).toFixed(2)).toBe("5.00")
    expect(signedAmount("CREDIT", D("5")).toFixed(2)).toBe("-5.00")
  })

  it("una transacción cuadra solo si débitos = créditos y tiene al menos dos partidas", () => {
    expect(
      isBalanced([
        { direction: "DEBIT", amount: D("10") },
        { direction: "CREDIT", amount: D("10") },
      ])
    ).toBe(true)
    expect(
      isBalanced([
        { direction: "DEBIT", amount: D("10") },
        { direction: "CREDIT", amount: D("9.99") },
      ])
    ).toBe(false)
    expect(isBalanced([{ direction: "DEBIT", amount: D("10") }])).toBe(false)
  })

  it("calcula el faltante exacto de un retiro ($1000 disponibles, $1500 solicitados → $500)", () => {
    expect(shortfall(D("1000"), D("1500")).toFixed(2)).toBe("500.00")
    expect(shortfall(D("1000"), D("1000")).toFixed(2)).toBe("0.00")
  })
})

describe("pagos mixtos (MIX)", () => {
  it("separa efectivo, transferencia pendiente y crédito; solo el efectivo es dinero inmediato", () => {
    const r = splitPayment(D("3000"), [
      { method: "CASH", amount: D("1000") },
      { method: "BANK_TRANSFER", amount: D("1500") },
      { method: "CREDIT", amount: D("500") },
    ])
    expect(formatMoney(r.moneyReceivedNow)).toBe("1000.00")
    expect(formatMoney(r.bankPending)).toBe("1500.00")
    expect(formatMoney(r.credit)).toBe("500.00")
  })

  it("rechaza componentes que exceden o no cubren el importe", () => {
    expect(() =>
      splitPayment(D("100"), [{ method: "CASH", amount: D("150") }])
    ).toThrow(/exceden/)
    expect(() =>
      splitPayment(D("100"), [{ method: "CASH", amount: D("50") }])
    ).toThrow(/no cubren/)
  })

  it("rechaza componentes repetidos, en cero o importes no positivos", () => {
    expect(() =>
      splitPayment(D("100"), [
        { method: "CASH", amount: D("50") },
        { method: "CASH", amount: D("50") },
      ])
    ).toThrow(/repetido/)
    expect(() =>
      splitPayment(D("100"), [
        { method: "CASH", amount: D("100") },
        { method: "CREDIT", amount: D("0") },
      ])
    ).toThrow()
    expect(() => splitPayment(D("0"), [])).toThrow()
  })

  it("un pago 100% a crédito no genera dinero", () => {
    const r = splitPayment(D("800"), [{ method: "CREDIT", amount: D("800") }])
    expect(r.moneyReceivedNow.isZero()).toBe(true)
    expect(r.bankPending.isZero()).toBe(true)
  })
})

describe("liquidaciones", () => {
  it("la compensación de deuda no sale de caja: solo el neto", () => {
    expect(formatMoney(settlementCashOut(D("1500"), D("700")))).toBe("800.00")
    expect(formatMoney(settlementCashOut(D("800"), D("800")))).toBe("0.00")
  })

  it("la compensación no puede exceder el valor de las fichas", () => {
    expect(() => settlementCashOut(D("100"), D("200"))).toThrow()
  })
})

describe("sin gastos operativos", () => {
  it("el catálogo de tipos no contiene gastos", () => {
    for (const t of TRANSACTION_TYPES) expect(t).not.toMatch(/EXPENSE|OTHER/)
  })

  it("detecta motivos de gasto evidentes (con o sin acentos) sin falsos positivos comunes", () => {
    expect(looksLikeOperatingExpense("Compra de comida")).toBe(true)
    expect(looksLikeOperatingExpense("Bebidas para la mesa")).toBe(true)
    expect(looksLikeOperatingExpense("Pago de PAPELERÍA")).toBe(true)
    expect(looksLikeOperatingExpense("Entrega al propietario")).toBe(false)
    expect(looksLikeOperatingExpense("Resguardo en caja fuerte")).toBe(false)
  })

  it("el retiro no acepta destinos fuera del catálogo (ni el de cierre)", () => {
    const base = {
      sessionId: "S1",
      amount: "100",
      recipientName: "Socio",
      reason: "Entrega",
      idempotencyKey: KEY,
    }
    expect(
      withdrawalSchema.safeParse({ ...base, destination: "OWNER_CUSTODY" })
        .success
    ).toBe(true)
    expect(
      withdrawalSchema.safeParse({ ...base, destination: "EXPENSE" }).success
    ).toBe(false)
    expect(
      withdrawalSchema.safeParse({ ...base, destination: "SESSION_CLOSING" })
        .success
    ).toBe(false)
  })
})

describe("validación de entradas", () => {
  it("aportación: importe positivo como texto, procedencia, motivo y clave obligatorios", () => {
    const ok = {
      sessionId: "S1",
      amount: "1500.50",
      contributorName: "Socio",
      reason: "Fondos",
      idempotencyKey: KEY,
    }
    expect(contributionSchema.safeParse(ok).success).toBe(true)
    expect(contributionSchema.safeParse({ ...ok, amount: "0" }).success).toBe(
      false
    )
    expect(contributionSchema.safeParse({ ...ok, amount: "-10" }).success).toBe(
      false
    )
    expect(contributionSchema.safeParse({ ...ok, amount: 100 }).success).toBe(
      false
    )
    expect(
      contributionSchema.safeParse({ ...ok, amount: "1.234" }).success
    ).toBe(false)
    expect(
      contributionSchema.safeParse({ ...ok, contributorName: "" }).success
    ).toBe(false)
    expect(
      contributionSchema.safeParse({ ...ok, idempotencyKey: undefined }).success
    ).toBe(false)
    expect(
      contributionSchema.safeParse({ ...ok, role: "SUPERADMIN" }).success
    ).toBe(false)
  })

  it("confirmar transferencia exige declarar la verificación en el banco", () => {
    expect(confirmBankTransferSchema.safeParse({}).success).toBe(false)
    expect(
      confirmBankTransferSchema.safeParse({ verifiedInBank: false }).success
    ).toBe(false)
    expect(
      confirmBankTransferSchema.safeParse({ verifiedInBank: true }).success
    ).toBe(true)
  })

  it("reverso exige motivo", () => {
    expect(reverseSchema.safeParse({ idempotencyKey: KEY }).success).toBe(false)
    expect(
      reverseSchema.safeParse({
        reason: "Error de captura",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })

  it("arqueo de efectivo: importe o desglose con denominaciones válidas", () => {
    expect(
      createReconciliationSchema.safeParse({
        sessionId: "S1",
        reconciliationType: "OPENING",
      }).success
    ).toBe(false)
    expect(
      createReconciliationSchema.safeParse({
        sessionId: "S1",
        reconciliationType: "OPENING",
        countedAmount: "0",
      }).success
    ).toBe(true)
    expect(
      createReconciliationSchema.safeParse({
        sessionId: "S1",
        reconciliationType: "CONTROL",
        details: [{ unitValue: "500", quantity: 2 }],
      }).success
    ).toBe(true)
    expect(
      createReconciliationSchema.safeParse({
        sessionId: "S1",
        reconciliationType: "CONTROL",
        details: [{ unitValue: "300", quantity: 2 }],
      }).success
    ).toBe(false)
    expect(
      createReconciliationSchema.safeParse({
        sessionId: "S1",
        reconciliationType: "ADJUST",
        countedAmount: "0",
      }).success
    ).toBe(false)
  })
})

describe("sesiones y permisos", () => {
  it("sin Módulo 06 no hay sesión: las operaciones de efectivo se bloquean", async () => {
    expect(await pendingSessionGateway.getOpenSession()).toBeNull()
    await expect(
      requireSessionStatus(pendingSessionGateway, "S1", ["OPEN"])
    ).rejects.toThrow(NO_SESSION_MESSAGE)
  })

  it("una sesión en estado incorrecto se rechaza", async () => {
    const gw = fixtureSessionGateway({ S1: "PREPARATION", S2: "OPEN" })
    await expect(requireSessionStatus(gw, "S1", ["OPEN"])).rejects.toThrow(
      /PREPARATION/
    )
    await expect(
      requireSessionStatus(gw, "S2", ["OPEN"])
    ).resolves.toMatchObject({ id: "S2" })
  })

  it("los tres roles leen y operan la caja (incluida la verificación manual de transferencias)", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.CASH_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CASH_OPERATE)).toBe(true)
    }
  })

  it("las reglas fijas declaran apertura en $0, sin negativos y sin gastos", () => {
    const ids = OPERATIONAL_RULES.map((r) => r.id)
    for (const id of [
      "ZERO_OPENING_BALANCE",
      "NO_NEGATIVE_CASH",
      "NO_OPERATING_EXPENSES",
      "MANUAL_BANK_VERIFICATION",
      "CHIP_COUNT_BEFORE_OPENING",
    ]) {
      expect(ids).toContain(id)
    }
  })
})
