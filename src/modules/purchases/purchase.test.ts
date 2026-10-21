import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { OPERATIONAL_RULES } from "@/config/operational-rules"
import { Prisma } from "@/generated/prisma/client"
import {
  assertPaymentFits,
  deliveryBlockers,
  nextPurchaseNumber,
  paymentEffect,
  purchaseTypeLabel,
  requiresSignature,
  summarizePayments,
  type PaymentLike,
} from "@/modules/purchases/purchase.math"
import {
  cancelPaymentSchema,
  cardResultSchema,
  confirmDeliverySchema,
  createPurchaseSchema,
  creditAuthorizationSchema,
  purchasesQuerySchema,
  recordPaymentSchema,
} from "@/modules/purchases/purchase.schemas"
import {
  summaryHash,
  unavailableSignatureVerifier,
  type SignableSummary,
} from "@/modules/purchases/signature-gateway"

const D = (v: string) => new Prisma.Decimal(v)
const KEY = "clave-12345678"
let n = 0
const pay = (
  method: PaymentLike["method"],
  amount: string,
  status: PaymentLike["status"],
  transferStatus: PaymentLike["transferStatus"] = null,
  transferConfirmedAmount: string | null = null
): PaymentLike => ({
  id: `p${++n}`,
  method,
  amount: D(amount),
  status,
  transferStatus,
  transferConfirmedAmount: transferConfirmedAmount
    ? D(transferConfirmedAmount)
    : null,
})
const sum = (amount: string, payments: PaymentLike[]) =>
  summarizePayments(D(amount), payments)
const s = (v: Prisma.Decimal) => v.toFixed(2)

describe("compra por importe (sin denominaciones)", () => {
  it("se captura solo el importe solicitado", () => {
    expect(
      createPurchaseSchema.safeParse({
        participationId: "part1",
        nominalAmount: "5000",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })

  it("rechaza denominaciones, combinaciones, cantidades de fichas y datos del servidor", () => {
    for (const extra of [
      { denominations: [{ value: "100", quantity: 50 }] },
      { chips: { "100": 50 } },
      { quantity: 50 },
      { folio: "CMP-1" },
      { status: "CONFIRMED" },
      { purchaseType: "REBUY" },
      { rebuyNumber: 1 },
      { createdById: "u1" },
      { sessionId: "s1" },
      { playerId: "p1" },
    ]) {
      expect(
        createPurchaseSchema.safeParse({
          participationId: "part1",
          nominalAmount: "5000",
          idempotencyKey: KEY,
          ...extra,
        }).success
      ).toBe(false)
    }
  })

  it("el importe es positivo, con máximo dos decimales y como texto (nunca Float)", () => {
    for (const bad of ["0", "-5", "1.234", "abc", "", "1e3"]) {
      expect(
        createPurchaseSchema.safeParse({
          participationId: "part1",
          nominalAmount: bad,
          idempotencyKey: KEY,
        }).success
      ).toBe(false)
    }
    expect(
      createPurchaseSchema.safeParse({
        participationId: "part1",
        nominalAmount: 5000,
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })
})

describe("numeración: compra inicial y recompras por (sesión, jugador)", () => {
  it("la primera compra confirmada es la inicial; luego Recompra 1, 2…", () => {
    expect(nextPurchaseNumber(null)).toEqual({
      sequenceNumber: 1,
      purchaseType: "INITIAL_PURCHASE",
      rebuyNumber: null,
    })
    expect(nextPurchaseNumber(1)).toEqual({
      sequenceNumber: 2,
      purchaseType: "REBUY",
      rebuyNumber: 1,
    })
    expect(nextPurchaseNumber(2)).toMatchObject({ rebuyNumber: 2 })
    expect(purchaseTypeLabel("REBUY", 3)).toBe("Recompra 3")
    expect(purchaseTypeLabel("INITIAL_PURCHASE", null)).toBe("Compra inicial")
  })

  it("la recompra después de cambiar de mesa continúa (la numeración no depende de la mesa)", () => {
    // Compra inicial y recompra 1 en 10/10 → en 25/25 sigue la recompra 2.
    expect(nextPurchaseNumber(2)).toMatchObject({
      purchaseType: "REBUY",
      rebuyNumber: 2,
    })
  })
})

describe("pagos y saldo por cobrar", () => {
  it("pago total en efectivo: sin saldo, sin firma", () => {
    const f = sum("5000", [pay("CASH", "5000", "CONFIRMED")])
    expect(s(f.confirmedCash)).toBe("5000.00")
    expect(s(f.outstanding)).toBe("0.00")
    expect(requiresSignature(f)).toBe(false)
  })

  it("pago total por transferencia VERIFICADA (usa el importe confirmado por el banco)", () => {
    const f = sum("3000", [
      pay("BANK_TRANSFER", "3000", "PENDING", "CONFIRMED", "3000"),
    ])
    expect(s(f.verifiedBankTransfers)).toBe("3000.00")
    expect(s(f.outstanding)).toBe("0.00")
  })

  it("pago total con débito o con crédito de terminal APROBADOS", () => {
    expect(
      s(sum("2000", [pay("CARD_DEBIT", "2000", "APPROVED")]).approvedCardDebit)
    ).toBe("2000.00")
    const f = sum("2000", [pay("CARD_CREDIT", "2000", "APPROVED")])
    expect(s(f.approvedCardCredit)).toBe("2000.00")
    expect(s(f.outstanding)).toBe("0.00")
    // Un cobro de terminal NO es efectivo.
    expect(s(f.confirmedCash)).toBe("0.00")
  })

  it("pago mixto del ejemplo: $5,000 = $1,000 efectivo + $2,000 débito + $1,000 transferencia pendiente + $1,000 crédito", () => {
    const f = sum("5000", [
      pay("CASH", "1000", "CONFIRMED"),
      pay("CARD_DEBIT", "2000", "APPROVED"),
      pay("BANK_TRANSFER", "1000", "PENDING", "PENDING_VERIFICATION"),
    ])
    expect(s(f.confirmedPayments)).toBe("3000.00")
    expect(s(f.pendingTransfers)).toBe("1000.00")
    expect(s(f.outstanding)).toBe("2000.00") // incluye la transferencia pendiente
    expect(s(f.uncoveredCredit)).toBe("1000.00") // crédito sin componente
    expect(s(f.committedPayments)).toBe("4000.00")
  })

  it("una transferencia pendiente NO cuenta como cobro ni duplica la deuda", () => {
    const f = sum("2000", [
      pay("BANK_TRANSFER", "2000", "PENDING", "PENDING_VERIFICATION"),
    ])
    expect(s(f.confirmedPayments)).toBe("0.00")
    expect(s(f.outstanding)).toBe("2000.00") // una sola obligación, no 4000
    expect(requiresSignature(f)).toBe(true)
  })

  it("crédito total y parcial", () => {
    expect(s(sum("10000", []).outstanding)).toBe("10000.00")
    expect(
      s(sum("10000", [pay("CASH", "2500", "CONFIRMED")]).outstanding)
    ).toBe("7500.00")
  })

  it("rechazados, anulados, retirados y transferencias rechazadas no cuentan", () => {
    const f = sum("1000", [
      pay("CARD_DEBIT", "1000", "DECLINED"),
      pay("CARD_CREDIT", "1000", "VOIDED"),
      pay("CASH", "1000", "CANCELLED"),
      pay("BANK_TRANSFER", "1000", "PENDING", "REJECTED"),
    ])
    expect(s(f.confirmedPayments)).toBe("0.00")
    expect(s(f.committedPayments)).toBe("0.00")
    expect(paymentEffect(pay("CARD_DEBIT", "1", "DECLINED"))).toBe("VOID")
    expect(paymentEffect(pay("CARD_DEBIT", "1", "PENDING"))).toBe("PENDING")
  })

  it("aplicación posterior de una transferencia verificada reduce el saldo por cobrar", () => {
    const before = sum("3000", [
      pay("BANK_TRANSFER", "3000", "PENDING", "PENDING_VERIFICATION"),
    ])
    const after = sum("3000", [
      pay("BANK_TRANSFER", "3000", "PENDING", "CONFIRMED", "3000"),
    ])
    expect(s(before.outstanding)).toBe("3000.00")
    expect(s(after.outstanding)).toBe("0.00")
  })

  it("no acepta pagos superiores al importe (sin cambio ni excedentes)", () => {
    const f = sum("1000", [pay("CASH", "600", "CONFIRMED")])
    expect(() => assertPaymentFits(f, D("400"))).not.toThrow()
    expect(() => assertPaymentFits(f, D("400.01"))).toThrow(/excede/)
    expect(() => assertPaymentFits(f, D("0"))).toThrow()
  })

  it("detecta la sobreaplicación (nunca saldo negativo)", () => {
    const f = sum("1000", [
      pay("CASH", "1000", "CONFIRMED"),
      pay("BANK_TRANSFER", "500", "PENDING", "CONFIRMED", "500"),
    ])
    expect(f.overApplied).toBe(true)
    expect(s(f.outstanding)).toBe("0.00")
  })

  it("decimales exactos (Decimal, no Float)", () => {
    const f = sum("0.30", [
      pay("CASH", "0.10", "CONFIRMED"),
      pay("CARD_DEBIT", "0.20", "APPROVED"),
    ])
    expect(s(f.outstanding)).toBe("0.00")
  })
})

describe("bloqueos de entrega: socio autorizador y firma solo con crédito", () => {
  const base = {
    editable: true,
    participationActive: true,
    creditAuthorizationValid: false,
    signatureValid: false,
  }
  it("una compra totalmente pagada NO exige socio ni firma", () => {
    expect(
      deliveryBlockers({
        ...base,
        financials: sum("1000", [pay("CASH", "1000", "CONFIRMED")]),
      })
    ).toEqual([])
  })

  it("con cualquier crédito (aunque sea parcial) exige socio autorizador y firma", () => {
    const f = sum("1000", [pay("CASH", "999.99", "CONFIRMED")])
    expect(deliveryBlockers({ ...base, financials: f })).toEqual([
      "CREDIT_AUTHORIZATION_REQUIRED",
      "CREDIT_SIGNATURE_REQUIRED",
    ])
    expect(
      deliveryBlockers({
        ...base,
        financials: f,
        creditAuthorizationValid: true,
      })
    ).toEqual(["CREDIT_SIGNATURE_REQUIRED"])
    expect(
      deliveryBlockers({
        ...base,
        financials: f,
        creditAuthorizationValid: true,
        signatureValid: true,
      })
    ).toEqual([])
  })

  it("un cobro de terminal en proceso o una participación inactiva bloquean", () => {
    const f = sum("1000", [pay("CARD_DEBIT", "1000", "PENDING")])
    expect(deliveryBlockers({ ...base, financials: f })).toContain(
      "PENDING_CARD_PAYMENT"
    )
    expect(
      deliveryBlockers({
        ...base,
        participationActive: false,
        financials: sum("1", [pay("CASH", "1", "CONFIRMED")]),
      })
    ).toEqual(["PARTICIPATION_NOT_ACTIVE"])
  })
})

describe("métodos de pago", () => {
  it("efectivo exige declarar que se recibió", () => {
    expect(
      recordPaymentSchema.safeParse({
        method: "CASH",
        amount: "100",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      recordPaymentSchema.safeParse({
        method: "CASH",
        amount: "100",
        cashReceived: true,
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })

  it("el crédito NO es un método de pago", () => {
    expect(
      recordPaymentSchema.safeParse({
        method: "CREDIT",
        amount: "100",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
  })

  it("terminal aprobada exige folio y confirmación operativa explícita", () => {
    const card = {
      method: "CARD_DEBIT",
      amount: "100",
      result: "APPROVED",
      idempotencyKey: KEY,
    }
    expect(recordPaymentSchema.safeParse(card).success).toBe(false)
    expect(
      recordPaymentSchema.safeParse({ ...card, terminalReference: "AUT-1" })
        .success
    ).toBe(false)
    expect(
      recordPaymentSchema.safeParse({
        ...card,
        terminalReference: "AUT-1",
        approvalConfirmed: true,
      }).success
    ).toBe(true)
    // Rechazada: se registra sin aprobación.
    expect(
      recordPaymentSchema.safeParse({ ...card, result: "DECLINED" }).success
    ).toBe(true)
  })

  it("nunca acepta datos sensibles de tarjeta", () => {
    const card = {
      method: "CARD_CREDIT",
      amount: "100",
      result: "APPROVED",
      approvalConfirmed: true,
      idempotencyKey: KEY,
    }
    expect(
      recordPaymentSchema.safeParse({
        ...card,
        terminalReference: "4111-1111-1111-1111",
      }).success
    ).toBe(false)
    for (const extra of [
      { cvv: "123" },
      { pin: "1234" },
      { cardNumber: "4111" },
    ])
      expect(
        recordPaymentSchema.safeParse({
          ...card,
          terminalReference: "AUT-9",
          ...extra,
        }).success
      ).toBe(false)
  })

  it("resultado de terminal: anular exige motivo; aprobar exige folio y confirmación", () => {
    expect(cardResultSchema.safeParse({ result: "VOIDED" }).success).toBe(false)
    expect(
      cardResultSchema.safeParse({ result: "VOIDED", reason: "Anulado" })
        .success
    ).toBe(true)
    expect(cardResultSchema.safeParse({ result: "APPROVED" }).success).toBe(
      false
    )
    expect(cardResultSchema.safeParse({ result: "DECLINED" }).success).toBe(
      true
    )
  })

  it("retirar un pago exige motivo", () => {
    expect(cancelPaymentSchema.safeParse({ reason: "no" }).success).toBe(false)
    expect(
      cancelPaymentSchema.safeParse({
        reason: "Devuelto al jugador",
        cashReturned: true,
      }).success
    ).toBe(true)
  })
})

describe("socio autorizador", () => {
  it("medio de autorización obligatorio: VERBAL o MESSAGE", () => {
    expect(
      creditAuthorizationSchema.safeParse({
        partnerId: "u1",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      creditAuthorizationSchema.safeParse({
        partnerId: "u1",
        channel: "WHATSAPP",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(
      creditAuthorizationSchema.safeParse({
        partnerId: "u1",
        channel: "MESSAGE",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })

  it("no se aceptan nombres libres ni importes calculados por el cliente", () => {
    for (const extra of [
      { partnerName: "Alguien" },
      { authorizedCreditAmount: "100" },
      { recordedById: "u2" },
      { recordedAt: "2026-01-01" },
    ])
      expect(
        creditAuthorizationSchema.safeParse({
          partnerId: "u1",
          channel: "VERBAL",
          idempotencyKey: KEY,
          ...extra,
        }).success
      ).toBe(false)
  })
})

describe("firma condicional (Módulo 09)", () => {
  const summary: SignableSummary = {
    purchaseId: "c1",
    folio: "CMP-000001",
    playerId: "p1",
    playerName: "Jugador",
    sessionId: "s1",
    tableName: "Mesa 25/25",
    nominalAmount: "5000.00",
    confirmedPayments: [{ paymentId: "a", method: "CASH", amount: "1000.00" }],
    pendingTransfers: [],
    outstandingCredit: "4000.00",
    partner: { id: "u1", name: "Socio", channel: "VERBAL" },
    operationDate: "2026-10-18T03:00:00.000Z",
    version: 3,
  }

  it("un cambio material (importe, pago, socio o versión) cambia la huella: la firma anterior deja de valer", () => {
    const h = summaryHash(summary)
    expect(summaryHash({ ...summary })).toBe(h)
    expect(summaryHash({ ...summary, nominalAmount: "5000.01" })).not.toBe(h)
    expect(summaryHash({ ...summary, version: 4 })).not.toBe(h)
    expect(
      summaryHash({
        ...summary,
        partner: { id: "u2", name: "Otro", channel: "VERBAL" },
      })
    ).not.toBe(h)
    expect(summaryHash({ ...summary, outstandingCredit: "3000.00" })).not.toBe(
      h
    )
  })

  it("sin el servicio real de firmas no existe ninguna firma válida (no se simula)", async () => {
    expect(unavailableSignatureVerifier.available).toBe(false)
    await expect(
      unavailableSignatureVerifier.findValidSignature({} as never, {
        purchaseId: "c1",
        playerId: "p1",
        summaryVersion: 1,
        summaryHash: "x",
      })
    ).resolves.toBeNull()
  })

  it("confirmar la entrega exige la versión revisada y la confirmación física explícita (no hay booleano de firma)", () => {
    expect(
      confirmDeliverySchema.safeParse({
        expectedVersion: 2,
        physicalDeliveryConfirmed: true,
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
    for (const body of [
      { expectedVersion: 2, idempotencyKey: KEY },
      {
        expectedVersion: 2,
        physicalDeliveryConfirmed: true,
        hasSignature: true,
        idempotencyKey: KEY,
      },
      {
        expectedVersion: 2,
        physicalDeliveryConfirmed: true,
        confirmedAt: "2026-01-01",
        idempotencyKey: KEY,
      },
    ])
      expect(confirmDeliverySchema.safeParse(body).success).toBe(false)
  })
})

describe("permisos y reglas", () => {
  it("los tres roles consultan y registran compras", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.PURCHASES_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.PURCHASES_CREATE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CASH_OPERATE)).toBe(true)
    }
  })

  it("las reglas fijas reflejan crédito con socio, firma solo con crédito y WhatsApp solo con crédito", () => {
    const ids = OPERATIONAL_RULES.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "CREDIT_PARTNER_AUTHORIZATION",
        "SIGNATURE_ON_CREDIT_DELIVERY",
        "CREDIT_WHATSAPP_NOTIFICATION",
        "PURCHASES_BY_NOMINAL_AMOUNT",
        "CARD_TERMINAL_PAYMENTS",
      ])
    )
  })

  it("el historial se filtra por crédito, método y fechas", () => {
    expect(
      purchasesQuerySchema.parse({ withCredit: "true", method: "CARD_DEBIT" })
    ).toMatchObject({ withCredit: true, method: "CARD_DEBIT", page: 1 })
    expect(purchasesQuerySchema.safeParse({ method: "CREDIT" }).success).toBe(
      false
    )
  })
})
