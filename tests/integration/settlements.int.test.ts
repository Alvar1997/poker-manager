import { randomUUID } from "node:crypto"

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as settlementsRoute from "@/app/api/settlements/route"
import * as confirmReturnRoute from "@/app/api/settlements/[id]/confirm-return/route"
import * as payoutsRoute from "@/app/api/settlements/[id]/payouts/route"
import * as receiptImageRoute from "@/app/api/settlements/[id]/receipt/image/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  contributeToCustody,
  custodyBalanceOf,
} from "@/modules/credits/custody.service"
import { registerPayment } from "@/modules/credits/receivable-payment.service"
import { receivablesOf } from "@/modules/credits/receivable.service"
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
import {
  addPlayerToTable,
  transferPlayer,
} from "@/modules/session-tables/participation.service"
import {
  closeSessionTable,
  openSessionTable,
} from "@/modules/session-tables/session-table.service"
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
  listPendingPayables,
  registerPayout,
  resolvePayout,
} from "@/modules/settlements/settlement-payout.service"
import {
  getSettlementReceipts,
  renderSettlementReceiptPng,
} from "@/modules/settlements/settlement-receipt.service"
import {
  captureSettlementSignature,
  getSettlementSignatureStatus,
  prepareSettlementSignatureSummary,
} from "@/modules/settlements/settlement-signature.service"
import {
  cancelSettlement,
  confirmReturn,
  createSettlement,
  getSessionSettlementOverview,
  getSettlement,
  getSettlementContext,
  reverseSettlement,
  updateSettlementDraft,
} from "@/modules/settlements/settlement.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

/**
 * Módulo 11 — liquidaciones contra PostgreSQL REAL (sin mocks financieros):
 * las deudas nacen del flujo completo de compra + firma + entrega, el
 * inventario es el compartido del Módulo 04 y el dinero el libro del
 * Módulo 05.
 */

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
async function actorFor(role: Role = "CASHIER") {
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
let sessionId: string
let t25: string
let t10: string

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

/** Cierre de PRUEBA (el Módulo 12 aún no existe): OPEN → CLOSING → CLOSED. */
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
  t10 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_10_10" },
    })
  ).id
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
  await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
})

async function seat(tableId = t25, playerId?: string, sid = sessionId) {
  const pid = playerId ?? (await createTestPlayer()).id
  const r = await addPlayerToTable(cashier, sid, tableId, {
    playerId: pid,
    idempotencyKey: key(),
  })
  return { playerId: pid, participationId: r.participationId }
}

/** Compra pagada en efectivo (sin crédito ni firma): fichas a circulación y efectivo a la caja. */
async function cashBuy(participationId: string, amount: string) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  await recordPayment(cashier, purchaseId, {
    method: "CASH",
    amount,
    cashReceived: true,
    idempotencyKey: key(),
  })
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

/** Deuda REAL: compra a crédito con socio, firma y entrega confirmada. */
async function creditBuy(participationId: string, amount: string) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
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
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

type Decision = "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
async function draft(
  participationId: string,
  returned: string,
  decision: Decision = "NO_COMPENSATE",
  offsetAmount?: string
) {
  const r = await createSettlement(cashier, {
    participationId,
    returnedNominalAmount: returned,
    offsetDecision: decision,
    ...(offsetAmount ? { offsetAmount } : {}),
    idempotencyKey: key(),
  })
  return r.settlementId
}

async function sign(settlementId: string) {
  const prepared = await prepareSettlementSignatureSummary(
    cashier,
    settlementId
  )
  await captureSettlementSignature(cashier, settlementId, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: key(),
  })
  return prepared.summary
}

async function confirm(
  settlementId: string,
  extra: { immediateCashAmount?: string; idempotencyKey?: string } = {}
) {
  const s = await getSettlement(settlementId)
  return confirmReturn(cashier, settlementId, {
    expectedVersion: s.version,
    chipsReceived: true,
    ...(extra.immediateCashAmount
      ? { immediateCashAmount: extra.immediateCashAmount, cashDelivered: true }
      : {}),
    idempotencyKey: extra.idempotencyKey ?? key(),
  })
}

async function settle(
  participationId: string,
  returned: string,
  decision: Decision = "NO_COMPENSATE",
  offsetAmount?: string,
  immediateCashAmount?: string
) {
  const id = await draft(participationId, returned, decision, offsetAmount)
  await sign(id)
  const r = await confirm(id, { immediateCashAmount })
  return r.settlement
}

const cashPayout = (id: string, amount: string, k = key()) =>
  registerPayout(cashier, id, {
    method: "CASH",
    amount,
    cashDelivered: true,
    idempotencyKey: k,
  })
const bankPayout = (id: string, amount: string) =>
  registerPayout(cashier, id, {
    method: "BANK_TRANSFER",
    amount,
    bankReference: "SPEI-OUT-1",
    idempotencyKey: key(),
  })

async function balances(playerId: string) {
  return (await receivablesOf(prisma, playerId)).map((r) =>
    r.balance.toFixed(2)
  )
}
async function nominal() {
  const s = await prisma.chipSetInventoryState.findFirstOrThrow()
  return {
    custody: D(s.custodyNominal).toFixed(2),
    circulation: D(s.circulationNominal).toFixed(2),
  }
}
async function cash(sid = sessionId) {
  return (await cashBalanceOf(prisma, sid)).balance.toFixed(2)
}
async function globalBalance(kind: string) {
  const row = await prisma.financialAccountBalance.findFirst({
    where: { scopeKey: "GLOBAL", account: { kind: kind as "BANK" } },
  })
  return row ? D(row.balance).toFixed(2) : "0.00"
}
const returnMoves = () =>
  prisma.chipNominalMovement.count({ where: { movementType: "CHIP_RETURN" } })
async function participationStatus(id: string) {
  return (await prisma.tableParticipation.findUniqueOrThrow({ where: { id } }))
    .status
}

// ─────────────────────────────────────────────────────────────────────

describe("vínculo con compras, mesas e inventario", () => {
  it("jugador con compras en ambas mesas: la transferencia no mueve fichas, la liquidación es de la mesa final y las compras conservan su mesa", async () => {
    const other = await seat(t25)
    await cashBuy(other.participationId, "1000")
    const { playerId, participationId } = await seat(t25)
    const first = await cashBuy(participationId, "1000")
    const movesBefore = await prisma.chipNominalMovement.count()
    const t = await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    expect(await prisma.chipNominalMovement.count()).toBe(movesBefore)
    const finalParticipation = t.destinationParticipation.id
    const second = await cashBuy(finalParticipation, "500")
    expect(await nominal()).toEqual({
      custody: "97500.00",
      circulation: "2500.00",
    })
    // Gana fichas en la mesa: devuelve $2,000 aunque solo compró $1,500.
    const s = await settle(finalParticipation, "2000")
    expect(s.table.id).toBe(t10)
    expect(s.participationId).toBe(finalParticipation)
    expect(await nominal()).toEqual({
      custody: "99500.00",
      circulation: "500.00",
    })
    const purchases = await prisma.chipPurchase.findMany({
      where: { id: { in: [first, second] } },
      select: { id: true, tableId: true },
    })
    expect(purchases.find((p) => p.id === first)?.tableId).toBe(t25)
    expect(purchases.find((p) => p.id === second)?.tableId).toBe(t10)
    const moves = await prisma.chipNominalMovement.findMany({
      where: { movementType: "CHIP_RETURN" },
    })
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({
      referenceType: "PlayerSettlement",
      referenceId: s.id,
      tableId: t10,
      playerId,
    })
    expect(D(moves[0].amount).toFixed(2)).toBe("2000.00")
    // Nunca se capturan denominaciones: ningún movimiento por denominación.
    expect(
      await prisma.chipInventoryMovement.count({
        where: { movementType: "CHIP_RETURN" },
      })
    ).toBe(0)
  })

  it("la devolución aumenta el inventario UNA vez: reintentos y confirmaciones simultáneas no la duplican", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "3000")
    const id = await draft(participationId, "3000")
    await sign(id)
    const s = await getSettlement(id)
    const k = key()
    const body = {
      expectedVersion: s.version,
      chipsReceived: true as const,
      idempotencyKey: k,
    }
    const [a, b] = await Promise.all([
      confirmReturn(cashier, id, body),
      confirmReturn(cashier, id, body),
    ])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    const again = await confirmReturn(cashier, id, body)
    expect(again.replayed).toBe(true)
    await expect(
      confirmReturn(cashier, id, { ...body, idempotencyKey: key() })
    ).rejects.toThrow(/ya se confirmó/)
    expect(await returnMoves()).toBe(1)
    expect(await nominal()).toEqual({
      custody: "100000.00",
      circulation: "0.00",
    })
    expect(await prisma.settlementPayable.count()).toBe(1)
    expect(await prisma.settlementReceipt.count()).toBe(1)
  })

  it("dos confirmaciones simultáneas con claves distintas: solo una recibe las fichas", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "1000")
    const id = await draft(participationId, "1000")
    await sign(id)
    const v = (await getSettlement(id)).version
    const results = await Promise.allSettled([
      confirmReturn(cashier, id, {
        expectedVersion: v,
        chipsReceived: true,
        idempotencyKey: key(),
      }),
      confirmReturn(cashier, id, {
        expectedVersion: v,
        chipsReceived: true,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await returnMoves()).toBe(1)
  })

  it("el valor devuelto no puede exceder las fichas en circulación", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "1000")
    await expect(draft(participationId, "1500")).rejects.toThrow(
      /excede las fichas en circulación/
    )
  })
})

describe("compensación opcional de deudas", () => {
  it("NO_COMPENSATE conserva la deuda anterior y el neto es todo lo devuelto", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "1000")
    const s = await settle(participationId, "1000")
    expect(s.offsetDecision).toBe("NO_COMPENSATE")
    expect(s.offsetAmount).toBe("0.00")
    expect(s.netPayoutAmount).toBe("1000.00")
    expect(await balances(playerId)).toEqual(["1000.00"])
    expect(
      await prisma.paymentAllocation.count({ where: { settlementId: s.id } })
    ).toBe(0)
    expect(s.status).toBe("PENDING_PAYOUT")
    expect(await participationStatus(participationId)).toBe("SETTLING")
  })

  it("compensación PARCIAL: FIFO automático A $1,000 + B $1,500 y C intacta; no mueve efectivo", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "1000")
    await creditBuy(participationId, "2000")
    await creditBuy(participationId, "3000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "2000")
    const cashBefore = await cash()
    const txBefore = await prisma.cashTransaction.count()
    const s = await settle(participationId, "8000", "PARTIAL", "2500")
    expect(s.offsetAmount).toBe("2500.00")
    expect(s.netPayoutAmount).toBe("5500.00")
    expect(s.debtBalanceSnapshot).toBe("6000.00")
    expect(s.offsets.map((o) => o.amount)).toEqual(["1000.00", "1500.00"])
    expect(await balances(playerId)).toEqual(["0.00", "500.00", "3000.00"])
    // La compensación no es ingreso ni egreso: ningún asiento nuevo.
    expect(await cash()).toBe(cashBefore)
    expect(await prisma.cashTransaction.count()).toBe(txBefore)
    expect(s.payable).toMatchObject({ pending: "5500.00", paid: "0.00" })
  })

  it("compensación MÁXIMA: deuda $5,000 y fichas $8,000 → compensa $5,000 y paga $3,000", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "5000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "3000")
    const s = await settle(participationId, "8000", "MAXIMUM")
    expect(s.offsetAmount).toBe("5000.00")
    expect(s.netPayoutAmount).toBe("3000.00")
    expect(await balances(playerId)).toEqual(["0.00"])
  })

  it("compensación máxima que cubre todo el valor: neto $0, liquidación COMPLETED sin desembolso ficticio", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "5000")
    const before = await prisma.cashTransaction.count()
    const s = await settle(participationId, "3000", "MAXIMUM")
    expect(s).toMatchObject({
      status: "COMPLETED",
      offsetAmount: "3000.00",
      netPayoutAmount: "0.00",
    })
    expect(s.payable).toMatchObject({ status: "PAID", netPayout: "0.00" })
    expect(s.payouts).toHaveLength(0)
    expect(await prisma.cashTransaction.count()).toBe(before)
    expect(await balances(playerId)).toEqual(["2000.00"])
    expect(await participationStatus(participationId)).toBe("SETTLED")
  })

  it("rechaza compensaciones mayores que las fichas o que la deuda, y compensar con $0 devueltos o sin deuda", async () => {
    const { participationId } = await seat()
    await creditBuy(participationId, "1000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "3000")
    await expect(
      draft(participationId, "800", "PARTIAL", "900")
    ).rejects.toThrow(/exceder el valor de las fichas/)
    await expect(
      draft(participationId, "3000", "PARTIAL", "1500")
    ).rejects.toThrow(/exceder la deuda pendiente/)
    await expect(draft(participationId, "0", "MAXIMUM")).rejects.toThrow(
      /\$0 en fichas/
    )
    await expect(
      draft(other.participationId, "500", "MAXIMUM")
    ).rejects.toThrow(/no tiene deuda pendiente/)
    expect(await prisma.playerSettlement.count()).toBe(0)
  })

  it("el cliente no puede elegir deudas ni enviar denominaciones, neto o distribución (400)", async () => {
    const { participationId } = await seat()
    await creditBuy(participationId, "1000")
    signInAs(cashier._user)
    const base = {
      participationId,
      returnedNominalAmount: "1000",
      offsetDecision: "PARTIAL",
      offsetAmount: "500",
      idempotencyKey: key(),
    }
    for (const extra of [
      { allocations: [{ receivableId: "x", amount: "500" }] },
      { denominations: [{ value: "500", quantity: 2 }] },
      { netPayoutAmount: "500" },
      { playerId: "otro" },
    ]) {
      const res = await call(settlementsRoute.POST, {
        method: "POST",
        path: "/api/settlements",
        body: { ...base, ...extra },
      })
      expect(res.status).toBe(400)
    }
    const ok = await call(settlementsRoute.POST, {
      method: "POST",
      path: "/api/settlements",
      body: base,
    })
    expect(ok.status).toBe(201)
  })
})

describe("firma obligatoria", () => {
  it("sin firma no se confirma la recepción (ni con $0); la firma por sí sola no mueve inventario ni deudas", async () => {
    const zero = await seat()
    const zeroId = await draft(zero.participationId, "0")
    await expect(confirm(zeroId)).rejects.toThrow(/requiere firma/)
    const { playerId, participationId } = await seat(t10)
    await creditBuy(participationId, "2000")
    const id = await draft(participationId, "2000", "PARTIAL", "1000")
    await expect(confirm(id)).rejects.toThrow(/requiere firma/)
    const before = await nominal()
    await sign(id)
    expect((await getSettlement(id)).status).toBe("READY_FOR_CONFIRMATION")
    expect(await nominal()).toEqual(before)
    expect(await balances(playerId)).toEqual(["2000.00"])
    expect(await prisma.settlementPayable.count()).toBe(0)
    const status = await getSettlementSignatureStatus(id)
    expect(status.required).toBe(true)
    expect(status.validSignature?.current).toBe(true)
    expect(status.validSignature?.summary.declarationText).toMatch(
      /valor nominal de fichas indicado/
    )
  })

  it("una firma no se reutiliza: el mismo resumen no se firma dos veces y otra liquidación no puede usarla", async () => {
    const a = await seat()
    const b = await seat(t10)
    await cashBuy(a.participationId, "1000")
    await cashBuy(b.participationId, "1000")
    const idA = await draft(a.participationId, "1000")
    const summary = await sign(idA)
    await expect(
      captureSettlementSignature(cashier, idA, {
        snapshotId: summary.snapshotId,
        payloadHash: summary.payloadHash,
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/firm/i)
    const idB = await draft(b.participationId, "1000")
    const sigA = await prisma.settlementSignature.findFirstOrThrow({
      where: { settlementId: idA },
    })
    await expect(
      captureSettlementSignature(cashier, idB, {
        snapshotId: summary.snapshotId,
        payloadHash: summary.payloadHash,
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/no encontrado/)
    // La base impide recibir con la firma de OTRA liquidación.
    await prisma.$executeRawUnsafe(
      `UPDATE "player_settlements" SET "status" = 'READY_FOR_CONFIRMATION' WHERE "id" = '${idB}'`
    )
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "player_settlements" SET "signatureId" = '${sigA.id}' WHERE "id" = '${idB}'`
      )
    ).rejects.toThrow()
  })

  it("cambiar el importe o la compensación invalida la firma (se conserva) y exige firmar de nuevo", async () => {
    const { participationId } = await seat()
    await creditBuy(participationId, "3000")
    const id = await draft(participationId, "3000", "PARTIAL", "1000")
    await sign(id)
    const v1 = (await getSettlement(id)).version
    await updateSettlementDraft(cashier, id, {
      expectedVersion: v1,
      returnedNominalAmount: "2500",
    })
    let s = await getSettlement(id)
    expect(s).toMatchObject({ status: "DRAFT", version: v1 + 1 })
    expect(
      await prisma.settlementSignature.findMany({
        where: { settlementId: id },
        select: { status: true },
      })
    ).toEqual([{ status: "INVALIDATED" }])
    await expect(
      confirmReturn(cashier, id, {
        expectedVersion: v1,
        chipsReceived: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow()
    await sign(id)
    await updateSettlementDraft(cashier, id, {
      expectedVersion: v1 + 1,
      offsetDecision: "MAXIMUM",
    })
    s = await getSettlement(id)
    expect(s).toMatchObject({ status: "DRAFT", version: v1 + 2 })
    expect(
      await prisma.settlementSignature.count({
        where: { settlementId: id, status: "INVALIDATED" },
      })
    ).toBe(2)
    await sign(id)
    const done = (await confirm(id)).settlement
    expect(done).toMatchObject({
      offsetAmount: "2500.00",
      netPayoutAmount: "0.00",
    })
    expect(await auditRows("SETTLEMENT_SIGNATURE_INVALIDATED")).toHaveLength(2)
  })

  it("si las deudas cambian entre la firma y la recepción, se bloquea y exige nueva firma (NO_COMPENSATE no se afecta)", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "1000")
    await creditBuy(participationId, "1000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "1000")
    const id = await draft(participationId, "2000", "PARTIAL", "1500")
    await sign(id)
    // Un abono cambia la distribución FIFO comprometida.
    await registerPayment(cashier, {
      playerId,
      amount: "300",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await expect(confirm(id)).rejects.toThrow(
      /cambió desde que el jugador firmó/
    )
    expect(await returnMoves()).toBe(0)
    expect(
      await prisma.paymentAllocation.count({ where: { settlementId: id } })
    ).toBe(0)
    // Preparar de nuevo invalida la firma anterior (nueva versión) y se firma otra vez.
    await sign(id)
    const s = (await confirm(id)).settlement
    expect(s.offsets.map((o) => o.amount)).toEqual(["700.00", "800.00"])
    expect(await balances(playerId)).toEqual(["0.00", "200.00"])

    const p2 = await seat(t10)
    await creditBuy(p2.participationId, "500")
    const id2 = await draft(p2.participationId, "500")
    await sign(id2)
    await registerPayment(cashier, {
      playerId: p2.playerId,
      amount: "100",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    // Sin compensación la distribución firmada no cambia: se confirma.
    expect((await confirm(id2)).settlement.netPayoutAmount).toBe("500.00")
  })
})

describe("devolución de $0", () => {
  it("con firma termina la participación sin entrada nominal ni desembolso ficticios y con comprobante", async () => {
    const { participationId } = await seat()
    const txBefore = await prisma.cashTransaction.count()
    const s = await settle(participationId, "0")
    expect(s).toMatchObject({
      status: "COMPLETED",
      returnedNominalAmount: "0.00",
      netPayoutAmount: "0.00",
      chipReturnOperationId: null,
    })
    expect(await returnMoves()).toBe(0)
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "CHIP_RETURN" },
      })
    ).toBe(0)
    expect(await prisma.cashTransaction.count()).toBe(txBefore)
    expect(s.payable).toMatchObject({ status: "PAID", netPayout: "0.00" })
    expect(await participationStatus(participationId)).toBe("SETTLED")
    const r = await getSettlementReceipts(s.id)
    expect(r.reception.content.returnedNominalAmount).toBe("0.00")
    expect(r.reception.intact).toBe(true)
  })
})

describe("pagos al jugador", () => {
  it("pago parcial en efectivo: PENDING_PAYOUT + SETTLING; sin compras, transferencias ni reingreso; el pago final la completa", async () => {
    const { playerId, participationId } = await seat()
    await cashBuy(participationId, "3000")
    expect(await cash()).toBe("3000.00")
    const s = await settle(
      participationId,
      "3000",
      "NO_COMPENSATE",
      undefined,
      "1000"
    )
    expect(s.status).toBe("PENDING_PAYOUT")
    expect(s.payable).toMatchObject({ paid: "1000.00", pending: "2000.00" })
    expect(await cash()).toBe("2000.00")
    const p = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: participationId },
    })
    expect(p).toMatchObject({ status: "SETTLING", settlementId: s.id })
    expect(p.leftAt).not.toBeNull()
    await expect(
      createPurchase(cashier, {
        participationId,
        nominalAmount: "500",
        idempotencyKey: key(),
      })
    ).rejects.toThrow()
    await expect(
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: participationId,
        destinationTableId: t10,
        idempotencyKey: key(),
      })
    ).rejects.toThrow()
    await expect(seat(t10, playerId)).rejects.toThrow(/pendiente de pago/)
    await cashPayout(s.id, "2000")
    const done = await getSettlement(s.id)
    expect(done.status).toBe("COMPLETED")
    expect(done.payable).toMatchObject({ status: "PAID", pending: "0.00" })
    expect(await participationStatus(participationId)).toBe("SETTLED")
    expect(await cash()).toBe("0.00")
    // Ya pagada: el jugador puede volver con OTRA participación.
    const back = await seat(t10, playerId)
    expect(back.participationId).not.toBe(participationId)
  })

  it("la caja nunca queda negativa: un pago mayor al efectivo disponible se rechaza con el faltante", async () => {
    const a = await seat()
    await creditBuy(a.participationId, "5000")
    const b = await seat(t10)
    await cashBuy(b.participationId, "1000")
    const id = await draft(a.participationId, "5000")
    await sign(id)
    await expect(confirm(id, { immediateCashAmount: "2000" })).rejects.toThrow(
      /Faltan \$1000\.00/
    )
    expect(await returnMoves()).toBe(0)
    const s = (await confirm(id)).settlement
    await expect(cashPayout(s.id, "2000")).rejects.toThrow(/Faltan \$1000\.00/)
    expect(await cash()).toBe("1000.00")
    await expect(cashPayout(s.id, "6000")).rejects.toThrow(
      /excede el saldo por pagar/
    )
  })

  it("transferencias: PENDING no cuenta ni baja el banco y reserva; EXECUTED baja el banco; FAILED libera; pago mixto completo", async () => {
    const a = await seat()
    await creditBuy(a.participationId, "4000")
    const b = await seat(t10)
    await cashBuy(b.participationId, "4000")
    const bankBefore = await globalBalance("BANK")
    const s = await settle(
      a.participationId,
      "8000",
      "NO_COMPENSATE",
      undefined,
      "3000"
    )
    await bankPayout(s.id, "2000")
    let v = await getSettlement(s.id)
    expect(v.payable).toMatchObject({
      paid: "3000.00",
      inTransit: "2000.00",
      pending: "5000.00",
      available: "3000.00",
    })
    expect(await globalBalance("BANK")).toBe(bankBefore)
    await expect(bankPayout(s.id, "4000")).rejects.toThrow(
      /en transferencias en trámite/
    )
    const pending = v.payouts.find((p) => p.status === "PENDING")!
    await resolvePayout(cashier, s.id, pending.id, {
      outcome: "EXECUTED",
      bankReference: "SPEI-OK-1",
      executionVerified: true,
      idempotencyKey: key(),
    })
    v = await getSettlement(s.id)
    expect(v.payable).toMatchObject({ paid: "5000.00", pending: "3000.00" })
    expect(D(await globalBalance("BANK")).toFixed(2)).toBe(
      D(bankBefore).sub(2000).toFixed(2)
    )
    // Una transferencia fallida no cuenta y libera su reserva.
    await bankPayout(s.id, "3000")
    v = await getSettlement(s.id)
    const failed = v.payouts.find((p) => p.status === "PENDING")!
    await resolvePayout(cashier, s.id, failed.id, {
      outcome: "FAILED",
      reason: "Cuenta destino rechazada",
      idempotencyKey: key(),
    })
    await expect(
      resolvePayout(cashier, s.id, failed.id, {
        outcome: "EXECUTED",
        bankReference: "SPEI-X",
        executionVerified: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya fue resuelta/)
    v = await getSettlement(s.id)
    expect(v.payable).toMatchObject({ available: "3000.00", inTransit: "0.00" })
    await cashPayout(s.id, "1000")
    await bankPayout(s.id, "2000")
    v = await getSettlement(s.id)
    expect(v.status).toBe("PENDING_PAYOUT")
    await resolvePayout(
      cashier,
      s.id,
      v.payouts.find((p) => p.status === "PENDING")!.id,
      {
        outcome: "EXECUTED",
        bankReference: "SPEI-OK-2",
        executionVerified: true,
        idempotencyKey: key(),
      }
    )
    v = await getSettlement(s.id)
    expect(v.status).toBe("COMPLETED")
    expect(v.payable).toMatchObject({ paid: "8000.00", pending: "0.00" })
    expect(await participationStatus(a.participationId)).toBe("SETTLED")
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "BANK_TRANSFER_PAYOUT" },
      })
    ).toBe(2)
  })

  it("dos pagos simultáneos no exceden la obligación; un reintento con la misma clave no duplica", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "2000")
    const s = await settle(participationId, "1000")
    const results = await Promise.allSettled([
      cashPayout(s.id, "700"),
      cashPayout(s.id, "700"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const k = key()
    const [x, y] = await Promise.all([
      cashPayout(s.id, "300", k),
      cashPayout(s.id, "300", k),
    ])
    expect(x.payoutId).toBe(y.payoutId)
    const v = await getSettlement(s.id)
    expect(v.payable).toMatchObject({ paid: "1000.00", pending: "0.00" })
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "PLAYER_SETTLEMENT" },
      })
    ).toBe(2)
    // Aun saltándose el servicio, la base impide exceder la cuenta por pagar.
    const payable = await prisma.settlementPayable.findFirstOrThrow()
    await expect(
      prisma.settlementPayout.create({
        data: {
          payableId: payable.id,
          settlementId: s.id,
          playerId: v.player.id,
          sequence: 99,
          amount: "1",
          method: "BANK_TRANSFER",
          funding: "BANK",
          status: "PENDING",
          paymentAccountId: (await prisma.paymentAccount.findFirstOrThrow()).id,
          requestedById: cashier.id,
          idempotencyKey: key(),
        },
      })
    ).rejects.toThrow()
  })
})

describe("cierre de mesa y de sesión", () => {
  it("la mesa cierra con una participación SETTLING pero no con jugadores ACTIVE ni con liquidaciones en curso", async () => {
    const a = await seat()
    await creditBuy(a.participationId, "1000")
    await settle(a.participationId, "1000")
    expect(await participationStatus(a.participationId)).toBe("SETTLING")
    const b = await seat(t10)
    await draft(b.participationId, "0")
    await expect(
      closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    ).rejects.toThrow(/jugadores activos/)
    const overview = await getSessionSettlementOverview(prisma, sessionId)
    expect(overview).toMatchObject({ pendingPayoutCount: 1 })
    expect(overview.inProgress).toHaveLength(1)
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    expect(
      (await prisma.sessionTable.findFirstOrThrow({ where: { tableId: t25 } }))
        .status
    ).toBe("CLOSED")
    // Cerrar la mesa no cambia la obligación ni la completa.
    const pending = await listPendingPayables({ sessionId })
    expect(pending.totals).toMatchObject({ count: 1, pending: "1000.00" })
  })

  it("las obligaciones sobreviven al cierre de sesión y se pagan administrativamente sin tocar la caja cerrada", async () => {
    const a = await seat()
    await creditBuy(a.participationId, "2000")
    const s = await settle(a.participationId, "2000")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await closeSessionForTest(sessionId)
    const closedCash = await cash()
    const closedEntries = await prisma.cashTransactionEntry.count({
      where: { scopeKey: sessionId },
    })
    expect((await listPendingPayables()).totals.pending).toBe("2000.00")
    // Sin efectivo en custodia no se inventa dinero.
    await expect(cashPayout(s.id, "500")).rejects.toThrow(/insuficientes/i)
    await contributeToCustody(cashier, {
      amount: "500",
      counterpartyName: "Socio de prueba",
      reason: "Pagar liquidaciones pendientes",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await cashPayout(s.id, "500")
    expect(await custodyBalanceOf(cashier.id)).toBe("0.00")
    await bankPayout(s.id, "1500")
    let v = await getSettlement(s.id)
    await resolvePayout(
      cashier,
      s.id,
      v.payouts.find((p) => p.status === "PENDING")!.id,
      {
        outcome: "EXECUTED",
        bankReference: "SPEI-POST",
        executionVerified: true,
        idempotencyKey: key(),
      }
    )
    v = await getSettlement(s.id)
    expect(v.status).toBe("COMPLETED")
    expect(v.payouts.map((p) => p.funding)).toEqual(["ADMIN_CUSTODY", "BANK"])
    expect(await participationStatus(a.participationId)).toBe("SETTLED")
    // La caja de la sesión cerrada no se modificó.
    expect(await cash()).toBe(closedCash)
    expect(
      await prisma.cashTransactionEntry.count({
        where: { scopeKey: sessionId },
      })
    ).toBe(closedEntries)
  })

  it("deudas de otras sesiones: se consultan y se compensan en la sesión siguiente", async () => {
    const a = await seat()
    await creditBuy(a.participationId, "1000")
    await settle(a.participationId, "1000")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await closeSessionForTest(sessionId)
    const next = await openRealSession()
    await openSessionTable(cashier, next, t10, { idempotencyKey: key() })
    const again = await seat(t10, a.playerId, next)
    await cashBuy(again.participationId, "600")
    const ctx = await getSettlementContext(again.participationId)
    expect(ctx.outstandingDebt).toBe("1000.00")
    expect(ctx.debts[0]).toMatchObject({
      tableName: "Mesa 25/25",
      balance: "1000.00",
    })
    const s = await settle(again.participationId, "600", "MAXIMUM")
    expect(s).toMatchObject({
      offsetAmount: "600.00",
      netPayoutAmount: "0.00",
      status: "COMPLETED",
    })
    expect(await balances(a.playerId)).toEqual(["400.00"])
  })
})

describe("comprobantes", () => {
  it("recepción inmutable con lo pagado al emitir; los pagos posteriores generan anexos; PNG sin PDF", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "3000")
    const s = await settle(
      participationId,
      "3000",
      "NO_COMPENSATE",
      undefined,
      "1000"
    )
    const first = await getSettlementReceipts(s.id)
    expect(first.reception.content).toMatchObject({
      kind: "RECEPTION",
      netPayoutAmount: "3000.00",
      paidAtIssue: "1000.00",
      pendingAtIssue: "2000.00",
    })
    await cashPayout(s.id, "2000")
    const after = await getSettlementReceipts(s.id)
    expect(after.reception.contentHash).toBe(first.reception.contentHash)
    expect(after.reception.intact).toBe(true)
    expect(after.annexes).toHaveLength(1)
    expect(after.annexes[0].content).toMatchObject({
      kind: "PAYOUT",
      paidAtIssue: "3000.00",
      pendingAtIssue: "0.00",
      settlementStatus: "COMPLETED",
    })
    const { png } = await renderSettlementReceiptPng(s.id, null)
    expect(png.subarray(1, 4).toString()).toBe("PNG")
    signInAs(cashier._user)
    const img = await receiptImageRoute.GET(
      new NextRequest(
        `http://localhost:3000/api/settlements/${s.id}/receipt/image?receiptId=${after.annexes[0].id}`,
        { headers: { host: "localhost:3000" } }
      ),
      { params: Promise.resolve({ id: s.id }) }
    )
    expect(img.status).toBe(200)
    expect(img.headers.get("content-type")).toBe("image/png")
    expect(img.headers.get("content-disposition")).toMatch(
      /liquidacion-.*-pago-2\.png/
    )
    expect(
      Buffer.from(await img.arrayBuffer())
        .subarray(1, 4)
        .toString()
    ).toBe("PNG")
    expect(JSON.stringify(after)).not.toMatch(/pdf/i)
    await expect(
      prisma.settlementReceipt.updateMany({ data: { contentHash: "x" } })
    ).rejects.toThrow()
  })
})

describe("reversos y correcciones", () => {
  it("sin pagos: restaura la deuda, regresa las fichas al jugador, anula la cuenta por pagar y el comprobante; no inventa dinero", async () => {
    const { playerId, participationId } = await seat()
    await creditBuy(participationId, "2000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "1000")
    const s = await settle(participationId, "3000", "PARTIAL", "1500")
    expect(await balances(playerId)).toEqual(["500.00"])
    const txBefore = await prisma.cashTransaction.count()
    await expect(
      reverseSettlement(cashier, s.id, {
        reason: "Se capturó un importe equivocado",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/regresaste físicamente/)
    const r = await reverseSettlement(cashier, s.id, {
      reason: "Se capturó un importe equivocado",
      chipsHandedBack: true,
      idempotencyKey: key(),
    })
    expect(r.settlement.status).toBe("REVERSED")
    expect(r.settlement.payable?.status).toBe("VOIDED")
    expect(await balances(playerId)).toEqual(["2000.00"])
    expect(await nominal()).toMatchObject({ circulation: "3000.00" })
    expect(await prisma.cashTransaction.count()).toBe(txBefore)
    expect((await getSettlementReceipts(s.id)).reception.status).toBe("VOIDED")
    expect(await participationStatus(participationId)).toBe("SETTLED")
    // El jugador puede registrarse de nuevo con otra participación.
    await expect(seat(t25, playerId)).resolves.toBeTruthy()
    // Nada se borra.
    await expect(prisma.playerSettlement.deleteMany()).rejects.toThrow()
  })

  it("con pagos reales el reverso automático se bloquea; pago y reverso simultáneos: solo uno procede", async () => {
    const a = await seat()
    await cashBuy(a.participationId, "2000")
    const s = await settle(
      a.participationId,
      "1000",
      "NO_COMPENSATE",
      undefined,
      "100"
    )
    await expect(
      reverseSettlement(cashier, s.id, {
        reason: "Intento de reverso con pago real",
        chipsHandedBack: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/pagos reales/)
    const b = await seat(t10)
    const s2 = await settle(b.participationId, "1000")
    const results = await Promise.allSettled([
      cashPayout(s2.id, "500"),
      reverseSettlement(cashier, s2.id, {
        reason: "Reverso concurrente de prueba",
        chipsHandedBack: true,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const final = await getSettlement(s2.id)
    if (final.status === "REVERSED") expect(final.payouts).toHaveLength(0)
    else expect(final.payable?.paid).toBe("500.00")
  })
})

describe("concurrencia e inicio", () => {
  it("dos cajeros liquidando al mismo jugador a la vez crean UNA liquidación", async () => {
    const { participationId } = await seat()
    const results = await Promise.allSettled([
      draft(participationId, "0"),
      draft(participationId, "0"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.playerSettlement.count()).toBe(1)
  })

  it("con liquidación en curso no hay compras ni cambio de mesa; con una compra sin entregar no se liquida", async () => {
    const a = await seat()
    await cashBuy(a.participationId, "1000")
    const id = await draft(a.participationId, "1000")
    await expect(
      createPurchase(cashier, {
        participationId: a.participationId,
        nominalAmount: "500",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/liquidación en curso/)
    await expect(
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: a.participationId,
        destinationTableId: t10,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/liquidación en curso/)
    await cancelSettlement(cashier, id, { reason: "El jugador sigue jugando" })
    expect(
      await prisma.playerSettlement.count({ where: { status: "CANCELLED" } })
    ).toBe(1)
    const { purchaseId } = await createPurchase(cashier, {
      participationId: a.participationId,
      nominalAmount: "500",
      idempotencyKey: key(),
    })
    expect(purchaseId).toBeTruthy()
    await expect(draft(a.participationId, "1000")).rejects.toThrow(
      /sin entregar/
    )
  })

  it("cancelación y confirmación simultáneas: el estado final es coherente", async () => {
    const { participationId } = await seat()
    await cashBuy(participationId, "1000")
    const id = await draft(participationId, "1000")
    await sign(id)
    const results = await Promise.allSettled([
      confirm(id),
      cancelSettlement(cashier, id, { reason: "Cancelación concurrente" }),
    ])
    const s = await getSettlement(id)
    expect(
      results.filter((r) => r.status === "fulfilled").length
    ).toBeGreaterThanOrEqual(1)
    if (s.status === "CANCELLED") {
      expect(await returnMoves()).toBe(0)
      expect(await prisma.settlementPayable.count()).toBe(0)
    } else {
      expect(s.status).toBe("PENDING_PAYOUT")
      expect(await returnMoves()).toBe(1)
    }
  })
})

describe("API, permisos y auditoría", () => {
  it("401 sin sesión; 403 con credencial temporal; los tres roles operan", async () => {
    const { participationId } = await seat()
    signOut()
    expect((await call(settlementsRoute.GET)).status).toBe(401)
    signInAs(await createUser({ role: "CASHIER", mustChangePassword: true }))
    expect((await call(settlementsRoute.GET)).status).toBe(403)
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      signInAs(await createUser({ role }))
      expect((await call(settlementsRoute.GET)).status).toBe(200)
    }
    signInAs(cashier._user)
    const created = await call(settlementsRoute.POST, {
      method: "POST",
      path: "/api/settlements",
      body: {
        participationId,
        returnedNominalAmount: "0",
        offsetDecision: "NO_COMPENSATE",
        idempotencyKey: key(),
      },
    })
    expect(created.status).toBe(201)
    const id = (created.json.data as { id: string; version: number }).id
    // Sin firma la API rechaza la recepción (422) y no acepta "firmado = true".
    const noSig = await call(confirmReturnRoute.POST, {
      method: "POST",
      path: `/api/settlements/${id}/confirm-return`,
      params: { id },
      body: { expectedVersion: 1, chipsReceived: true, idempotencyKey: key() },
    })
    expect(noSig.status).toBe(422)
    const forged = await call(confirmReturnRoute.POST, {
      method: "POST",
      path: `/api/settlements/${id}/confirm-return`,
      params: { id },
      body: {
        expectedVersion: 1,
        chipsReceived: true,
        signed: true,
        idempotencyKey: key(),
      },
    })
    expect(forged.status).toBe(400)
    const payout = await call(payoutsRoute.POST, {
      method: "POST",
      path: `/api/settlements/${id}/payouts`,
      params: { id },
      body: {
        method: "CASH",
        amount: "10",
        cashDelivered: true,
        idempotencyKey: key(),
      },
    })
    expect(payout.status).toBe(422)
  })

  it("audita cada paso, sin imágenes ni huellas con la palabra «hash»", async () => {
    const { participationId } = await seat()
    await creditBuy(participationId, "2000")
    const other = await seat(t10)
    await cashBuy(other.participationId, "2000")
    const s = await settle(participationId, "3000", "PARTIAL", "1000", "500")
    await cashPayout(s.id, "1500")
    for (const action of [
      "SETTLEMENT_CREATED",
      "SETTLEMENT_OFFSET_DECIDED",
      "SETTLEMENT_SUMMARY_PREPARED",
      "SETTLEMENT_SIGNATURE_CAPTURED",
      "SETTLEMENT_CHIPS_RECEIVED",
      "SETTLEMENT_DEBT_OFFSET_APPLIED",
      "SETTLEMENT_PAYABLE_CREATED",
      "SETTLEMENT_PAYOUT_REGISTERED",
      "SETTLEMENT_PAYOUT_CONFIRMED",
      "SETTLEMENT_COMPLETED",
      "SETTLEMENT_RECEIPT_CREATED",
      "TABLE_PARTICIPATION_SETTLING",
      "TABLE_PARTICIPATION_SETTLED",
    ])
      expect((await auditRows(action)).length).toBeGreaterThan(0)
    const rows = await prisma.auditLog.findMany({
      where: { action: { startsWith: "SETTLEMENT_" } },
    })
    const text = JSON.stringify(rows.map((r) => r.metadata))
    expect(text).not.toMatch(/"[^"]*hash[^"]*":/i)
    expect(text).not.toMatch(/iVBORw0KGgo/)
    expect(text).not.toMatch(/data:image/)
  })
})
