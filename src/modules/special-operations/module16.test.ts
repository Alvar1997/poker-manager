// @vitest-environment node
import { describe, expect, it } from "vitest"

import { PERMISSIONS } from "@/config/permission-matrix"
import { roleHasPermission } from "@/config/permission-matrix"
import { Prisma } from "@/generated/prisma/client"
import { moduleOfAction } from "@/modules/audit/audit-taxonomy"
import {
  CORRECTION_TYPE_META,
  displayStatus,
} from "@/modules/corrections/correction.rules"
import type { PaymentLike } from "@/modules/purchases/purchase.math"
import { classifyAllocation } from "@/modules/reports/report.math"

import {
  confirmRedemptionReceiptSchema,
  createRedemptionSchema,
  executePurchaseReversalSchema,
  executeSettlementCorrectionSchema,
  registerPayoutSchema,
  resolvePayoutSchema,
  validateRedemptionSchema,
} from "./special.schemas"
import {
  assertPayoutWithin,
  payableState,
  PayoutExceedsError,
  planPurchaseReversal,
  planSettlementCorrection,
  redemptionStatusFor,
  unappliedStatusFor,
  validateRedemption,
  type AllocationLite,
  type PurchaseReversalFacts,
} from "./special.math"

const D = (v: string | number) => new Prisma.Decimal(v)
const cash = (amount: string): PaymentLike => ({
  id: `c${amount}`,
  method: "CASH",
  amount: D(amount),
  status: "CONFIRMED",
})
const transfer = (
  amount: string,
  st: "CONFIRMED" | "PENDING_VERIFICATION"
): PaymentLike => ({
  id: `t${amount}`,
  method: "BANK_TRANSFER",
  amount: D(amount),
  status: "PENDING",
  transferStatus: st,
  transferConfirmedAmount: st === "CONFIRMED" ? D(amount) : null,
})
const alloc = (
  source: AllocationLite["source"],
  amount: string,
  kind: AllocationLite["kind"] = "APPLICATION"
): AllocationLite => ({ source, amount: D(amount), kind })

function facts(
  over: Partial<PurchaseReversalFacts> = {}
): PurchaseReversalFacts {
  return {
    status: "CONFIRMED",
    nominal: D(5000),
    payments: [cash("2000")],
    debt: { original: D(3000), allocations: [] },
    alreadyReversed: false,
    approvedCorrection: true,
    physicalReturn: { confirmed: true, nominal: D(5000) },
    sessionStatus: "OPEN",
    participationSettled: false,
    ...over,
  }
}

const STROKES = [
  [
    [1, 1],
    [2, 2],
  ],
]
const KEY = "k-12345678"

describe("obligaciones especiales (saldo derivado)", () => {
  it("una obligación sin pagos está OPEN", () => {
    expect(payableState(D(1000), []).status).toBe("OPEN")
  })
  it("solo lo EJECUTADO paga; una transferencia pendiente no", () => {
    const s = payableState(D(1000), [{ amount: D(600), status: "PENDING" }])
    expect(s.status).toBe("OPEN")
    expect(s.pending.toFixed(2)).toBe("1000.00")
    expect(s.available.toFixed(2)).toBe("400.00")
  })
  it("pago parcial → PARTIALLY_PAID con pendiente real", () => {
    const s = payableState(D(1000), [{ amount: D(600), status: "EXECUTED" }])
    expect(s.status).toBe("PARTIALLY_PAID")
    expect(s.pending.toFixed(2)).toBe("400.00")
  })
  it("pagos ejecutados por el total → PAID", () => {
    const s = payableState(D(1000), [
      { amount: D(600), status: "EXECUTED" },
      { amount: D(400), status: "EXECUTED" },
    ])
    expect(s.status).toBe("PAID")
  })
  it("pagos fallidos o cancelados no cuentan", () => {
    const s = payableState(D(500), [
      { amount: D(500), status: "FAILED" },
      { amount: D(500), status: "CANCELLED" },
    ])
    expect(s.status).toBe("OPEN")
    expect(s.available.toFixed(2)).toBe("500.00")
  })
  it("no se paga más que lo pendiente menos lo comprometido", () => {
    expect(() =>
      assertPayoutWithin(D(500), D(1000), [
        { amount: D(600), status: "EXECUTED" },
      ])
    ).toThrow(PayoutExceedsError)
    expect(() =>
      assertPayoutWithin(D(1), D(1000), [
        { amount: D(1000), status: "PENDING" },
      ])
    ).toThrow(/comprometido/)
  })
  it("rechaza pagos en cero o con más de dos decimales", () => {
    expect(() => assertPayoutWithin(D(0), D(10), [])).toThrow(/mayor que cero/)
    expect(() => assertPayoutWithin(D("1.005"), D(10), [])).toThrow(/decimales/)
  })
  it("el estado del canje se deriva del de su obligación", () => {
    expect(redemptionStatusFor(payableState(D(10), []))).toBe("PAYMENT_PENDING")
    expect(
      redemptionStatusFor(
        payableState(D(10), [{ amount: D(5), status: "EXECUTED" }])
      )
    ).toBe("PARTIALLY_PAID")
    expect(
      redemptionStatusFor(
        payableState(D(10), [{ amount: D(10), status: "EXECUTED" }])
      )
    ).toBe("PAID")
  })
})

describe("16.1 validación del canje", () => {
  it("acepta dentro de lo presentado y de la circulación", () => {
    const v = validateRedemption({
      presented: D(1000),
      accepted: D(1000),
      globalCirculation: D(3000),
    })
    expect(v.ok).toBe(true)
    expect(v.rejected.toFixed(2)).toBe("0.00")
  })
  it("nunca más de lo presentado", () => {
    expect(
      validateRedemption({
        presented: D(500),
        accepted: D(600),
        globalCirculation: D(3000),
      }).ok
    ).toBe(false)
  })
  it("nunca más que la circulación global (no regresan más fichas de las que salieron)", () => {
    const v = validateRedemption({
      presented: D(5000),
      accepted: D(4000),
      globalCirculation: D(3000),
    })
    expect(v.ok).toBe(false)
    expect(v.problems.join(" ")).toMatch(/circulación/)
  })
  it("el conteo por denominación debe sumar exactamente lo aceptado", () => {
    expect(
      validateRedemption({
        presented: D(1000),
        accepted: D(1000),
        globalCirculation: D(3000),
        denominations: [{ unitValue: D(500), quantity: 2 }],
      }).ok
    ).toBe(true)
    expect(
      validateRedemption({
        presented: D(1000),
        accepted: D(1000),
        globalCirculation: D(3000),
        denominations: [{ unitValue: D(500), quantity: 1 }],
      }).ok
    ).toBe(false)
  })
  it("cantidades por denominación enteras y no negativas", () => {
    expect(
      validateRedemption({
        presented: D(1000),
        accepted: D(0),
        globalCirculation: D(3000),
        denominations: [{ unitValue: D(500), quantity: -1 }],
      }).ok
    ).toBe(false)
  })
  it("lo rechazado es presentado − aceptado", () => {
    expect(
      validateRedemption({
        presented: D(1000),
        accepted: D(700),
        globalCirculation: D(3000),
      }).rejected.toFixed(2)
    ).toBe("300.00")
  })
})

describe("16.2 plan de reverso de compra", () => {
  it("Escenario B: 5,000 = 2,000 efectivo + 3,000 crédito → extingue 3,000 y reembolsa 2,000", () => {
    const p = planPurchaseReversal(facts())
    expect(p.executable).toBe(true)
    expect(p.classification).toBe("FULL_REVERSAL")
    expect(p.effects).toMatchObject({
      extinguish: "3000.00",
      refund: "2000.00",
      identityOk: true,
    })
  })
  it("sin devolución física: PHYSICAL_RETURN_PENDING y no ejecutable", () => {
    const p = planPurchaseReversal(
      facts({ physicalReturn: { confirmed: false, nominal: null } })
    )
    expect(p.executable).toBe(false)
    expect(p.classification).toBe("PHYSICAL_RETURN_PENDING")
  })
  it("devolución parcial: bloquea (nunca una restitución ficticia)", () => {
    const p = planPurchaseReversal(
      facts({ physicalReturn: { confirmed: true, nominal: D(3000) } })
    )
    expect(p.executable).toBe(false)
    expect(p.blockers.join(" ")).toMatch(/valor completo/)
  })
  it("sin corrección aprobada: bloquea", () => {
    expect(
      planPurchaseReversal(facts({ approvedCorrection: false })).executable
    ).toBe(false)
  })
  it("un borrador se cancela, no se revierte", () => {
    expect(
      planPurchaseReversal(facts({ status: "DRAFT" })).classification
    ).toBe("CANCEL_PURCHASE")
  })
  it("ya revertida: no se repite", () => {
    expect(
      planPurchaseReversal(facts({ alreadyReversed: true })).classification
    ).toBe("ALREADY_REVERSED")
  })
  it("transferencia pendiente: no reversible automáticamente", () => {
    const p = planPurchaseReversal(
      facts({
        payments: [cash("2000"), transfer("1000", "PENDING_VERIFICATION")],
        debt: { original: D(3000), allocations: [] },
      })
    )
    expect(p.classification).toBe("NOT_REVERSIBLE_AUTOMATICALLY")
    expect(p.executable).toBe(false)
  })
  it("abonos aplicados a la deuda se reembolsan (dinero real)", () => {
    const p = planPurchaseReversal(
      facts({
        debt: {
          original: D(3000),
          allocations: [alloc("RECEIVABLE_PAYMENT", "1000")],
        },
      })
    )
    expect(p.effects).toMatchObject({
      extinguish: "2000.00",
      refund: "3000.00",
    })
  })
  it("un abono revertido ya no cuenta como pagado", () => {
    const p = planPurchaseReversal(
      facts({
        debt: {
          original: D(3000),
          allocations: [
            alloc("RECEIVABLE_PAYMENT", "1000"),
            alloc("RECEIVABLE_PAYMENT", "1000", "REVERSAL"),
          ],
        },
      })
    )
    expect(p.effects).toMatchObject({
      extinguish: "3000.00",
      refund: "2000.00",
    })
  })
  it("transferencia de la compra verificada tras entregar: se reembolsa una sola vez", () => {
    const p = planPurchaseReversal(
      facts({
        payments: [cash("2000"), transfer("1000", "CONFIRMED")],
        debt: {
          original: D(3000),
          allocations: [alloc("PURCHASE_PAYMENT", "1000")],
        },
      })
    )
    expect(p.effects).toMatchObject({
      extinguish: "2000.00",
      refund: "3000.00",
      identityOk: true,
    })
  })
  it("compensaciones con fichas aplicadas a la deuda se reembolsan", () => {
    const p = planPurchaseReversal(
      facts({
        debt: {
          original: D(3000),
          allocations: [alloc("CHIP_SETTLEMENT_OFFSET", "500")],
        },
      })
    )
    expect(p.effects).toMatchObject({
      extinguish: "2500.00",
      refund: "2500.00",
    })
  })
  it("compra pagada completa: sin extinción, reembolso total", () => {
    const p = planPurchaseReversal(
      facts({ payments: [cash("5000")], debt: null })
    )
    expect(p.effects).toMatchObject({ extinguish: "0.00", refund: "5000.00" })
  })
  it("compra totalmente a crédito: sin reembolso", () => {
    const p = planPurchaseReversal(
      facts({ payments: [], debt: { original: D(5000), allocations: [] } })
    )
    expect(p.effects).toMatchObject({
      extinguish: "5000.00",
      refund: "0.00",
      refundPending: false,
    })
  })
  it("sesión en cierre: bloquea", () => {
    expect(
      planPurchaseReversal(facts({ sessionStatus: "CLOSING" })).executable
    ).toBe(false)
  })
  it("participación ya liquidada: se corrige la liquidación, no la compra", () => {
    const p = planPurchaseReversal(facts({ participationSettled: true }))
    expect(p.executable).toBe(false)
    expect(p.blockers.join(" ")).toMatch(/16\\.3|liquidación/)
  })
  it("sesión CERRADA: reversible (no se reabre; el reembolso sale de custodia o banco)", () => {
    expect(
      planPurchaseReversal(facts({ sessionStatus: "CLOSED" })).executable
    ).toBe(true)
  })
})

describe("16.3 plan de corrección de liquidación", () => {
  const base = {
    status: "COMPLETED",
    activeOffsets: D(2000),
    alreadyReversedOffsets: false,
    approvedCorrection: true,
  }
  it("Escenario C: revertir compensación 2,000 → restablece deudas y crea 2,000 por pagar, sin efectivo", () => {
    const p = planSettlementCorrection({
      ...base,
      kind: "OFFSET_REVERSAL",
      amount: null,
    })
    expect(p.executable).toBe(true)
    expect(p.effects).toMatchObject({
      amount: "2000.00",
      debtsRestored: "2000.00",
      newPayable: "2000.00",
      cashIn: "0.00",
    })
  })
  it("sin compensación vigente no hay nada que revertir", () => {
    expect(
      planSettlementCorrection({
        ...base,
        activeOffsets: D(0),
        kind: "OFFSET_REVERSAL",
        amount: null,
      }).executable
    ).toBe(false)
  })
  it("una compensación ya revertida no se revierte otra vez", () => {
    expect(
      planSettlementCorrection({
        ...base,
        alreadyReversedOffsets: true,
        kind: "OFFSET_REVERSAL",
        amount: null,
      }).executable
    ).toBe(false)
  })
  it("pago adicional exige importe positivo", () => {
    expect(
      planSettlementCorrection({
        ...base,
        kind: "ADDITIONAL_PAYOUT",
        amount: null,
      }).executable
    ).toBe(false)
    expect(
      planSettlementCorrection({
        ...base,
        kind: "ADDITIONAL_PAYOUT",
        amount: D(200),
      }).effects.newPayable
    ).toBe("200.00")
  })
  it("solo liquidaciones recibidas y sin revertir", () => {
    expect(
      planSettlementCorrection({
        ...base,
        status: "DRAFT",
        kind: "ADDITIONAL_PAYOUT",
        amount: D(1),
      }).executable
    ).toBe(false)
    expect(
      planSettlementCorrection({
        ...base,
        status: "REVERSED",
        kind: "ADDITIONAL_PAYOUT",
        amount: D(1),
      }).executable
    ).toBe(false)
  })
  it("sin corrección aprobada: bloquea", () => {
    expect(
      planSettlementCorrection({
        ...base,
        approvedCorrection: false,
        kind: "ADDITIONAL_PAYOUT",
        amount: D(1),
      }).executable
    ).toBe(false)
  })
})

describe("16.4 fondos no aplicados", () => {
  it("sin obligación: pendiente de revisión", () => {
    expect(unappliedStatusFor(null)).toBe("PENDING_REVIEW")
  })
  it("Escenario D: 600 + 400 de 1,000 → parcial y después devuelto", () => {
    expect(unappliedStatusFor({ original: D(1000), payouts: [] })).toBe(
      "PENDING_REFUND"
    )
    expect(
      unappliedStatusFor({
        original: D(1000),
        payouts: [{ amount: D(600), status: "EXECUTED" }],
      })
    ).toBe("PARTIALLY_REFUNDED")
    expect(
      unappliedStatusFor({
        original: D(1000),
        payouts: [
          { amount: D(600), status: "EXECUTED" },
          { amount: D(400), status: "EXECUTED" },
        ],
      })
    ).toBe("REFUNDED")
  })
  it("una devolución en tránsito no es devolución", () => {
    expect(
      unappliedStatusFor({
        original: D(1000),
        payouts: [{ amount: D(1000), status: "PENDING" }],
      })
    ).toBe("PENDING_REFUND")
  })
})

describe("schemas estrictos (el cliente no fija saldos ni estados)", () => {
  it("canje: rechaza campos no previstos y valores no positivos", () => {
    expect(
      createRedemptionSchema.safeParse({
        presenterName: "Ana",
        presentedNominal: "100",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
    expect(
      createRedemptionSchema.safeParse({
        presenterName: "Ana",
        presentedNominal: "100",
        status: "PAID",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      createRedemptionSchema.safeParse({
        presenterName: "Ana",
        presentedNominal: "0",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
  it("validación del canje exige motivo; la recepción exige confirmación física y trazos", () => {
    expect(
      validateRedemptionSchema.safeParse({
        expectedVersion: 1,
        acceptedNominal: "10",
        notes: "corto",
      }).success
    ).toBe(false)
    expect(
      confirmRedemptionReceiptSchema.safeParse({
        expectedVersion: 1,
        physicalReceiptConfirmed: false,
        strokes: STROKES,
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
  it("pagos: una transferencia no elige efectivo; confirmar exige referencia", () => {
    expect(
      registerPayoutSchema.safeParse({
        method: "BANK_TRANSFER",
        funding: "ADMIN_CUSTODY",
        amount: "10",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      resolvePayoutSchema.safeParse({
        outcome: "EXECUTED",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      registerPayoutSchema.safeParse({
        method: "BANK_TRANSFER",
        amount: "10",
        bankReference: "4152313456789012",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
  it("reverso: el reembolso y la extinción nunca los envía el cliente", () => {
    expect(
      executePurchaseReversalSchema.safeParse({
        correctionId: "c1",
        expectedVersion: 1,
        physicalReturnConfirmed: true,
        returnedNominal: "5000",
        reason: "Compra capturada al jugador equivocado",
        refundAmount: "0",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
  it("corrección: la compensación la calcula el servidor", () => {
    expect(
      executeSettlementCorrectionSchema.safeParse({
        kind: "OFFSET_REVERSAL",
        amount: "2000",
        correctionId: "c1",
        expectedVersion: 1,
        reason: "La compensación fue un error del cajero",
        strokes: STROKES,
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
})

describe("integración con Módulos 14 y 15", () => {
  it("los procesos del Módulo 16 se ejecutan en Operaciones especiales (aprobar ≠ ejecutar)", () => {
    for (const t of [
      "PURCHASE_REVERSAL",
      "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      "UNAPPLIED_FUNDS_RETURN",
      "LATE_CHIP_REDEMPTION",
    ] as const) {
      expect(CORRECTION_TYPE_META[t].execution?.service).toMatch(
        /Operaciones especiales/
      )
      expect(displayStatus("APPROVED", t)).toMatch(/pendiente de ejecución/)
    }
  })
  it("los eventos del Módulo 16 se clasifican en su propio módulo de auditoría", () => {
    for (const a of [
      "LATE_REDEMPTION_RECEIVED",
      "PURCHASE_REVERSAL_EXECUTED",
      "SETTLEMENT_CORRECTION_EXECUTED",
      "UNAPPLIED_FUNDS_REFUNDED",
      "SPECIAL_PAYOUT_EXECUTED",
      "SPECIAL_OPERATION_FAILED",
    ])
      expect(moduleOfAction(a)).toBe("SPECIAL_OPERATIONS")
    expect(moduleOfAction("PURCHASE_CONFIRMED")).toBe("PURCHASES")
  })
  it("la extinción por reverso no es un abono en los reportes", () => {
    expect(
      classifyAllocation({
        kind: "APPLICATION",
        source: "PURCHASE_REVERSAL",
      } as Parameters<typeof classifyAllocation>[0])
    ).toBe("EXTINCTION")
  })
  it("CASHIER opera pero no autoriza", () => {
    expect(roleHasPermission("CASHIER", PERMISSIONS.SPECIAL_OPS_OPERATE)).toBe(
      true
    )
    expect(
      roleHasPermission("CASHIER", PERMISSIONS.SPECIAL_OPS_AUTHORIZE)
    ).toBe(false)
  })
})
