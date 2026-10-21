import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { Prisma } from "@/generated/prisma/client"
import {
  allocateFifo,
  appliedNet,
  ExcessPaymentError,
  fifoOrder,
  receivableStatus,
  splitApplicable,
} from "@/modules/credits/credit.math"
import {
  creditReceiptLines,
  creditReceiptText,
  type CreditReceiptContent,
} from "@/modules/credits/credit-receipt.content"
import {
  custodyDepositSchema,
  registerPaymentSchema,
  reversePaymentSchema,
} from "@/modules/credits/credit.schemas"

const D = (v: string) => new Prisma.Decimal(v)
const KEY = "clave-12345678"
const at = (iso: string) => new Date(iso)
const debts = () => [
  { id: "c", createdAt: at("2026-10-03T00:00:00Z"), balance: D("3000") },
  { id: "a", createdAt: at("2026-10-01T00:00:00Z"), balance: D("1000") },
  { id: "b", createdAt: at("2026-10-02T00:00:00Z"), balance: D("2000") },
]
const s = (v: Prisma.Decimal) => v.toFixed(2)

describe("motor FIFO", () => {
  it("el ejemplo del negocio: $2,500 sobre A=$1,000, B=$2,000, C=$3,000", () => {
    const r = allocateFifo(debts(), D("2500"))
    expect(
      r.map((x) => [x.receivableId, s(x.amount), s(x.balanceAfter), x.order])
    ).toEqual([
      ["a", "1000.00", "0.00", 1],
      ["b", "1500.00", "500.00", 2],
    ])
    expect(s(r.reduce((acc, x) => acc.add(x.amount), D("0")))).toBe("2500.00")
  })

  it("empate de fechas: desempate estable por identificador", () => {
    const same = at("2026-10-01T00:00:00Z")
    const order = fifoOrder([
      { id: "z", createdAt: same },
      { id: "m", createdAt: same },
      { id: "b", createdAt: same },
    ])
    expect(order.map((o) => o.id)).toEqual(["b", "m", "z"])
  })

  it("abono parcial, pago total y deudas ya pagadas se omiten", () => {
    expect(allocateFifo(debts(), D("300")).map((x) => s(x.amount))).toEqual([
      "300.00",
    ])
    const all = allocateFifo(debts(), D("6000"))
    expect(all.every((x) => x.balanceAfter.isZero())).toBe(true)
    const withPaid = [
      { id: "p", createdAt: at("2025-01-01T00:00:00Z"), balance: D("0") },
      ...debts(),
    ]
    expect(allocateFifo(withPaid, D("100"))[0].receivableId).toBe("a")
  })

  it("rechaza abonos superiores al saldo, importes no positivos y con más de dos decimales", () => {
    expect(() => allocateFifo(debts(), D("6000.01"))).toThrow(
      "El importe supera la deuda pendiente de $6000.00."
    )
    expect(() => allocateFifo(debts(), D("0"))).toThrow()
    expect(() => allocateFifo(debts(), D("-1"))).toThrow()
    expect(() => allocateFifo(debts(), D("1.234"))).toThrow(/dos decimales/)
    expect(() => allocateFifo([], D("1"))).toThrow(ExcessPaymentError)
  })
})

describe("saldos y estados derivados", () => {
  it("saldo = original − aplicaciones + reversos", () => {
    const applied = appliedNet([
      { kind: "APPLICATION", amount: D("700") },
      { kind: "APPLICATION", amount: D("300") },
      { kind: "REVERSAL", amount: D("300") },
    ])
    expect(s(applied)).toBe("700.00")
  })

  it("OPEN, PARTIALLY_PAID y PAID según el saldo real", () => {
    expect(receivableStatus(D("1000"), D("0"))).toBe("OPEN")
    expect(receivableStatus(D("1000"), D("1"))).toBe("PARTIALLY_PAID")
    expect(receivableStatus(D("1000"), D("1000"))).toBe("PAID")
    expect(receivableStatus(D("1000"), D("0"), true)).toBe("VOIDED")
  })

  it("dinero recibido que excede la deuda: se separa como no aplicado (sin saldo a favor)", () => {
    const r = splitApplicable(D("1000"), D("300"))
    expect([s(r.applicable), s(r.excess)]).toEqual(["300.00", "700.00"])
    const none = splitApplicable(D("500"), D("0"))
    expect([s(none.applicable), s(none.excess)]).toEqual(["0.00", "500.00"])
  })
})

describe("validación de abonos", () => {
  const base = {
    playerId: "p1",
    amount: "500",
    origin: "SESSION",
    idempotencyKey: KEY,
  }
  it("efectivo exige declarar recepción; el crédito no es método de pago", () => {
    expect(
      registerPaymentSchema.safeParse({
        ...base,
        method: "CASH",
        cashReceived: true,
      }).success
    ).toBe(true)
    expect(
      registerPaymentSchema.safeParse({ ...base, method: "CASH" }).success
    ).toBe(false)
    expect(
      registerPaymentSchema.safeParse({ ...base, method: "CREDIT" }).success
    ).toBe(false)
  })

  it("el cliente no envía la distribución FIFO, la sesión, el custodio ni el saldo", () => {
    for (const extra of [
      { allocations: [] },
      { sessionId: "s1" },
      { custodianUserId: "u1" },
      { balance: "0" },
      { folio: "ABN-1" },
    ])
      expect(
        registerPaymentSchema.safeParse({
          ...base,
          method: "CASH",
          cashReceived: true,
          ...extra,
        }).success
      ).toBe(false)
  })

  it("terminal aprobada exige folio y confirmación; rechazada no; nunca datos de tarjeta", () => {
    const card = { ...base, method: "CARD_DEBIT", result: "APPROVED" }
    expect(registerPaymentSchema.safeParse(card).success).toBe(false)
    expect(
      registerPaymentSchema.safeParse({
        ...card,
        terminalReference: "AUT-1",
        approvalConfirmed: true,
      }).success
    ).toBe(true)
    expect(
      registerPaymentSchema.safeParse({ ...card, result: "DECLINED" }).success
    ).toBe(true)
    expect(
      registerPaymentSchema.safeParse({
        ...card,
        terminalReference: "4111111111111111",
        approvalConfirmed: true,
      }).success
    ).toBe(false)
    expect(
      registerPaymentSchema.safeParse({
        ...card,
        terminalReference: "AUT-1",
        approvalConfirmed: true,
        cvv: "123",
      }).success
    ).toBe(false)
  })

  it("importes negativos, cero o con signo se rechazan", () => {
    for (const amount of ["0", "-5", "+5", "1.234", "abc"])
      expect(
        registerPaymentSchema.safeParse({
          ...base,
          amount,
          method: "CASH",
          cashReceived: true,
        }).success
      ).toBe(false)
  })

  it("reverso exige motivo y declarar la devolución; depósito de custodia exige verificación", () => {
    expect(
      reversePaymentSchema.safeParse({
        reason: "Error",
        moneyReturned: true,
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      reversePaymentSchema.safeParse({
        reason: "Se capturó al jugador equivocado",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      reversePaymentSchema.safeParse({
        reason: "Se capturó al jugador equivocado",
        moneyReturned: true,
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
    expect(
      custodyDepositSchema.safeParse({
        custodianUserId: "u1",
        amount: "100",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      custodyDepositSchema.safeParse({
        custodianUserId: "u1",
        amount: "100",
        depositVerified: true,
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })
})

describe("comprobante de abono", () => {
  const content: CreditReceiptContent = {
    receiptFormat: "1",
    paymentId: "pay1",
    folio: "ABN-000001",
    confirmedAt: "2026-10-20T18:00:00.000Z",
    player: { id: "p1", name: "Juan" },
    method: "BANK_TRANSFER",
    amount: "1500.00",
    applied: "1500.00",
    unapplied: "0.00",
    origin: "ADMINISTRATIVE",
    session: null,
    financialReference: "MOV-000010",
    confirmedBy: "Cajero",
    allocations: [
      {
        order: 1,
        purchaseFolio: "CMP-000001",
        sessionFolio: "SES-000001",
        tableName: "Mesa 25/25",
        amount: "1000.00",
        balanceAfter: "0.00",
      },
      {
        order: 2,
        purchaseFolio: "CMP-000004",
        sessionFolio: "SES-000002",
        tableName: "Mesa 10/10",
        amount: "500.00",
        balanceAfter: "1500.00",
      },
    ],
    remainingOutstanding: "1500.00",
  }
  it("muestra folio, método, origen, aplicaciones FIFO y saldo restante", () => {
    const text = creditReceiptText(content, "AVAILABLE")
    expect(text).toMatch(/ABN-000001/)
    expect(text).toMatch(/Transferencia verificada/)
    expect(text).toMatch(/Administrativo \(fuera de sesión\)/)
    expect(text).toMatch(
      /1\. CMP-000001 \(Mesa 25\/25\): \$1,000\.00 → resta \$0\.00/
    )
    expect(text).toMatch(/Deuda total restante: \$1,500\.00/)
    expect(text).not.toMatch(/a favor|pdf/i)
  })
  it("anulado y fondos no aplicados se indican", () => {
    expect(creditReceiptText(content, "VOIDED")).toMatch(/ANULADO/)
    expect(
      creditReceiptLines({ ...content, unapplied: "200.00" }).some((l) =>
        l.label.includes("sin aplicar")
      )
    ).toBe(true)
  })
})

describe("permisos", () => {
  it("los tres roles consultan créditos, registran abonos y operan la custodia", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.CREDITS_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CREDITS_OPERATE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CASH_OPERATE)).toBe(true)
    }
  })
})
