import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as purchasesRoute from "@/app/api/purchases/route"
import * as paymentsRoute from "@/app/api/purchases/[id]/payments/route"
import * as confirmRoute from "@/app/api/purchases/[id]/confirm-delivery/route"
import * as authRoute from "@/app/api/purchases/[id]/credit-authorization/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  confirmBankTransfer,
  rejectBankTransfer,
} from "@/modules/cash/bank-transfer.service"
import { registerCardSettlement } from "@/modules/cash/card-settlement.service"
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  cancelPayment,
  cancelPurchase,
  confirmDelivery,
  createPurchase,
  getPurchase,
  listPlayerPurchaseDebts,
  listPurchases,
  prepareDelivery,
  recordCreditAuthorization,
  recordPayment,
  requestReversal,
  resolveCardPayment,
  updateDraft,
} from "@/modules/purchases/purchase.service"
import type { PurchaseSignatureVerifier } from "@/modules/purchases/signature-gateway"
import {
  captureSignature,
  getSignatureStatus,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"
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
} from "@/modules/sessions/session.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

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
const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v)

/** Trazos de una firma de prueba (onda + rúbrica), capturados por el flujo real. */
export const TEST_STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

/**
 * Firma REAL del Módulo 09: prepara el reconocimiento en el servidor y
 * captura los trazos (PNG privado + snapshot). Ya no hay verificador falso:
 * la confirmación usa el verificador real.
 */
function testSignatures() {
  return {
    verifier: undefined as PurchaseSignatureVerifier | undefined,
    async sign(purchaseId: string, actor: Actor = cashier) {
      const prepared = await prepareSignatureSummary(actor, purchaseId)
      await captureSignature(actor, purchaseId, {
        snapshotId: prepared.summary.snapshotId,
        payloadHash: prepared.summary.payloadHash,
        strokes: TEST_STROKES,
        idempotencyKey: key(),
      })
      const status = await getSignatureStatus(purchaseId)
      const p = await getPurchase(purchaseId)
      return { version: p.version, signatureId: status.validSignature!.id }
    },
  }
}

let cashier: Actor
let partner: Actor
let sessionId: string
let t25: string
let t10: string

async function openRealSession(actor: Actor) {
  const s = await createSession(actor, { idempotencyKey: key() })
  await prepareSession(actor, s.id)
  const { count } = await createOpeningChipCount(actor, s.id)
  await updateStockCount(actor, count.id, {
    lines: count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity: d.expectedQuantity,
    })),
  })
  await confirmStockCount(actor, count.id, key())
  await confirmOpeningCashCount(actor, s.id, {
    countedAmount: "0",
    physicallyVerified: true,
  })
  await openSession(actor, s.id, { idempotencyKey: key() })
  return s.id
}

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  const d100 = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "100" },
  })
  const d500 = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "500" },
  })
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  // $50,000 en el inventario compartido (200 × $100 + 60 × $500).
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [
      { denominationId: d100.id, quantity: 200 },
      { denominationId: d500.id, quantity: 60 },
    ],
    idempotencyKey: key(),
  })
  sessionId = await openRealSession(cashier)
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

async function seat(tableId: string, playerId?: string) {
  const pid = playerId ?? (await createTestPlayer()).id
  const r = await addPlayerToTable(cashier, sessionId, tableId, {
    playerId: pid,
    idempotencyKey: key(),
  })
  return { playerId: pid, participationId: r.participationId }
}

async function draft(participationId: string, amount: string, actor = cashier) {
  const r = await createPurchase(actor, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  return r.purchaseId
}

const pay = (
  id: string,
  input: Parameters<typeof recordPayment>[2],
  actor = cashier
) => recordPayment(actor, id, input)
const cash = (id: string, amount: string) =>
  pay(id, {
    method: "CASH",
    amount,
    cashReceived: true,
    idempotencyKey: key(),
  })
const card = (
  id: string,
  amount: string,
  method: "CARD_DEBIT" | "CARD_CREDIT" = "CARD_DEBIT",
  result: "APPROVED" | "DECLINED" | "PENDING" = "APPROVED"
) =>
  pay(id, {
    method,
    amount,
    result,
    ...(result === "APPROVED"
      ? { terminalReference: `AUT-${amount}`, approvalConfirmed: true as const }
      : {}),
    idempotencyKey: key(),
  })
const transfer = (id: string, amount: string) =>
  pay(id, {
    method: "BANK_TRANSFER",
    amount,
    bankReference: `REF-${amount}`,
    idempotencyKey: key(),
  })

async function confirm(
  id: string,
  opts: { k?: string; verifier?: PurchaseSignatureVerifier; actor?: Actor } = {}
) {
  const p = await getPurchase(id)
  return confirmDelivery(
    opts.actor ?? cashier,
    id,
    {
      expectedVersion: p.version,
      physicalDeliveryConfirmed: true,
      idempotencyKey: opts.k ?? key(),
    },
    {},
    opts.verifier ? { signatures: opts.verifier } : {}
  )
}

async function nominal() {
  const s = await prisma.chipSetInventoryState.findFirstOrThrow({
    where: { chipSet: { code: "CHIPSET_MAIN" } },
  })
  return {
    custody: D(s.custodyNominal).toFixed(2),
    reserved: D(s.reservedNominal).toFixed(2),
    circulation: D(s.circulationNominal).toFixed(2),
  }
}

async function globalBalance(kind: string) {
  const row = await prisma.financialAccountBalance.findFirst({
    where: { scopeKey: "GLOBAL", account: { kind: kind as "BANK" } },
  })
  return row ? D(row.balance).toFixed(2) : "0.00"
}

const denominationMovements = () =>
  prisma.chipInventoryMovement.count({
    where: { movementType: { in: ["CHIP_DELIVERY", "CHIP_RETURN"] } },
  })

describe("compra por importe pagada en efectivo", () => {
  it("descuenta el valor nominal UNA vez, registra el efectivo en la sesión y no crea movimientos por denominación", async () => {
    const { participationId, playerId } = await seat(t25)
    const id = await draft(participationId, "5000")
    // El borrador no descuenta inventario.
    expect(await nominal()).toMatchObject({
      custody: "50000.00",
      reserved: "0.00",
    })
    await cash(id, "5000")
    const result = await confirm(id)
    expect(result.purchase).toMatchObject({
      status: "CONFIRMED",
      purchaseType: "INITIAL_PURCHASE",
      sequenceNumber: 1,
      rebuyNumber: null,
      signature: { required: false },
    })
    expect(result.purchase.financials).toMatchObject({
      confirmedPayments: "5000.00",
      outstanding: "0.00",
    })
    expect(await nominal()).toEqual({
      custody: "45000.00",
      reserved: "0.00",
      circulation: "5000.00",
    })
    const moves = await prisma.chipNominalMovement.findMany({
      where: { referenceType: "ChipPurchase", referenceId: id },
    })
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ movementType: "CHIP_DELIVERY", playerId })
    expect(await denominationMovements()).toBe(0)
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "5000.00"
    )
    expect(await globalBalance("BANK")).toBe("0.00")
    expect(await prisma.playerDebt.count()).toBe(0)
    expect(await prisma.notificationOutbox.count()).toBe(0)
    // La compra conserva mesa, ciclo y participación.
    const row = await prisma.chipPurchase.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ tableId: t25, participationId })
  })

  it("un reintento con la misma clave devuelve la misma compra sin duplicar fichas ni dinero", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    await cash(id, "3000")
    const k = key()
    const first = await confirm(id, { k })
    const again = await confirm(id, { k })
    expect(again.replayed).toBe(true)
    expect(again.purchase.id).toBe(first.purchase.id)
    expect(
      await prisma.chipNominalMovement.count({
        where: { movementType: "CHIP_DELIVERY" },
      })
    ).toBe(1)
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "PURCHASE_PAYMENT" },
      })
    ).toBe(1)
    // Otra clave sobre una compra ya confirmada no la confirma dos veces.
    await expect(confirm(id)).rejects.toThrow(/ya fue confirmada/)
  })

  it("dos reintentos SIMULTÁNEOS de la misma confirmación producen una sola entrega", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "2000")
    await cash(id, "2000")
    const p = await getPurchase(id)
    const k = key()
    const input = {
      expectedVersion: p.version,
      physicalDeliveryConfirmed: true as const,
      idempotencyKey: k,
    }
    const results = await Promise.allSettled([
      confirmDelivery(cashier, id, input),
      confirmDelivery(cashier, id, input),
    ])
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(await prisma.purchaseDelivery.count()).toBe(1)
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "PURCHASE_PAYMENT" },
      })
    ).toBe(1)
    expect((await nominal()).circulation).toBe("2000.00")
  })
})

describe("inventario nominal compartido", () => {
  it("las compras de ambas mesas consumen el MISMO saldo nominal", async () => {
    const a = await seat(t25)
    const b = await seat(t10)
    const p1 = await draft(a.participationId, "5000")
    await cash(p1, "5000")
    await confirm(p1)
    const p2 = await draft(b.participationId, "3000")
    await cash(p2, "3000")
    await confirm(p2)
    expect(await nominal()).toMatchObject({
      custody: "42000.00",
      circulation: "8000.00",
    })
    const tables = await prisma.chipNominalMovement.findMany({
      where: { movementType: "CHIP_DELIVERY" },
      select: { tableId: true },
    })
    expect(tables.map((t) => t.tableId).sort()).toEqual([t10, t25].sort())
  })

  it("rechaza un importe mayor al disponible y nunca deja el saldo negativo", async () => {
    const { participationId } = await seat(t25)
    await expect(draft(participationId, "50000.01")).rejects.toThrow(
      /insuficiente|disponible/i
    )
    const id = await draft(participationId, "50000")
    await cash(id, "50000")
    await confirm(id)
    expect((await nominal()).custody).toBe("0.00")
    const other = await seat(t10)
    await expect(draft(other.participationId, "1")).rejects.toThrow(
      /insuficiente|disponible/i
    )
  })

  it("dos compras concurrentes de distintas mesas no sobreconsumen el inventario", async () => {
    const a = await seat(t25)
    const b = await seat(t10)
    const p1 = await draft(a.participationId, "30000")
    const p2 = await draft(b.participationId, "30000")
    await cash(p1, "30000")
    await cash(p2, "30000")
    const results = await Promise.allSettled([confirm(p1), confirm(p2)])
    const ok = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(
      /insuficiente|disponible/i
    )
    expect(await nominal()).toMatchObject({
      custody: "20000.00",
      circulation: "30000.00",
      reserved: "0.00",
    })
    // La compra fallida no quedó a medias: sigue en borrador, sin dinero.
    const loser = (await prisma.chipPurchase.findMany()).find(
      (x) => x.status !== "CONFIRMED"
    )!
    expect(loser.status).toBe("DRAFT")
    expect(
      await prisma.cashTransaction.count({
        where: { referenceType: "PurchasePayment" },
      })
    ).toBe(1)
  })

  it("preparar la entrega aparta el importe; cancelar el borrador lo libera", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "4000")
    await prepareDelivery(cashier, id, { idempotencyKey: key() })
    expect(await nominal()).toMatchObject({
      custody: "50000.00",
      reserved: "4000.00",
    })
    const cancelled = await cancelPurchase(cashier, id, {
      reason: "El jugador se arrepintió",
    })
    expect(cancelled.status).toBe("CANCELLED")
    expect(await nominal()).toMatchObject({
      custody: "50000.00",
      reserved: "0.00",
      circulation: "0.00",
    })
    expect(
      await prisma.chipNominalMovement.count({
        where: { movementType: "CHIP_DELIVERY" },
      })
    ).toBe(0)
  })
})

describe("compra inicial y recompras", () => {
  it("numera por sesión y jugador, continúa tras cambiar de mesa y no reasigna compras pasadas", async () => {
    const { participationId, playerId } = await seat(t10)
    const p1 = await draft(participationId, "1000")
    await cash(p1, "1000")
    await confirm(p1)
    const p2 = await draft(participationId, "1000")
    await cash(p2, "1000")
    await confirm(p2)
    // Un borrador cancelado no consume número.
    const cancelled = await draft(participationId, "500")
    await cancelPurchase(cashier, cancelled, { reason: "Error de captura" })

    const moved = await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t25,
      idempotencyKey: key(),
    })
    const p3 = await draft(moved.destinationParticipation.id, "1000")
    await cash(p3, "1000")
    await confirm(p3)

    const rows = await prisma.chipPurchase.findMany({
      where: { playerId, status: "CONFIRMED" },
      orderBy: { sequenceNumber: "asc" },
    })
    expect(rows.map((r) => [r.purchaseType, r.rebuyNumber, r.tableId])).toEqual(
      [
        ["INITIAL_PURCHASE", null, t10],
        ["REBUY", 1, t10],
        ["REBUY", 2, t25],
      ]
    )
    // La compra de 10/10 conserva su participación original (ya TRANSFERRED).
    expect(rows[0].participationId).toBe(participationId)
  })

  it("dos confirmaciones simultáneas del mismo jugador reciben números distintos", async () => {
    const { participationId } = await seat(t25)
    const a = await draft(participationId, "1000")
    const b = await draft(participationId, "1000")
    await cash(a, "1000")
    await cash(b, "1000")
    const results = await Promise.allSettled([confirm(a), confirm(b)])
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    const seqs = (await prisma.chipPurchase.findMany())
      .map((p) => p.sequenceNumber)
      .sort()
    expect(seqs).toEqual([1, 2])
  })

  it("una compra iniciada antes de un cambio de mesa no se confirma contra la participación inactiva", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    await cash(id, "1000")
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    await expect(confirm(id)).rejects.toThrow(/ya no está activo/)
    const row = await prisma.chipPurchase.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: "DRAFT", tableId: t25 })
    expect((await nominal()).circulation).toBe("0.00")
  })

  it("no se compra en una mesa cerrada", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    // Con jugador activo la mesa no se puede cerrar (regla del Módulo 07).
    await expect(
      closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    ).rejects.toThrow()
    expect((await getPurchase(id)).status).toBe("DRAFT")
    const empty = await prisma.tableParticipation.count({
      where: { sessionTable: { tableId: t10 }, status: "ACTIVE" },
    })
    expect(empty).toBe(0)
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const other = await createTestPlayer()
    await expect(
      addPlayerToTable(cashier, sessionId, t10, {
        playerId: other.id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/abierta/)
  })
})

describe("transferencias, crédito, socio autorizador y firma", () => {
  it("una transferencia pendiente no cuenta como cobro ni aumenta el banco, y forma parte del saldo por cobrar", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "5000")
    await cash(id, "1000")
    await card(id, "2000", "CARD_DEBIT")
    const view = (await transfer(id, "1000")).purchase
    expect(view.financials).toMatchObject({
      confirmedPayments: "3000.00",
      pendingTransfers: "1000.00",
      outstanding: "2000.00",
      uncoveredCredit: "1000.00",
    })
    expect(view.blockers.map((b) => b.code)).toEqual([
      "CREDIT_AUTHORIZATION_REQUIRED",
      "CREDIT_SIGNATURE_REQUIRED",
    ])
    expect(await globalBalance("BANK")).toBe("0.00")
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    expect(t).toMatchObject({
      status: "PENDING_VERIFICATION",
      referenceType: "PurchasePayment",
    })
  })

  it("sin firma auténtica una compra con crédito NO se entrega y no deja nada a medias", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "5000")
    await cash(id, "2000")
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await expect(confirm(id)).rejects.toThrow(/firma/)
    expect((await getPurchase(id)).status).toBe("DRAFT")
    expect(await nominal()).toMatchObject({ circulation: "0.00" })
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(await prisma.playerDebt.count()).toBe(0)
    expect(await prisma.notificationOutbox.count()).toBe(0)
  })

  it("con crédito exige socio autorizador antes que firma", async () => {
    const sig = testSignatures()
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    await cash(id, "1000")
    // Sin socio ni siquiera se puede preparar el reconocimiento a firmar.
    await expect(sig.sign(id)).rejects.toThrow(/socio/)
    await expect(confirm(id)).rejects.toThrow(/socio/)
  })

  it("solo socios ACTIVOS (no cajeros ni SUPERADMIN) pueden figurar como autorizadores", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    const other = await actorFor("CASHIER")
    const admin = await actorFor("SUPERADMIN")
    const inactive = await actorFor("PARTNER")
    await prisma.user.update({
      where: { id: inactive.id },
      data: { isActive: false },
    })
    for (const candidate of [other, admin, inactive]) {
      await expect(
        recordCreditAuthorization(cashier, id, {
          partnerId: candidate.id,
          channel: "MESSAGE",
          idempotencyKey: key(),
        })
      ).rejects.toThrow(/socio activo/)
    }
  })

  it("compra a crédito parcial con socio y firma: deuda única, autorización usada, un solo evento de WhatsApp", async () => {
    const sig = testSignatures()
    const { participationId, playerId } = await seat(t25)
    const id = await draft(participationId, "5000")
    await cash(id, "1000")
    await transfer(id, "1000")
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "VERBAL",
      notes: "Autorizó en persona",
      idempotencyKey: key(),
    })
    const { signatureId } = await sig.sign(id)
    const k = key()
    const done = await confirm(id, { verifier: sig.verifier, k })
    expect(done.purchase).toMatchObject({
      status: "CONFIRMED",
      signature: { required: true, present: true, signatureId },
    })
    const debt = await prisma.playerDebt.findFirstOrThrow({
      where: { playerId },
    })
    expect(D(debt.originalAmount).toFixed(2)).toBe("4000.00")
    const auth = await prisma.purchaseCreditAuthorization.findFirstOrThrow({
      where: { purchaseId: id, status: "USED" },
    })
    expect(auth).toMatchObject({
      authorizedByPartnerId: partner.id,
      authorizationChannel: "VERBAL",
      recordedById: cashier.id,
    })
    expect(D(auth.authorizedCreditAmount).toFixed(2)).toBe("4000.00")
    const events = await prisma.notificationOutbox.findMany()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventType: "PURCHASE_CREDIT_CONFIRMED",
      status: "PENDING",
      aggregateId: id,
    })
    expect(JSON.stringify(events[0].payload)).not.toMatch(/\+52/)
    // Reintento: sin otra deuda ni otro evento.
    await confirm(id, { verifier: sig.verifier, k })
    expect(await prisma.playerDebt.count()).toBe(1)
    expect(await prisma.notificationOutbox.count()).toBe(1)
    // El efectivo sí entró; la transferencia pendiente no.
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "1000.00"
    )
    expect(await globalBalance("BANK")).toBe("0.00")
  })

  it("la transferencia verificada después de entregar se aplica UNA vez sobre la misma deuda", async () => {
    const sig = testSignatures()
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    await transfer(id, "3000")
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    await sig.sign(id)
    await confirm(id, { verifier: sig.verifier })
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await globalBalance("BANK")).toBe("3000.00")
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "BANK_TRANSFER_RECEIPT" },
      })
    ).toBe(1)
    const view = await getPurchase(id)
    expect(view.debt).toMatchObject({
      originalAmount: "3000.00",
      currentBalance: "0.00",
    })
    expect(await prisma.playerDebt.count()).toBe(1)
    expect(view.financials.verifiedBankTransfers).toBe("3000.00")
    // Contrato para el Módulo 10: saldo derivado, sin campo editable.
    const debts = await listPlayerPurchaseDebts(view.player.id)
    expect(debts).toHaveLength(1)
    expect(debts[0]).toMatchObject({
      originalAmount: "3000.00",
      currentBalance: "0.00",
      partnerId: partner.id,
      channel: "MESSAGE",
    })
  })

  it("detecta la sobreaplicación de una transferencia y exige tratamiento explícito", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "2000")
    await cash(id, "1000")
    await transfer(id, "1000")
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    await expect(
      confirmBankTransfer(cashier, t.id, {
        verifiedInBank: true,
        confirmedAmount: "1500",
        notes: "El banco muestra más",
      })
    ).rejects.toThrow(/Sobreaplicación/)
    expect(await globalBalance("BANK")).toBe("0.00")
    expect(
      (await prisma.bankTransferVerification.findFirstOrThrow()).status
    ).toBe("PENDING_VERIFICATION")
  })

  it("un cambio material invalida la autorización y la firma anteriores", async () => {
    const sig = testSignatures()
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "5000")
    await cash(id, "1000")
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await sig.sign(id)
    // Nuevo pago: otra versión → la autorización y la firma ya no corresponden.
    await cash(id, "500")
    const view = await getPurchase(id, { verifier: sig.verifier })
    expect(view.creditAuthorization).toBeNull()
    expect(view.authorizationHistory.map((a) => a.status)).toEqual([
      "SUPERSEDED",
    ])
    await expect(confirm(id, { verifier: sig.verifier })).rejects.toThrow(
      /socio/
    )
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await expect(confirm(id, { verifier: sig.verifier })).rejects.toThrow(
      /firma/
    )
    // Un cambio de transferencia verificada en el borrador también cambia la versión.
    await transfer(id, "500")
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    const before = (await getPurchase(id)).version
    await rejectBankTransfer(cashier, t.id, { reason: "No llegó al banco" })
    expect((await getPurchase(id)).version).toBe(before + 1)
  })

  it("crédito total sin límite: toda la compra queda como deuda con socio y firma", async () => {
    const sig = testSignatures()
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "45000")
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    await sig.sign(id)
    await confirm(id, { verifier: sig.verifier })
    expect(
      D((await prisma.playerDebt.findFirstOrThrow()).originalAmount).toFixed(2)
    ).toBe("45000.00")
    expect(await prisma.cashTransaction.count()).toBe(0)
  })

  it("la autorización no es necesaria (ni aceptada) si no hay saldo por cobrar", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    await cash(id, "1000")
    await expect(
      recordCreditAuthorization(cashier, id, {
        partnerId: partner.id,
        channel: "VERBAL",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/no requiere autorización/)
  })
})

describe("terminal bancaria", () => {
  it("una tarjeta aprobada paga la compra sin aumentar el efectivo y queda por liquidar; el depósito no duplica el ingreso", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "2000")
    await card(id, "1200", "CARD_DEBIT")
    await card(id, "800", "CARD_CREDIT")
    const done = await confirm(id)
    expect(done.purchase.financials).toMatchObject({
      approvedCardDebit: "1200.00",
      approvedCardCredit: "800.00",
      confirmedPayments: "2000.00",
      outstanding: "0.00",
    })
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "0.00"
    )
    expect(await globalBalance("CARD_TERMINAL_CLEARING")).toBe("2000.00")
    expect(await globalBalance("BANK")).toBe("0.00")
    const purchasesCredit = await globalBalance("PLAYER_PURCHASES")

    const ids = (
      await prisma.purchasePayment.findMany({ where: { purchaseId: id } })
    ).map((p) => p.id)
    const k = key()
    await registerCardSettlement(cashier, {
      paymentIds: ids,
      depositedAmount: "2000",
      depositVerified: true,
      idempotencyKey: k,
    })
    // Reintento: misma liquidación.
    const again = await registerCardSettlement(cashier, {
      paymentIds: ids,
      depositedAmount: "2000",
      depositVerified: true,
      idempotencyKey: k,
    })
    expect(again.replayed).toBe(true)
    expect(await globalBalance("BANK")).toBe("2000.00")
    expect(await globalBalance("CARD_TERMINAL_CLEARING")).toBe("0.00")
    // La venta no se reconoce otra vez.
    expect(await globalBalance("PLAYER_PURCHASES")).toBe(purchasesCredit)
    await expect(
      registerCardSettlement(cashier, {
        paymentIds: ids,
        depositedAmount: "2000",
        depositVerified: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya fue liquidado/)
  })

  it("un depósito menor (comisión no configurada) deja la diferencia pendiente de conciliar, sin inventar comisiones", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    await card(id, "1000", "CARD_CREDIT")
    await confirm(id)
    const ids = (
      await prisma.purchasePayment.findMany({ where: { purchaseId: id } })
    ).map((p) => p.id)
    await expect(
      registerCardSettlement(cashier, {
        paymentIds: ids,
        depositedAmount: "965",
        depositVerified: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/explica la diferencia/)
    await registerCardSettlement(cashier, {
      paymentIds: ids,
      depositedAmount: "965",
      notes: "Comisión de la terminal",
      depositVerified: true,
      idempotencyKey: key(),
    })
    const s = await prisma.cardTerminalSettlement.findFirstOrThrow()
    expect(s.status).toBe("DIFFERENCE_PENDING")
    expect(D(s.pendingDifference).toFixed(2)).toBe("35.00")
    expect(await globalBalance("CARD_TERMINAL_CLEARING")).toBe("35.00")
    expect(await globalBalance("BANK")).toBe("965.00")
  })

  it("un cobro rechazado no cuenta como pago; uno en proceso bloquea la entrega", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    const declined = (await card(id, "1000", "CARD_DEBIT", "DECLINED")).purchase
    expect(declined.financials.confirmedPayments).toBe("0.00")
    expect(declined.financials.outstanding).toBe("1000.00")
    const pending = (await card(id, "1000", "CARD_DEBIT", "PENDING")).purchase
    expect(pending.blockers.map((b) => b.code)).toContain(
      "PENDING_CARD_PAYMENT"
    )
    await expect(confirm(id)).rejects.toThrow(/terminal en proceso/)
    const paymentId = pending.payments.find((p) => p.status === "PENDING")!.id
    // Rechazado no puede convertirse en aprobado.
    const declinedId = declined.payments[0].id
    await expect(
      resolveCardPayment(cashier, id, declinedId, {
        result: "APPROVED",
        terminalReference: "AUT-1",
        approvalConfirmed: true,
      })
    ).rejects.toThrow(/No se puede pasar/)
    await resolveCardPayment(cashier, id, paymentId, {
      result: "APPROVED",
      terminalReference: "AUT-777",
      approvalConfirmed: true,
    })
    const done = await confirm(id)
    expect(done.purchase.status).toBe("CONFIRMED")
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "PURCHASE_PAYMENT" },
      })
    ).toBe(1)
  })
})

describe("cancelaciones, reversos e inmutabilidad", () => {
  it("no cancela un borrador con efectivo recibido hasta devolverlo; las transferencias pendientes se cancelan", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    const withCash = (await cash(id, "1000")).purchase
    await transfer(id, "1000")
    await expect(
      cancelPurchase(cashier, id, { reason: "Se retira el jugador" })
    ).rejects.toThrow(/cobros reales/)
    await expect(
      cancelPayment(cashier, id, withCash.payments[0].id, {
        reason: "Devuelto",
      })
    ).rejects.toThrow(/devolviste/)
    await cancelPayment(cashier, id, withCash.payments[0].id, {
      reason: "Devuelto en mano",
      cashReturned: true,
    })
    await cancelPurchase(cashier, id, { reason: "Se retira el jugador" })
    expect(
      (await prisma.bankTransferVerification.findFirstOrThrow()).status
    ).toBe("CANCELLED")
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(await prisma.playerDebt.count()).toBe(0)
  })

  it("una transferencia verificada en un borrador impide descartarlo sin resolución financiera", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "3000")
    await transfer(id, "3000")
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    await expect(
      cancelPurchase(cashier, id, { reason: "Cancelación indebida" })
    ).rejects.toThrow(/transferencia verificada/)
    // Ya pagada por completo: se entrega sin firma.
    const done = await confirm(id)
    expect(done.purchase.financials.outstanding).toBe("0.00")
  })

  it("el reverso solo se SOLICITA: no devuelve fichas ni dinero ficticiamente", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    await cash(id, "1000")
    await confirm(id)
    const before = {
      n: await nominal(),
      c: await prisma.cashTransaction.count(),
    }
    const r = await requestReversal(cashier, id, {
      reason: "El cajero entregó a otro jugador",
      idempotencyKey: key(),
    })
    expect(r.purchase.status).toBe("CONFIRMED")
    expect(r.purchase.reversalRequests).toHaveLength(1)
    expect(await nominal()).toEqual(before.n)
    expect(await prisma.cashTransaction.count()).toBe(before.c)
    await expect(
      requestReversal(cashier, id, {
        reason: "Segunda solicitud duplicada",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/abierta/)
  })

  it("la base impide editar compras confirmadas, borrar entregas o firmar en falso", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "1000")
    await cash(id, "1000")
    await confirm(id)
    await expect(
      prisma.chipPurchase.update({
        where: { id },
        data: { nominalAmount: "0.01" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.purchaseDelivery.deleteMany({ where: { purchaseId: id } })
    ).rejects.toThrow()
    await expect(
      prisma.purchasePayment.updateMany({
        where: { purchaseId: id },
        data: { status: "CANCELLED" },
      })
    ).rejects.toThrow()
    // Una entrega con saldo por cobrar sin firma es imposible en la base.
    await expect(
      prisma.$executeRaw`UPDATE "purchase_deliveries" SET "signatureId" = NULL`
    ).rejects.toThrow()
  })

  it("si algo falla a mitad de la confirmación, no queda ninguna salida, asiento ni deuda", async () => {
    // Un verificador defectuoso devuelve la firma de OTRA compra: la base la
    // rechaza al insertar la entrega, DESPUÉS de mover inventario y
    // contabilizar, y toda la transacción se revierte.
    const sig = testSignatures()
    const a = await seat(t25)
    const b = await seat(t10)
    const p1 = await draft(a.participationId, "2000")
    await cash(p1, "1000")
    await recordCreditAuthorization(cashier, p1, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    const { signatureId: foreign } = await sig.sign(p1)
    await confirm(p1)
    const p2 = await draft(b.participationId, "2000")
    await cash(p2, "1000")
    await recordCreditAuthorization(cashier, p2, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    const wrongVerifier: PurchaseSignatureVerifier = {
      available: true,
      async findValidSignature() {
        return { signatureId: foreign }
      },
    }
    const before = {
      n: await nominal(),
      cash: await prisma.cashTransaction.count(),
      debts: await prisma.playerDebt.count(),
    }
    await expect(confirm(p2, { verifier: wrongVerifier })).rejects.toThrow()
    expect(await nominal()).toEqual(before.n)
    expect(await prisma.cashTransaction.count()).toBe(before.cash)
    expect(await prisma.playerDebt.count()).toBe(before.debts)
    expect((await getPurchase(p2)).status).toBe("DRAFT")
  })

  it("un apartado vencido se libera solo y otra compra puede usar ese valor; la entrega lo vuelve a apartar", async () => {
    const a = await seat(t25)
    const b = await seat(t10)
    const p1 = await draft(a.participationId, "40000")
    await prepareDelivery(cashier, p1, { idempotencyKey: key() })
    expect((await nominal()).reserved).toBe("40000.00")
    // Simula que pasaron los 15 minutos del apartado.
    await prisma.chipReservation.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const p2 = await draft(b.participationId, "20000")
    expect((await nominal()).reserved).toBe("0.00")
    await cash(p2, "20000")
    await confirm(p2)
    // p1 ya no cabe: la entrega intenta apartar de nuevo y no hay saldo.
    await cash(p1, "40000")
    await expect(confirm(p1)).rejects.toThrow(/insuficiente|disponible/i)
    expect(await nominal()).toMatchObject({
      custody: "30000.00",
      reserved: "0.00",
      circulation: "20000.00",
    })
  })

  it("cambiar el importe de un borrador preparado libera el apartado anterior", async () => {
    const { participationId } = await seat(t25)
    const id = await draft(participationId, "4000")
    await prepareDelivery(cashier, id, { idempotencyKey: key() })
    const v = (await getPurchase(id)).version
    const updated = await updateDraft(cashier, id, {
      nominalAmount: "2500",
      expectedVersion: v,
    })
    expect(updated).toMatchObject({ status: "DRAFT", nominalAmount: "2500.00" })
    expect((await nominal()).reserved).toBe("0.00")
    await expect(
      updateDraft(cashier, id, { nominalAmount: "1000", expectedVersion: v })
    ).rejects.toThrow(/cambió/)
  })
})

describe("historial, auditoría y API", () => {
  it("filtra el historial y deriva saldos sin mostrar como pagada una compra con transferencia pendiente", async () => {
    const sig = testSignatures()
    const a = await seat(t25)
    const paid = await draft(a.participationId, "1000")
    await cash(paid, "1000")
    await confirm(paid)
    const credit = await draft(a.participationId, "2000")
    await transfer(credit, "2000")
    await recordCreditAuthorization(cashier, credit, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await sig.sign(credit)
    await confirm(credit, { verifier: sig.verifier })
    const all = await listPurchases({ sessionId, page: 1, pageSize: 20 })
    expect(all.total).toBe(2)
    const withCredit = await listPurchases({
      withCredit: true,
      page: 1,
      pageSize: 20,
    })
    expect(withCredit.items.map((i) => i.id)).toEqual([credit])
    expect(withCredit.items[0]).toMatchObject({
      outstanding: "2000.00",
      pendingTransfers: "2000.00",
      partnerName: partner.name,
      purchaseType: "REBUY",
      rebuyNumber: 1,
    })
    const fullyPaid = await listPurchases({
      withCredit: false,
      page: 1,
      pageSize: 20,
    })
    expect(fullyPaid.items.map((i) => i.id)).toEqual([paid])
    const byPartner = await listPurchases({
      partnerId: partner.id,
      page: 1,
      pageSize: 20,
    })
    expect(byPartner.total).toBe(1)
    const byMethod = await listPurchases({
      method: "BANK_TRANSFER",
      page: 1,
      pageSize: 20,
    })
    expect(byMethod.total).toBe(1)
    const actions = (await auditRows()).map((r) => r.action)
    for (const action of [
      "PURCHASE_DRAFT_CREATED",
      "PURCHASE_PAYMENT_RECORDED",
      "PURCHASE_CREDIT_AUTH_RECORDED",
      "PURCHASE_CONFIRMED",
      "RECEIVABLE_CREATED",
      "PURCHASE_CREDIT_EVENT_QUEUED",
    ])
      expect(actions).toContain(action)
    const authAudit = (await auditRows("PURCHASE_CREDIT_AUTH_RECORDED"))[0]
    expect(authAudit.metadata).toMatchObject({
      partnerId: partner.id,
      channel: "VERBAL",
    })
  })

  it("la API exige sesión, permiso y entradas estrictas (sin denominaciones ni datos del servidor)", async () => {
    const { participationId } = await seat(t25)
    signOut()
    const anon = await call(purchasesRoute.POST, {
      method: "POST",
      body: {
        participationId,
        nominalAmount: "1000",
        idempotencyKey: key(),
      },
    })
    expect(anon.status).toBe(401)
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      const actor = await actorFor(role)
      signInAs(actor._user)
      const res = await call(purchasesRoute.POST, {
        method: "POST",
        body: {
          participationId,
          nominalAmount: "1000",
          idempotencyKey: key(),
        },
      })
      expect(res.status).toBe(201)
    }
    signInAs(cashier._user)
    for (const extra of [
      { denominations: [{ value: "100", quantity: 10 }] },
      { chips: 10 },
      { folio: "CMP-1" },
      { status: "CONFIRMED" },
      { createdById: partner.id },
    ]) {
      const res = await call(purchasesRoute.POST, {
        method: "POST",
        body: {
          participationId,
          nominalAmount: "1000",
          idempotencyKey: key(),
          ...extra,
        },
      })
      expect(res.status).toBe(400)
    }
    const created = await call(purchasesRoute.POST, {
      method: "POST",
      body: { participationId, nominalAmount: "1000", idempotencyKey: key() },
    })
    const id = (created.json.data as { id: string }).id
    // Nunca datos de tarjeta; una aprobación exige folio y confirmación explícita.
    for (const body of [
      {
        method: "CARD_DEBIT",
        amount: "500",
        result: "APPROVED",
        terminalReference: "4111 1111 1111 1111",
        approvalConfirmed: true,
        idempotencyKey: key(),
      },
      {
        method: "CARD_CREDIT",
        amount: "500",
        result: "APPROVED",
        terminalReference: "AUT-1",
        idempotencyKey: key(),
      },
      {
        method: "CARD_DEBIT",
        amount: "500",
        result: "APPROVED",
        terminalReference: "AUT-1",
        approvalConfirmed: true,
        cvv: "123",
        idempotencyKey: key(),
      },
      { method: "CASH", amount: "500", idempotencyKey: key() },
      { method: "CREDIT", amount: "500", idempotencyKey: key() },
    ]) {
      const res = await call(paymentsRoute.POST, {
        method: "POST",
        params: { id },
        body,
      })
      expect(res.status).toBe(400)
    }
    // El importe autorizado no lo envía el cliente.
    const auth = await call(authRoute.POST, {
      method: "POST",
      params: { id },
      body: {
        partnerId: partner.id,
        channel: "VERBAL",
        authorizedCreditAmount: "1",
        idempotencyKey: key(),
      },
    })
    expect(auth.status).toBe(400)
    const noChannel = await call(authRoute.POST, {
      method: "POST",
      params: { id },
      body: { partnerId: partner.id, idempotencyKey: key() },
    })
    expect(noChannel.status).toBe(400)
    // Sin confirmación explícita de entrega física: 400.
    const noPhysical = await call(confirmRoute.POST, {
      method: "POST",
      params: { id },
      body: { expectedVersion: 1, idempotencyKey: key() },
    })
    expect(noPhysical.status).toBe(400)
  })
})
