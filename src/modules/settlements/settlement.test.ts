import { describe, expect, it } from "vitest"

import { roleHasPermission, PERMISSIONS } from "@/config/permission-matrix"
import { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
import {
  settlementReceiptLines,
  settlementReceiptText,
  type SettlementReceiptContent,
} from "@/modules/settlements/settlement-receipt.content"
import {
  CURRENT_SETTLEMENT_DECLARATION_VERSION,
  currentSettlementDeclaration,
  SETTLEMENT_DECLARATIONS,
} from "@/modules/settlements/settlement.declaration"
import {
  assertPayoutFits,
  payableState,
  planSettlement,
  resolveOffset,
  SettlementRuleError,
} from "@/modules/settlements/settlement.math"
import {
  confirmReturnSchema,
  createSettlementSchema,
  registerPayoutSchema,
  resolvePayoutSchema,
  updateSettlementDraftSchema,
} from "@/modules/settlements/settlement.schemas"

const D = (v: string | number) => new Prisma.Decimal(v)
const debts = (...balances: number[]) =>
  balances.map((b, i) => ({
    id: `d${i + 1}`,
    createdAt: new Date(2026, 0, i + 1),
    balance: D(b),
  }))
const key = "clave-de-prueba-123"

describe("compensación opcional y FIFO", () => {
  it("NO_COMPENSATE no aplica deuda aunque exista: el neto es todo lo devuelto", () => {
    const p = planSettlement({
      returned: D(8000),
      receivables: debts(5000),
      decision: "NO_COMPENSATE",
    })
    expect(p.offset.toFixed(2)).toBe("0.00")
    expect(p.allocations).toEqual([])
    expect(p.net.toFixed(2)).toBe("8000.00")
    expect(p.remainingDebt.toFixed(2)).toBe("5000.00")
  })

  it("PARTIAL: fichas $8,000, deuda $5,000, compensa $2,000 → neto $6,000 y resta $3,000", () => {
    const p = planSettlement({
      returned: D(8000),
      receivables: debts(5000),
      decision: "PARTIAL",
      requested: D(2000),
    })
    expect(p.net.toFixed(2)).toBe("6000.00")
    expect(p.remainingDebt.toFixed(2)).toBe("3000.00")
  })

  it("MAXIMUM: compensa min(fichas, deuda)", () => {
    const a = planSettlement({
      returned: D(8000),
      receivables: debts(5000),
      decision: "MAXIMUM",
    })
    expect([a.offset.toFixed(2), a.net.toFixed(2)]).toEqual([
      "5000.00",
      "3000.00",
    ])
    const b = planSettlement({
      returned: D(3000),
      receivables: debts(5000),
      decision: "MAXIMUM",
    })
    expect([b.offset.toFixed(2), b.net.toFixed(2)]).toEqual(["3000.00", "0.00"])
  })

  it("FIFO del ejemplo: A $1,000, B $2,000, C $3,000 y $2,500 → A $1,000, B $1,500, C $0", () => {
    const p = planSettlement({
      returned: D(9000),
      receivables: debts(1000, 2000, 3000),
      decision: "PARTIAL",
      requested: D(2500),
    })
    expect(
      p.allocations.map((a) => [a.receivableId, a.amount.toFixed(2)])
    ).toEqual([
      ["d1", "1000.00"],
      ["d2", "1500.00"],
    ])
  })

  it("rechaza compensar más que las fichas, más que la deuda, con $0 devueltos o sin deuda", () => {
    const base = { outstanding: D(1000) }
    expect(() =>
      resolveOffset({
        ...base,
        returned: D(500),
        decision: "PARTIAL",
        requested: D(600),
      })
    ).toThrow(/valor de las fichas/)
    expect(() =>
      resolveOffset({
        ...base,
        returned: D(5000),
        decision: "PARTIAL",
        requested: D(1500),
      })
    ).toThrow(/deuda pendiente/)
    expect(() =>
      resolveOffset({ ...base, returned: D(0), decision: "MAXIMUM" })
    ).toThrow(/\$0 en fichas/)
    expect(() =>
      resolveOffset({
        outstanding: D(0),
        returned: D(100),
        decision: "PARTIAL",
        requested: D(50),
      })
    ).toThrow(/no tiene deuda/)
    expect(() =>
      resolveOffset({ ...base, returned: D(-1), decision: "NO_COMPENSATE" })
    ).toThrow(SettlementRuleError)
    expect(() =>
      resolveOffset({
        ...base,
        returned: D(100),
        decision: "MAXIMUM",
        requested: D(10),
      })
    ).toThrow(/Solo la compensación parcial/)
  })

  it("devolución de $0 sin compensación es válida (neto $0)", () => {
    const p = planSettlement({
      returned: D(0),
      receivables: debts(700),
      decision: "NO_COMPENSATE",
    })
    expect(p.net.toFixed(2)).toBe("0.00")
    expect(p.remainingDebt.toFixed(2)).toBe("700.00")
  })
})

describe("cuenta por pagar y desembolsos", () => {
  it("la transferencia PENDING no cuenta como pagada pero reserva el importe", () => {
    const s = payableState(D(8000), [
      { amount: D(3000), status: "EXECUTED" },
      { amount: D(2000), status: "PENDING" },
      { amount: D(1000), status: "FAILED" },
    ])
    expect({
      executed: s.executed.toFixed(2),
      reserved: s.reserved.toFixed(2),
      pending: s.pending.toFixed(2),
      available: s.available.toFixed(2),
      status: s.status,
    }).toEqual({
      executed: "3000.00",
      reserved: "2000.00",
      pending: "5000.00",
      available: "3000.00",
      status: "PARTIALLY_PAID",
    })
    expect(() => assertPayoutFits(s, D(3500))).toThrow(/en trámite/)
    expect(() => assertPayoutFits(s, D(0))).toThrow(/mayor que cero/)
    expect(() => assertPayoutFits(s, D(3000))).not.toThrow()
  })

  it("estados derivados: OPEN, PAID; una obligación de $0 ya está pagada", () => {
    expect(payableState(D(100), []).status).toBe("OPEN")
    expect(
      payableState(D(100), [{ amount: D(100), status: "EXECUTED" }]).status
    ).toBe("PAID")
    expect(payableState(D(0), []).status).toBe("PAID")
    expect(() =>
      assertPayoutFits(
        payableState(D(100), [{ amount: D(100), status: "EXECUTED" }]),
        D(1)
      )
    ).toThrow(/ya está pagada/)
  })
})

describe("schemas: solo importe nominal y decisión explícita", () => {
  const base = {
    participationId: "part_1",
    returnedNominalAmount: "8000",
    offsetDecision: "NO_COMPENSATE",
    idempotencyKey: key,
  }
  it("acepta $0 y rechaza denominaciones, distribución FIFO, neto o jugador del cliente", () => {
    expect(
      createSettlementSchema.safeParse({ ...base, returnedNominalAmount: "0" })
        .success
    ).toBe(true)
    for (const extra of [
      { denominations: [{ value: "500", quantity: 2 }] },
      { allocations: [{ receivableId: "x", amount: "1" }] },
      { netPayoutAmount: "1" },
      { playerId: "p" },
      { sessionId: "s" },
    ])
      expect(
        createSettlementSchema.safeParse({ ...base, ...extra }).success
      ).toBe(false)
  })
  it("la decisión es obligatoria; PARTIAL exige importe y las demás no lo admiten", () => {
    const { offsetDecision: _omit, ...noDecision } = base
    void _omit
    expect(createSettlementSchema.safeParse(noDecision).success).toBe(false)
    expect(
      createSettlementSchema.safeParse({ ...base, offsetDecision: "PARTIAL" })
        .success
    ).toBe(false)
    expect(
      createSettlementSchema.safeParse({
        ...base,
        offsetDecision: "PARTIAL",
        offsetAmount: "100",
      }).success
    ).toBe(true)
    expect(
      createSettlementSchema.safeParse({
        ...base,
        offsetDecision: "MAXIMUM",
        offsetAmount: "100",
      }).success
    ).toBe(false)
    expect(
      createSettlementSchema.safeParse({ ...base, returnedNominalAmount: "-5" })
        .success
    ).toBe(false)
    expect(
      createSettlementSchema.safeParse({
        ...base,
        returnedNominalAmount: "1.234",
      }).success
    ).toBe(false)
  })
  it("la recepción exige declarar fichas recibidas y no acepta «firmado = true»", () => {
    expect(
      confirmReturnSchema.safeParse({
        expectedVersion: 1,
        chipsReceived: true,
        idempotencyKey: key,
      }).success
    ).toBe(true)
    expect(
      confirmReturnSchema.safeParse({
        expectedVersion: 1,
        chipsReceived: false,
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      confirmReturnSchema.safeParse({
        expectedVersion: 1,
        chipsReceived: true,
        signed: true,
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      confirmReturnSchema.safeParse({
        expectedVersion: 1,
        chipsReceived: true,
        immediateCashAmount: "10",
        idempotencyKey: key,
      }).success
    ).toBe(false)
  })
  it("pagos: efectivo exige entrega declarada; la ejecución bancaria exige referencia y verificación", () => {
    expect(
      registerPayoutSchema.safeParse({
        method: "CASH",
        amount: "10",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      registerPayoutSchema.safeParse({
        method: "CASH",
        amount: "10",
        cashDelivered: true,
        idempotencyKey: key,
      }).success
    ).toBe(true)
    expect(
      registerPayoutSchema.safeParse({
        method: "CARD_CREDIT",
        amount: "10",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      registerPayoutSchema.safeParse({
        method: "BANK_TRANSFER",
        amount: "10",
        bankReference: "4111111111111111",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      resolvePayoutSchema.safeParse({
        outcome: "EXECUTED",
        bankReference: "SPEI-1",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      resolvePayoutSchema.safeParse({
        outcome: "EXECUTED",
        bankReference: "SPEI-1",
        executionVerified: true,
        idempotencyKey: key,
      }).success
    ).toBe(true)
    expect(
      resolvePayoutSchema.safeParse({
        outcome: "FAILED",
        reason: "x",
        idempotencyKey: key,
      }).success
    ).toBe(false)
  })
  it("la edición exige la versión revisada", () => {
    expect(
      updateSettlementDraftSchema.safeParse({ returnedNominalAmount: "5" })
        .success
    ).toBe(false)
    expect(
      updateSettlementDraftSchema.safeParse({
        expectedVersion: 2,
        returnedNominalAmount: "5",
      }).success
    ).toBe(true)
  })
})

describe("firma y comprobantes", () => {
  it("la declaración vigente es la versionada y no cambia el texto firmado", () => {
    const d = currentSettlementDeclaration()
    expect(d.version).toBe(CURRENT_SETTLEMENT_DECLARATION_VERSION)
    expect(d.text).toBe(SETTLEMENT_DECLARATIONS[d.version])
    expect(d.text).toMatch(/pagos pendientes se registrarán/)
  })

  it("la huella canónica no depende del orden de las claves", () => {
    expect(canonicalHash({ a: "1.00", b: [{ x: "2", y: "3" }] })).toBe(
      canonicalHash({ b: [{ y: "3", x: "2" }], a: "1.00" })
    )
  })

  const content: SettlementReceiptContent = {
    receiptFormat: "1",
    kind: "RECEPTION",
    settlementId: "s1",
    folio: "LIQ-000001",
    issuedAt: "2026-10-25T03:00:00.000Z",
    player: { id: "p1", name: "Jugador" },
    session: { id: "x", folio: "SES-1" },
    table: { id: "t", name: "Mesa 10/10" },
    returnedNominalAmount: "8000.00",
    offsetDecision: "PARTIAL",
    offsetAmount: "2500.00",
    allocations: [
      {
        order: 1,
        purchaseFolio: "CMP-1",
        tableName: "Mesa 25/25",
        amount: "1000.00",
        balanceAfter: "0.00",
      },
      {
        order: 2,
        purchaseFolio: "CMP-2",
        tableName: "Mesa 25/25",
        amount: "1500.00",
        balanceAfter: "500.00",
      },
    ],
    remainingDebt: "3500.00",
    netPayoutAmount: "5500.00",
    paidAtIssue: "3000.00",
    inTransitAtIssue: "2000.00",
    pendingAtIssue: "2500.00",
    payouts: [
      {
        sequence: 1,
        method: "CASH",
        funding: "SESSION_CASH",
        amount: "3000.00",
        reference: null,
        executedAt: "2026-10-25T03:00:00.000Z",
      },
    ],
    payout: null,
    settlementStatus: "PENDING_PAYOUT",
    receivedBy: "Cajero",
    receivedAt: "2026-10-25T03:00:00.000Z",
    issuedBy: "Cajero",
    signature: {
      signatureId: "sig",
      signedAt: "2026-10-25T02:59:00.000Z",
      snapshotDigest: "a".repeat(64),
    },
    chipReturnOperationId: "op",
  }

  it("el comprobante distingue el pago acordado de lo pagado y no presenta la transferencia en trámite como pagada", () => {
    const text = settlementReceiptText(content, "AVAILABLE")
    expect(text).toMatch(/Pago neto acordado: .*5,500/)
    expect(text).toMatch(/Pagado al emitir: .*3,000/)
    expect(text).toMatch(/Transferencia en trámite \(no pagada\)/)
    expect(text).toMatch(/Pendiente de pago: .*2,500/)
    expect(text).not.toMatch(/pdf/i)
    expect(text).not.toMatch(/denominaci/i)
    const labels = settlementReceiptLines(content).map((l) => l.label)
    expect(labels).toContain("Firma")
  })

  it("el anexo de pago documenta solo ese desembolso", () => {
    const annex: SettlementReceiptContent = {
      ...content,
      kind: "PAYOUT",
      payout: {
        sequence: 2,
        method: "BANK_TRANSFER",
        funding: "BANK",
        amount: "2000.00",
        reference: "SPEI-1",
        executedAt: "2026-10-26T03:00:00.000Z",
      },
    }
    const text = settlementReceiptText(annex, "AVAILABLE")
    expect(text).toMatch(/Anexo de pago LIQ-000001 · Pago 2/)
    expect(text).toMatch(/SPEI-1/)
    expect(settlementReceiptText(annex, "VOIDED")).toMatch(/ANULADO/)
  })
})

describe("permisos", () => {
  it("los tres roles liquidan, firman, pagan y confirman transferencias", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const)
      for (const p of [
        PERMISSIONS.SETTLEMENTS_READ,
        PERMISSIONS.SETTLEMENTS_OPERATE,
        PERMISSIONS.SIGNATURES_READ,
        PERMISSIONS.CASH_OPERATE,
      ])
        expect(roleHasPermission(role, p)).toBe(true)
  })
})

describe("OUT y recepción", () => {
  const base = {
    participationId: "cmparticipation0000000001",
    offsetDecision: "NO_COMPENSATE" as const,
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  }
  it("OUT solo con retorno $0 y sin compensación", () => {
    expect(
      createSettlementSchema.safeParse({
        ...base,
        returnedNominalAmount: "0",
        exitKind: "OUT",
      }).success
    ).toBe(true)
    expect(
      createSettlementSchema.safeParse({
        ...base,
        returnedNominalAmount: "500",
        exitKind: "OUT",
      }).success
    ).toBe(false)
    expect(
      createSettlementSchema.safeParse({
        ...base,
        returnedNominalAmount: "0",
        offsetDecision: "MAXIMUM",
        exitKind: "OUT",
      }).success
    ).toBe(false)
  })
  it("confirmar sin «fichas recibidas» es válido en el esquema (el servidor lo exige solo si hubo fichas)", () => {
    expect(
      confirmReturnSchema.safeParse({
        expectedVersion: 1,
        zeroReturnConfirmed: true,
        idempotencyKey: base.idempotencyKey,
      }).success
    ).toBe(true)
  })
})
