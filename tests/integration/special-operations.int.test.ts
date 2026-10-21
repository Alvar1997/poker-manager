import { randomUUID } from "node:crypto"

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as validateRoute from "@/app/api/special-operations/redemptions/[id]/validate/route"
import * as redemptionsRoute from "@/app/api/special-operations/redemptions/route"
import * as receiptImageRoute from "@/app/api/special-operations/receipts/[id]/image/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  createCorrection,
  decideCorrection,
  getCorrection,
} from "@/modules/corrections/correction.service"
import { contributeToCustody } from "@/modules/credits/custody.service"
import {
  getPayment,
  registerPayment,
  reversePayment,
} from "@/modules/credits/receivable-payment.service"
import { receivablesOf } from "@/modules/credits/receivable.service"
import { runIntegrityCheck } from "@/modules/integrity/integrity.service"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  confirmDelivery,
  createPurchase,
  getPurchase,
  recordCreditAuthorization,
  recordPayment,
} from "@/modules/purchases/purchase.service"
import { addPlayerToTable } from "@/modules/session-tables/participation.service"
import { openSessionTable } from "@/modules/session-tables/session-table.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  createSession,
  prepareSession,
  transitionInTx,
} from "@/modules/sessions/session.service"
import {
  captureSettlementSignature,
  prepareSettlementSignatureSummary,
} from "@/modules/settlements/settlement-signature.service"
import { registerPayout } from "@/modules/settlements/settlement-payout.service"
import {
  confirmReturn,
  createSettlement,
  getSettlement,
} from "@/modules/settlements/settlement.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"
import {
  executePurchaseReversal,
  previewPurchaseReversal,
} from "@/modules/special-operations/purchase-reversal.service"
import {
  cancelRedemption,
  confirmRedemptionReceipt,
  createRedemption,
  getRedemption,
  validateRedemptionValue,
} from "@/modules/special-operations/redemption.service"
import { executeSettlementCorrection } from "@/modules/special-operations/settlement-correction.service"
import {
  registerSpecialPayout,
  resolveSpecialPayout,
} from "@/modules/special-operations/special-payout.service"
import {
  getUnappliedFunds,
  registerUnappliedRefund,
} from "@/modules/special-operations/unapplied-funds.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
} from "./helpers"

/**
 * Módulo 16 contra PostgreSQL REAL (base de PRUEBAS): canje posterior,
 * reverso de compra, corrección de liquidación y devolución de fondos no
 * aplicados. Cada escenario verifica que solo se registran fichas y dinero
 * REALMENTE recibidos o pagados y que lo cerrado no cambia.
 */

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
async function actorFor(role: Role) {
  const u = await createUser({ role })
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
    _user: u,
  }
}
type Actor = Awaited<ReturnType<typeof actorFor>>
const key = () => randomUUID()
const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

let cashier: Actor
let partner: Actor
let admin: Actor
let sessionId: string
let t25: string

async function openRealSession() {
  const s = await createSession(cashier, { idempotencyKey: key() })
  await prepareSession(cashier, s.id)
  const { count } = await createOpeningChipCount(cashier, s.id)
  await updateStockCount(cashier, count.id, {
    lines: count.details.map((x) => ({
      denominationId: x.denominationId,
      countedQuantity: x.expectedQuantity,
    })),
  })
  await confirmStockCount(cashier, count.id, key())
  await confirmOpeningCashCount(cashier, s.id, {
    countedAmount: "0",
    physicallyVerified: true,
  })
  await openSession(cashier, s.id, { idempotencyKey: key() })
  return s.id
}

/** Cierre de PRUEBA (OPEN → CLOSING → CLOSED) para verificar inmutabilidad. */
async function closeSessionForTest(id: string) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.pokerSession.findUniqueOrThrow({
      where: { id },
      select: { id: true, folio: true, status: true },
    })
    await transitionInTx(tx, s, "CLOSING", cashier)
    await transitionInTx(tx, { ...s, status: "CLOSING" }, "CLOSED", cashier, {
      closedAt: new Date(),
    })
  })
}

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  const d = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "500" },
  })
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  admin = await actorFor("SUPERADMIN")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId: d.id, quantity: 200 }],
    idempotencyKey: key(),
  })
  sessionId = await openRealSession()
  t25 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
  ).id
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
})

async function seat(name?: string) {
  const playerId = (await createTestPlayer(name ? { name } : {})).id
  const r = await addPlayerToTable(cashier, sessionId, t25, {
    playerId,
    idempotencyKey: key(),
  })
  return { playerId, participationId: r.participationId }
}

/** Compra REAL: `cash` en efectivo y el resto a crédito (socio + firma). */
async function buy(participationId: string, amount: string, cash = "0") {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  if (D(cash).greaterThan(0))
    await recordPayment(cashier, purchaseId, {
      method: "CASH",
      amount: cash,
      cashReceived: true,
      idempotencyKey: key(),
    })
  if (D(cash).lessThan(amount)) {
    await recordCreditAuthorization(cashier, purchaseId, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    const prepared = await prepareSignatureSummary(cashier, purchaseId)
    await captureSignature(cashier, purchaseId, {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: key(),
    })
  }
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

async function approvedCorrection(
  type:
    | "PURCHASE_REVERSAL"
    | "SETTLEMENT_REVERSAL_WITH_PAYOUTS"
    | "UNAPPLIED_FUNDS_RETURN",
  targetType: "ChipPurchase" | "PlayerSettlement" | "UnappliedPlayerFunds",
  targetId: string
) {
  const req = await createCorrection(cashier, {
    type,
    targetType,
    targetId,
    reason: "Corrección documentada para la prueba del Módulo 16",
    idempotencyKey: key(),
  })
  await decideCorrection(partner, req.id, "APPROVED", {
    expectedVersion: 1,
    notes: "Autorizado por el socio",
  })
  return req.id
}

async function nominal() {
  const s = await prisma.chipSetInventoryState.findFirstOrThrow()
  return {
    custody: D(s.custodyNominal).toFixed(2),
    circulation: D(s.circulationNominal).toFixed(2),
  }
}
const cash = async (sid = sessionId) =>
  (await cashBalanceOf(prisma, sid)).balance.toFixed(2)
async function globalBalance(kind: string, scopeKey = "GLOBAL") {
  const row = await prisma.financialAccountBalance.findFirst({
    where: { scopeKey, account: { kind: kind as "BANK" } },
  })
  return row ? D(row.balance).toFixed(2) : "0.00"
}
const balances = async (playerId: string) =>
  (await receivablesOf(prisma, playerId)).map((r) => r.balance.toFixed(2))
const counts = async () => ({
  tx: await prisma.cashTransaction.count(),
  chips: await prisma.chipNominalMovement.count(),
  alloc: await prisma.paymentAllocation.count(),
  payables: await prisma.specialPayable.count(),
})

async function expectCleanIntegrity(ignore: string[] = []) {
  const run = await runIntegrityCheck(admin, { trigger: "MANUAL" })
  const errors = await prisma.integrityFinding.findMany({
    where: { runId: run.runId, status: "ERROR", checkCode: { notIn: ignore } },
    select: { checkCode: true, explanation: true },
  })
  expect(errors).toEqual([])
  expect(run.summary.notEvaluated).toBe(0)
}

async function fundCustody(amount: string, actor: Actor = cashier) {
  await contributeToCustody(actor, {
    amount,
    counterpartyName: "Socio de prueba",
    reason: "Fondear pagos de operaciones especiales",
    cashReceived: true,
    idempotencyKey: key(),
  })
}

// ─────────────────────────────────────────────────────────────────────

describe("16.1 canje posterior de fichas", () => {
  it("Escenario A: circulación 3,000 de una sesión cerrada → canje 1,000, pago parcial 600, pendiente 400; caja y comprobante cerrados intactos", async () => {
    const { playerId, participationId } = await seat("Jugador canje")
    await buy(participationId, "3000", "3000")
    expect((await nominal()).circulation).toBe("3000.00")
    const closedCash = await cash()
    await closeSessionForTest(sessionId)
    const closedSession = await prisma.pokerSession.findUniqueOrThrow({
      where: { id: sessionId },
    })

    const { id } = await createRedemption(cashier, {
      presenterName: "Jugador canje",
      playerId,
      originSessionId: sessionId,
      originEvidence:
        "Compra registrada en la sesión (folio en el comprobante)",
      presentedNominal: "1000",
      idempotencyKey: key(),
    })
    // CASHIER solicita, no valida (servicio y endpoint).
    await expect(
      validateRedemptionValue(cashier, id, {
        expectedVersion: 1,
        acceptedNominal: "1000",
        notes: "Yo mismo lo valido como cajero",
      })
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    signInAs(cashier._user)
    const denied = await call(validateRoute.POST, {
      method: "POST",
      path: `/api/special-operations/redemptions/${id}/validate`,
      params: { id },
      body: {
        expectedVersion: 1,
        acceptedNominal: "1000",
        notes: "Intento del cajero",
      },
    })
    expect(denied.status).toBe(403)
    // Sin recepción física no hay canje.
    await expect(
      confirmRedemptionReceipt(cashier, id, {
        expectedVersion: 1,
        physicalReceiptConfirmed: true,
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/validado por un socio/)
    expect((await nominal()).circulation).toBe("3000.00")

    await validateRedemptionValue(partner, id, {
      expectedVersion: 1,
      acceptedNominal: "1000",
      notes: "Fichas auténticas revisadas por el socio",
    })
    const rk = key()
    await confirmRedemptionReceipt(cashier, id, {
      expectedVersion: 2,
      physicalReceiptConfirmed: true,
      strokes: STROKES,
      idempotencyKey: rk,
    })
    // Reintento: no duplica la entrada.
    await confirmRedemptionReceipt(cashier, id, {
      expectedVersion: 2,
      physicalReceiptConfirmed: true,
      strokes: STROKES,
      idempotencyKey: rk,
    })
    expect(await nominal()).toEqual({
      custody: "98000.00",
      circulation: "2000.00",
    })
    expect(
      await prisma.chipNominalMovement.count({
        where: { referenceType: "LateChipRedemption", referenceId: id },
      })
    ).toBe(1)
    let r = await getRedemption(id)
    expect(r.status).toBe("PAYMENT_PENDING")
    expect(r.payable).toMatchObject({
      original: "1000.00",
      paid: "0.00",
      pending: "1000.00",
    })
    await expect(
      cancelRedemption(cashier, id, {
        expectedVersion: r.version,
        reason: "Ya no lo quiere cobrar",
      })
    ).rejects.toThrow(/no se cancela/)

    // Pago parcial REAL desde custodia (nunca desde la caja cerrada).
    await expect(
      registerSpecialPayout(cashier, r.payable!.id, {
        method: "CASH",
        funding: "SESSION_CASH",
        amount: "600",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ABIERTA/)
    await expect(
      registerSpecialPayout(cashier, r.payable!.id, {
        method: "CASH",
        amount: "600",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/insuficiente|faltan|Faltan/i)
    await fundCustody("600")
    const pk = key()
    await registerSpecialPayout(cashier, r.payable!.id, {
      method: "CASH",
      amount: "600",
      idempotencyKey: pk,
    })
    await registerSpecialPayout(cashier, r.payable!.id, {
      method: "CASH",
      amount: "600",
      idempotencyKey: pk,
    })
    r = await getRedemption(id)
    expect(r.status).toBe("PARTIALLY_PAID")
    expect(r.payable).toMatchObject({ paid: "600.00", pending: "400.00" })
    // Nunca más que lo pendiente.
    await fundCustody("1000")
    await expect(
      registerSpecialPayout(cashier, r.payable!.id, {
        method: "CASH",
        amount: "500",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/excede/)
    // La sesión cerrada, su caja y su estado no cambiaron.
    expect(await cash()).toBe(closedCash)
    const after = await prisma.pokerSession.findUniqueOrThrow({
      where: { id: sessionId },
    })
    expect(after.status).toBe("CLOSED")
    expect(after.updatedAt.getTime()).toBe(closedSession.updatedAt.getTime())
    expect((await auditRows("LATE_REDEMPTION_RECEIVED")).length).toBe(1)
    expect((await auditRows("LATE_REDEMPTION_PARTIALLY_PAID")).length).toBe(1)
    // Comprobantes PNG (recepción + anexo de pago).
    expect(r.receipts.map((x) => x.kind)).toEqual([
      "REDEMPTION_RECEIPT",
      "SPECIAL_PAYOUT",
    ])
    signInAs(cashier._user)
    const png = await receiptImageRoute.GET(
      new NextRequest(
        `http://localhost:3000/api/special-operations/receipts/${r.receipts[0].id}/image`,
        { headers: { host: "localhost:3000" } }
      ),
      { params: Promise.resolve({ id: r.receipts[0].id }) }
    )
    expect(png.status).toBe(200)
    expect(png.headers.get("content-type")).toBe("image/png")
    // Liquidar el resto por transferencia: pendiente no paga; ejecutada sí.
    const { payoutId } = await registerSpecialPayout(cashier, r.payable!.id, {
      method: "BANK_TRANSFER",
      amount: "400",
      idempotencyKey: key(),
    })
    expect((await getRedemption(id)).status).toBe("PARTIALLY_PAID")
    await expect(
      registerSpecialPayout(cashier, r.payable!.id, {
        method: "CASH",
        amount: "1",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/comprometido|excede/)
    // Transferencia fallida: libera lo comprometido (no es pago).
    await resolveSpecialPayout(cashier, payoutId, {
      outcome: "FAILED",
      reason: "Banco rechazó la cuenta destino",
      idempotencyKey: key(),
    })
    expect((await getRedemption(id)).payable).toMatchObject({
      inTransit: "0.00",
      pending: "400.00",
    })
    const second = await registerSpecialPayout(cashier, r.payable!.id, {
      method: "BANK_TRANSFER",
      amount: "400",
      idempotencyKey: key(),
    })
    await resolveSpecialPayout(cashier, second.payoutId, {
      outcome: "EXECUTED",
      bankReference: "SPEI-CAN-2",
      idempotencyKey: key(),
    })
    expect((await getRedemption(id)).status).toBe("PAID")
    expect((await auditRows("LATE_REDEMPTION_PAID")).length).toBe(1)
    // El cierre de PRUEBA omite el retiro final del Módulo 12 (la caja
    // cerrada conserva su efectivo): ese hallazgo es del atajo, no del canje.
    await expectCleanIntegrity(["CASH_CLOSED_FINAL_ZERO"])
  })

  it("no acepta más valor que la circulación global; aceptar $0 es un rechazo; el endpoint es estricto", async () => {
    const { participationId } = await seat()
    await buy(participationId, "500", "500")
    const { id } = await createRedemption(cashier, {
      presenterName: "Persona sin registro",
      presentedNominal: "2000",
      idempotencyKey: key(),
    })
    await expect(
      validateRedemptionValue(partner, id, {
        expectedVersion: 1,
        acceptedNominal: "2000",
        notes: "Validación del socio",
      })
    ).rejects.toThrow(/circulación/)
    await validateRedemptionValue(partner, id, {
      expectedVersion: 1,
      acceptedNominal: "0",
      notes: "Fichas no auténticas",
    })
    expect((await getRedemption(id)).status).toBe("REJECTED")
    signInAs(cashier._user)
    const bad = await call(redemptionsRoute.POST, {
      method: "POST",
      path: "/api/special-operations/redemptions",
      body: {
        presenterName: "X Y",
        presentedNominal: "100",
        status: "PAID",
        idempotencyKey: key(),
      },
    })
    expect(bad.status).toBe(400)
  })
})

describe("16.2 reverso completo de compra", () => {
  it("Escenario B: compra 5,000 (2,000 efectivo + 3,000 crédito); sin devolución física se bloquea; con devolución se extingue la deuda y se debe reembolsar 2,000", async () => {
    const { playerId, participationId } = await seat("Jugador reverso")
    const purchaseId = await buy(participationId, "5000", "2000")
    expect(await balances(playerId)).toEqual(["3000.00"])
    expect(await cash()).toBe("2000.00")
    const p0 = await getPurchase(purchaseId)
    // Sin solicitud aprobada: no ejecutable.
    const preview = await previewPurchaseReversal(purchaseId)
    expect(preview.plan.executable).toBe(false)
    const correctionId = await approvedCorrection(
      "PURCHASE_REVERSAL",
      "ChipPurchase",
      purchaseId
    )
    expect((await auditRows("PURCHASE_REVERSAL_REQUESTED")).length).toBe(1)
    expect((await auditRows("PURCHASE_REVERSAL_APPROVED")).length).toBe(1)
    // Aprobar no ejecuta nada.
    const before = await counts()
    expect((await getPurchase(purchaseId)).status).toBe("CONFIRMED")

    // Sin restitución física: BLOQUEADO, sin movimientos.
    await expect(
      executePurchaseReversal(cashier, purchaseId, {
        correctionId,
        expectedVersion: p0.version,
        physicalReturnConfirmed: false,
        returnedNominal: "0",
        reason: "Compra capturada al jugador equivocado",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/regresar físicamente/)
    await expect(
      executePurchaseReversal(cashier, purchaseId, {
        correctionId,
        expectedVersion: p0.version,
        physicalReturnConfirmed: true,
        returnedNominal: "3000",
        reason: "Compra capturada al jugador equivocado",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/valor completo/)
    expect(await counts()).toEqual(before)
    expect((await auditRows("PURCHASE_REVERSAL_BLOCKED")).length).toBe(2)
    expect((await getCorrection(correctionId)).status).toBe("APPROVED")

    // Devolución física legítima.
    const k = key()
    const ok = await executePurchaseReversal(cashier, purchaseId, {
      correctionId,
      expectedVersion: p0.version,
      physicalReturnConfirmed: true,
      returnedNominal: "5000",
      reason: "Compra capturada al jugador equivocado",
      idempotencyKey: k,
    })
    const replay = await executePurchaseReversal(cashier, purchaseId, {
      correctionId,
      expectedVersion: p0.version,
      physicalReturnConfirmed: true,
      returnedNominal: "5000",
      reason: "Compra capturada al jugador equivocado",
      idempotencyKey: k,
    })
    expect(replay).toEqual({ reversalId: ok.reversalId, replayed: true })
    expect((await getPurchase(purchaseId)).status).toBe("REVERSED")
    // El comprobante original queda ANULADO (contenido y firma intactos).
    const receipt = await prisma.purchaseReceipt.findUniqueOrThrow({
      where: { purchaseId },
    })
    const rev = await prisma.purchaseReversal.findUniqueOrThrow({
      where: { purchaseId },
    })
    expect(receipt).toMatchObject({
      status: "VOIDED",
      voidReference: rev.folio,
    })
    expect(
      await prisma.purchaseSignature.count({
        where: { purchaseId, status: "VALID" },
      })
    ).toBe(1)
    expect(await balances(playerId)).toEqual(["0.00"])
    expect((await nominal()).circulation).toBe("0.00")
    // Sin dinero inventado: la caja no cambió al revertir.
    expect(await cash()).toBe("2000.00")
    const reversal = await prisma.purchaseReversal.findUniqueOrThrow({
      where: { id: ok.reversalId },
    })
    expect(D(reversal.extinguishedAmount).toFixed(2)).toBe("3000.00")
    expect(D(reversal.refundAmount).toFixed(2)).toBe("2000.00")
    const correction = await getCorrection(correctionId)
    expect(correction.status).toBe("EXECUTED")
    // La compra original es inmutable (solo REVERSED con reverso registrado).
    await expect(
      prisma.chipPurchase.update({
        where: { id: purchaseId },
        data: { nominalAmount: "1" },
      })
    ).rejects.toThrow()
    // La deuda extinguida no se reabre ni admite abonos.
    await expect(
      registerPayment(cashier, {
        playerId,
        amount: "100",
        origin: "SESSION",
        method: "CASH",
        cashReceived: true,
        idempotencyKey: key(),
      } as Parameters<typeof registerPayment>[1])
    ).rejects.toThrow()
    // Reembolso REAL desde la caja de su sesión (sigue OPEN).
    const payable = await prisma.specialPayable.findUniqueOrThrow({
      where: {
        kind_sourceId: { kind: "PURCHASE_REFUND", sourceId: ok.reversalId },
      },
    })
    await registerSpecialPayout(cashier, payable.id, {
      method: "CASH",
      funding: "SESSION_CASH",
      amount: "2000",
      idempotencyKey: key(),
    })
    expect(await cash()).toBe("0.00")
    await expect(
      registerSpecialPayout(cashier, payable.id, {
        method: "CASH",
        funding: "SESSION_CASH",
        amount: "1",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/pendiente/)
    await expectCleanIntegrity()
  })

  it("una compra con abono aplicado: el abono se reembolsa y ya no puede revertirse en el Módulo 10", async () => {
    const { playerId, participationId } = await seat()
    const purchaseId = await buy(participationId, "3000")
    const { paymentId } = await registerPayment(cashier, {
      playerId,
      amount: "1000",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    } as Parameters<typeof registerPayment>[1])
    const correctionId = await approvedCorrection(
      "PURCHASE_REVERSAL",
      "ChipPurchase",
      purchaseId
    )
    const p = await getPurchase(purchaseId)
    const plan = (
      await previewPurchaseReversal(purchaseId, {
        physicalReturnConfirmed: true,
        returnedNominal: "3000",
      })
    ).plan
    expect(plan.effects).toMatchObject({
      extinguish: "2000.00",
      refund: "1000.00",
    })
    await executePurchaseReversal(cashier, purchaseId, {
      correctionId,
      expectedVersion: p.version,
      physicalReturnConfirmed: true,
      returnedNominal: "3000",
      reason: "Compra duplicada por error de captura",
      idempotencyKey: key(),
    })
    await expect(
      reversePayment(cashier, paymentId, {
        reason: "Abono mal capturado",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/compra revertida/)
    expect((await getPayment(paymentId)).status).toBe("CONFIRMED")
  })
})

describe("16.3 corrección de liquidación", () => {
  it("Escenario C: liquidación 8,000 (compensa 2,000, paga 6,000) → reverso de compensación sin efectivo ficticio", async () => {
    const { playerId, participationId } = await seat("Jugador liquidación")
    await buy(participationId, "2000")
    await buy(participationId, "6000", "6000")
    const created = await createSettlement(cashier, {
      participationId,
      returnedNominalAmount: "8000",
      offsetDecision: "MAXIMUM",
      idempotencyKey: key(),
    })
    const prepared = await prepareSettlementSignatureSummary(
      cashier,
      created.settlementId
    )
    await captureSettlementSignature(cashier, created.settlementId, {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: key(),
    })
    let s = await getSettlement(created.settlementId)
    await confirmReturn(cashier, created.settlementId, {
      expectedVersion: s.version,
      chipsReceived: true,
      idempotencyKey: key(),
    })
    await registerPayout(cashier, created.settlementId, {
      method: "CASH",
      amount: "6000",
      cashDelivered: true,
      idempotencyKey: key(),
    })
    expect(await balances(playerId)).toEqual(["0.00"])
    const cashAfterSettlement = await cash()
    s = await getSettlement(created.settlementId)
    const correctionId = await approvedCorrection(
      "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      "PlayerSettlement",
      s.id
    )
    expect((await auditRows("SETTLEMENT_CORRECTION_APPROVED")).length).toBe(1)
    const txBefore = await prisma.cashTransaction.count()
    // La compensación la calcula el servidor: el cliente no la envía.
    const r = await executeSettlementCorrection(cashier, s.id, {
      kind: "OFFSET_REVERSAL",
      correctionId,
      expectedVersion: s.version,
      reason: "El jugador pidió efectivo; la compensación fue un error",
      strokes: STROKES,
      idempotencyKey: key(),
    })
    // Deuda restablecida, nueva obligación y NINGÚN asiento de efectivo.
    expect(await balances(playerId)).toEqual(["2000.00"])
    expect(await prisma.cashTransaction.count()).toBe(txBefore)
    expect(await cash()).toBe(cashAfterSettlement)
    const payable = await prisma.specialPayable.findUniqueOrThrow({
      where: {
        kind_sourceId: {
          kind: "SETTLEMENT_ADJUSTMENT",
          sourceId: r.correctionRecordId,
        },
      },
    })
    expect(D(payable.originalAmount).toFixed(2)).toBe("2000.00")
    expect((await getCorrection(correctionId)).status).toBe("EXECUTED")
    // La liquidación original y su firma se conservan.
    const original = await getSettlement(s.id)
    expect(original.status).toBe(s.status)
    expect(
      await prisma.specialOperationEvidence.count({
        where: { sourceType: "SettlementCorrection" },
      })
    ).toBe(1)
    // Una sola corrección de compensación por liquidación.
    const again = await approvedCorrection(
      "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      "PlayerSettlement",
      s.id
    )
    await expect(
      executeSettlementCorrection(cashier, s.id, {
        kind: "OFFSET_REVERSAL",
        correctionId: again,
        expectedVersion: s.version,
        reason: "Segundo intento de revertir la compensación",
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya se revirtió|no tiene compensación/)
    await expectCleanIntegrity()
  })

  it("sin solicitud aprobada no se ejecuta; el pago adicional crea una obligación nueva", async () => {
    const { participationId } = await seat()
    await buy(participationId, "1000", "1000")
    const created = await createSettlement(cashier, {
      participationId,
      returnedNominalAmount: "1000",
      offsetDecision: "NO_COMPENSATE",
      idempotencyKey: key(),
    })
    const prepared = await prepareSettlementSignatureSummary(
      cashier,
      created.settlementId
    )
    await captureSettlementSignature(cashier, created.settlementId, {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: key(),
    })
    let s = await getSettlement(created.settlementId)
    await confirmReturn(cashier, created.settlementId, {
      expectedVersion: s.version,
      chipsReceived: true,
      idempotencyKey: key(),
    })
    s = await getSettlement(created.settlementId)
    const pending = await createCorrection(cashier, {
      type: "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      targetType: "PlayerSettlement",
      targetId: s.id,
      reason: "Faltó pagar una diferencia de conteo",
      idempotencyKey: key(),
    })
    await expect(
      executeSettlementCorrection(cashier, s.id, {
        kind: "ADDITIONAL_PAYOUT",
        amount: "200",
        correctionId: pending.id,
        expectedVersion: s.version,
        reason: "Faltó pagar una diferencia de conteo",
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/APROBADA/)
    await decideCorrection(admin, pending.id, "APPROVED", {
      expectedVersion: 1,
      notes: "Autorizado",
    })
    const r = await executeSettlementCorrection(cashier, s.id, {
      kind: "ADDITIONAL_PAYOUT",
      amount: "200",
      correctionId: pending.id,
      expectedVersion: s.version,
      reason: "Faltó pagar una diferencia de conteo",
      strokes: STROKES,
      idempotencyKey: key(),
    })
    const payable = await prisma.specialPayable.findUniqueOrThrow({
      where: {
        kind_sourceId: {
          kind: "SETTLEMENT_ADJUSTMENT",
          sourceId: r.correctionRecordId,
        },
      },
    })
    expect(D(payable.originalAmount).toFixed(2)).toBe("200.00")
    expect(payable.status).toBe("OPEN")
  })
})

describe("16.4 devolución de fondos no aplicados", () => {
  it("Escenario D: deuda 2,000 y transferencia 3,000 → excedente 1,000; devoluciones 600 + 400", async () => {
    const { playerId, participationId } = await seat("Jugador excedente")
    await buy(participationId, "3000")
    const { paymentId } = await registerPayment(cashier, {
      playerId,
      amount: "3000",
      origin: "ADMINISTRATIVE",
      method: "BANK_TRANSFER",
      bankReference: "SPEI-IN-1",
      idempotencyKey: key(),
    })
    await registerPayment(cashier, {
      playerId,
      amount: "1000",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    } as Parameters<typeof registerPayment>[1])
    expect(await balances(playerId)).toEqual(["2000.00"])
    const t = (await getPayment(paymentId)).bankTransfer!
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await balances(playerId)).toEqual(["0.00"])
    const funds = await prisma.unappliedPlayerFunds.findFirstOrThrow({
      where: { playerId },
    })
    expect(D(funds.amount).toFixed(2)).toBe("1000.00")
    expect((await getUnappliedFunds(funds.id)).status).toBe("PENDING_REVIEW")
    // Sin autorización no hay devolución.
    const pendingReq = await createCorrection(cashier, {
      type: "UNAPPLIED_FUNDS_RETURN",
      targetType: "UnappliedPlayerFunds",
      targetId: funds.id,
      reason: "Devolver el excedente de la transferencia",
      idempotencyKey: key(),
    })
    await expect(
      registerUnappliedRefund(cashier, funds.id, {
        correctionId: pendingReq.id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/APROBADA/)
    await decideCorrection(partner, pendingReq.id, "APPROVED", {
      expectedVersion: 1,
      notes: "Devuélvase",
    })
    const { payableId } = await registerUnappliedRefund(cashier, funds.id, {
      correctionId: pendingReq.id,
      idempotencyKey: key(),
    })
    expect((await getUnappliedFunds(funds.id)).status).toBe("PENDING_REFUND")
    expect((await getCorrection(pendingReq.id)).status).toBe("EXECUTED")
    const bankBefore = await globalBalance("BANK")
    const unappliedBefore = await globalBalance("UNAPPLIED_PLAYER_FUNDS")
    expect(unappliedBefore).toBe("-1000.00")
    // 600 por transferencia (pendiente no cuenta; ejecutada sí).
    const { payoutId } = await registerSpecialPayout(cashier, payableId, {
      method: "BANK_TRANSFER",
      amount: "600",
      idempotencyKey: key(),
    })
    expect((await getUnappliedFunds(funds.id)).status).toBe("PENDING_REFUND")
    expect(await globalBalance("BANK")).toBe(bankBefore)
    await resolveSpecialPayout(cashier, payoutId, {
      outcome: "EXECUTED",
      bankReference: "SPEI-OUT-600",
      idempotencyKey: key(),
    })
    expect((await getUnappliedFunds(funds.id)).status).toBe(
      "PARTIALLY_REFUNDED"
    )
    expect(await globalBalance("BANK")).toBe(D(bankBefore).sub(600).toFixed(2))
    // 400 en efectivo desde custodia.
    await fundCustody("400")
    await registerSpecialPayout(cashier, payableId, {
      method: "CASH",
      amount: "400",
      idempotencyKey: key(),
    })
    const done = await getUnappliedFunds(funds.id)
    expect(done.status).toBe("REFUNDED")
    expect(done.payable).toMatchObject({ paid: "1000.00", pending: "0.00" })
    expect(await globalBalance("UNAPPLIED_PLAYER_FUNDS")).toBe("0.00")
    // Nunca más que lo recibido.
    await expect(
      registerSpecialPayout(cashier, payableId, {
        method: "CASH",
        amount: "1",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/pendiente/)
    // El trigger impide pagar de más aunque se salte el servicio.
    await expect(
      prisma.specialPayout.create({
        data: {
          folio: "PES-X",
          payableId,
          sequence: 99,
          amount: "1",
          method: "CASH",
          funding: "ADMIN_CUSTODY",
          status: "PENDING",
          requestedById: cashier.id,
          idempotencyKey: key(),
        },
      })
    ).rejects.toThrow(/excede/)
    expect((await auditRows("UNAPPLIED_FUNDS_PARTIALLY_REFUNDED")).length).toBe(
      1
    )
    expect((await auditRows("UNAPPLIED_FUNDS_REFUNDED")).length).toBe(1)
    await expectCleanIntegrity()
  })
})

describe("integridad", () => {
  it("el diagnóstico queda limpio tras las cuatro operaciones", async () => {
    const { participationId } = await seat()
    const purchaseId = await buy(participationId, "1000", "1000")
    const correctionId = await approvedCorrection(
      "PURCHASE_REVERSAL",
      "ChipPurchase",
      purchaseId
    )
    const p = await getPurchase(purchaseId)
    await executePurchaseReversal(cashier, purchaseId, {
      correctionId,
      expectedVersion: p.version,
      physicalReturnConfirmed: true,
      returnedNominal: "1000",
      reason: "Compra capturada por error en la prueba",
      idempotencyKey: key(),
    })
    const run = await runIntegrityCheck(admin, { trigger: "MANUAL" })
    const errors = await prisma.integrityFinding.findMany({
      where: { runId: run.runId, status: "ERROR" },
      select: { checkCode: true, explanation: true },
    })
    expect(errors).toEqual([])
    expect(run.summary.error).toBe(0)
    expect(run.summary.notEvaluated).toBe(0)
  })

  it("detecta un canje con fichas «recibidas» sin entrada real (inconsistencia inyectada SOLO en pruebas)", async () => {
    await prisma.lateChipRedemption.create({
      data: {
        folio: "CAN-FAKE",
        presenterName: "Inyección de prueba",
        presentedNominal: "100",
        acceptedNominal: "100",
        status: "VALIDATING",
        chipOperationId: "no-existe",
        requestedById: cashier.id,
        idempotencyKey: key(),
      },
    })
    const run = await runIntegrityCheck(admin, { trigger: "MANUAL" })
    const found = await prisma.integrityFinding.findMany({
      where: { runId: run.runId, checkCode: "REDEMPTION_ENTRY_ONCE" },
    })
    expect(found).toHaveLength(1)
    expect(found[0].status).toBe("ERROR")
  })
})
