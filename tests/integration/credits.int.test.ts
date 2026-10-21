import { randomUUID } from "node:crypto"

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as paymentsRoute from "@/app/api/credits/payments/route"
import * as receiptImageRoute from "@/app/api/credits/payments/[id]/receipt/image/route"
import * as summaryRoute from "@/app/api/credits/summary/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  confirmBankTransfer,
  rejectBankTransfer,
} from "@/modules/cash/bank-transfer.service"
import { registerCardSettlement } from "@/modules/cash/card-settlement.service"
import { cashBalanceOf } from "@/modules/cash/ledger"
import { getCreditReceipt } from "@/modules/credits/credit-receipt.service"
import {
  depositCustody,
  getCustodySummary,
} from "@/modules/credits/custody.service"
import {
  fifoPreview,
  getPayment,
  registerPayment,
  reversePayment,
} from "@/modules/credits/receivable-payment.service"
import {
  applyChipSettlementOffsetInTx,
  getPlayerCreditSummary,
  getPlayerStatement,
  listPlayersWithDebt,
  receivablesOf,
} from "@/modules/credits/receivable.service"
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
import { createSettlement } from "@/modules/settlements/settlement.service"
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

async function seat(tableId = t25, playerId?: string) {
  const pid = playerId ?? (await createTestPlayer()).id
  const r = await addPlayerToTable(cashier, sessionId, tableId, {
    playerId: pid,
    idempotencyKey: key(),
  })
  return { playerId: pid, participationId: r.participationId }
}

/** Deuda REAL: compra con crédito, socio, firma y entrega confirmada. */
async function creditDebt(
  participationId: string,
  amount: string,
  opts: { cash?: string; transfer?: string } = {}
) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  if (opts.cash)
    await recordPayment(cashier, purchaseId, {
      method: "CASH",
      amount: opts.cash,
      cashReceived: true,
      idempotencyKey: key(),
    })
  if (opts.transfer)
    await recordPayment(cashier, purchaseId, {
      method: "BANK_TRANSFER",
      amount: opts.transfer,
      bankReference: `REF-${opts.transfer}`,
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

const pay = (
  playerId: string,
  amount: string,
  extra: Record<string, unknown> = {},
  actor: Actor = cashier
) =>
  registerPayment(actor, {
    playerId,
    amount,
    origin: "SESSION",
    method: "CASH",
    cashReceived: true,
    idempotencyKey: key(),
    ...extra,
  } as Parameters<typeof registerPayment>[1])

async function balances(playerId: string) {
  return (await receivablesOf(prisma, playerId)).map((r) =>
    r.balance.toFixed(2)
  )
}
async function globalBalance(kind: string, scopeKey = "GLOBAL") {
  const row = await prisma.financialAccountBalance.findFirst({
    where: { scopeKey, account: { kind: kind as "BANK" } },
  })
  return row ? D(row.balance).toFixed(2) : "0.00"
}
async function nominalCirculation() {
  return D(
    (await prisma.chipSetInventoryState.findFirstOrThrow()).circulationNominal
  ).toFixed(2)
}

describe("origen de las deudas", () => {
  it("una compra con crédito confirmada crea UNA sola deuda; la transferencia pendiente no crea otra", async () => {
    const { playerId, participationId } = await seat()
    const purchaseId = await creditDebt(participationId, "5000", {
      cash: "1000",
      transfer: "1000",
    })
    const debts = await prisma.playerDebt.findMany({ where: { playerId } })
    expect(debts).toHaveLength(1)
    expect(D(debts[0].originalAmount).toFixed(2)).toBe("4000.00")
    expect(debts[0].purchaseId).toBe(purchaseId)
    const summary = await getPlayerCreditSummary(playerId, { showPhone: false })
    expect(summary).toMatchObject({ outstanding: "4000.00", openCount: 1 })
    expect(summary.receivables[0]).toMatchObject({
      status: "OPEN",
      partner: { name: partner.name, channel: "VERBAL" },
      origin: {
        purchaseFolio: expect.stringMatching(/^CMP-/),
        table: { id: t25 },
      },
    })
    expect(summary.receivables[0].signatureId).toBeTruthy()
    expect((await auditRows("RECEIVABLE_CREATED")).length).toBe(1)
  })

  it("la deuda conserva su sesión y mesa de origen aunque el jugador cambie de mesa y la sesión cierre", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "2000")
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    await closeSessionForTest(sessionId)
    const summary = await getPlayerCreditSummary(playerId, { showPhone: false })
    expect(summary.outstanding).toBe("2000.00")
    expect(summary.receivables[0].origin).toMatchObject({
      table: { id: t25 },
      session: { id: sessionId },
    })
  })
})

describe("abonos y FIFO", () => {
  it("FIFO con tres deudas: $2,500 cubre A y parte de B; C intacta", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await creditDebt(participationId, "2000")
    await creditDebt(participationId, "3000")
    const preview = await fifoPreview(playerId, "2500")
    expect(
      preview.valid &&
        preview.allocations.map((a) => [a.amount, a.balanceAfter])
    ).toEqual([
      ["1000.00", "0.00"],
      ["1500.00", "500.00"],
    ])
    const before = {
      cash: (await cashBalanceOf(prisma, sessionId)).balance.toFixed(2),
      circ: await nominalCirculation(),
    }
    const { paymentId } = await pay(playerId, "2500")
    expect(await balances(playerId)).toEqual(["0.00", "500.00", "3000.00"])
    const view = await getPayment(paymentId)
    expect(view).toMatchObject({
      status: "CONFIRMED",
      applied: "2500.00",
      origin: "SESSION",
      session: { id: sessionId },
    })
    expect(view.allocations.map((a) => a.allocationOrder)).toEqual([1, 2])
    // Efectivo a la caja de la sesión OPEN; sin compras ni movimientos de fichas.
    expect(
      D((await cashBalanceOf(prisma, sessionId)).balance)
        .sub(D(before.cash))
        .toFixed(2)
    ).toBe("2500.00")
    expect(await nominalCirculation()).toBe(before.circ)
    expect(await prisma.chipPurchase.count()).toBe(3)
    const summary = await getPlayerCreditSummary(playerId, { showPhone: false })
    expect(summary.receivables.map((r) => r.status)).toEqual([
      "PAID",
      "PARTIALLY_PAID",
      "OPEN",
    ])
    expect(summary.outstanding).toBe("3500.00")
  })

  it("pago total, rechazo de excedentes y de importes inválidos; nunca saldo a favor", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "2000")
    await expect(pay(playerId, "2500")).rejects.toThrow(
      "El importe supera la deuda pendiente de $2000.00."
    )
    await pay(playerId, "2000")
    expect(await balances(playerId)).toEqual(["0.00"])
    await expect(pay(playerId, "1")).rejects.toThrow(/no tiene deuda pendiente/)
    signInAs(cashier._user)
    for (const amount of ["0", "-5", "1.234"]) {
      const res = await call(paymentsRoute.POST, {
        method: "POST",
        body: {
          playerId,
          amount,
          origin: "SESSION",
          method: "CASH",
          cashReceived: true,
          idempotencyKey: key(),
        },
      })
      expect(res.status).toBe(400)
    }
    // El cliente no puede enviar la distribución FIFO ni la sesión.
    const res = await call(paymentsRoute.POST, {
      method: "POST",
      body: {
        playerId,
        amount: "1",
        origin: "SESSION",
        method: "CASH",
        cashReceived: true,
        sessionId,
        allocations: [],
        idempotencyKey: key(),
      },
    })
    expect(res.status).toBe(400)
  })

  it("un pago inmediato de compra no se redistribuye por FIFO ni cuenta como abono", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await creditDebt(participationId, "5000", { cash: "3000" })
    expect(await balances(playerId)).toEqual(["1000.00", "2000.00"])
    expect(await prisma.receivablePayment.count()).toBe(0)
    expect(await prisma.paymentAllocation.count()).toBe(0)
  })

  it("reintentos y concurrencia: misma clave = mismo abono; dos abonos simultáneos no sobrepagan", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    const k = key()
    const input = {
      playerId,
      amount: "400",
      origin: "SESSION" as const,
      method: "CASH" as const,
      cashReceived: true as const,
      idempotencyKey: k,
    }
    const [a, b] = await Promise.all([
      registerPayment(cashier, input),
      registerPayment(cashier, input),
    ])
    expect(a.paymentId).toBe(b.paymentId)
    expect(await prisma.paymentAllocation.count()).toBe(1)
    const results = await Promise.allSettled([
      pay(playerId, "600"),
      pay(playerId, "600"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await balances(playerId)).toEqual(["0.00"])
  })

  it("un abono y una compensación con fichas (Módulo 11) simultáneos no sobreaplican la deuda", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    const cashBefore = (await cashBalanceOf(prisma, sessionId)).balance.toFixed(
      2
    )
    // Liquidación REAL en borrador (Módulo 11) como origen de la compensación.
    const { settlementId } = await createSettlement(cashier, {
      participationId,
      returnedNominalAmount: "1000",
      offsetDecision: "PARTIAL",
      offsetAmount: "700",
      idempotencyKey: key(),
    })
    const offset = prisma.$transaction((tx) =>
      applyChipSettlementOffsetInTx(tx, cashier.id, {
        playerId,
        settlementId,
        amount: D("700"),
      })
    )
    const results = await Promise.allSettled([offset, pay(playerId, "700")])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await balances(playerId)).toEqual(["300.00"])
    const offsetWon = results[0].status === "fulfilled"
    // La compensación no mueve dinero.
    if (offsetWon)
      expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
        cashBefore
      )
  })
})

describe("transferencias y terminal", () => {
  it("transferencia pendiente no reduce deuda ni aumenta el banco; verificada se aplica una vez", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "3000")
    const { paymentId } = await registerPayment(cashier, {
      playerId,
      amount: "1000",
      origin: "ADMINISTRATIVE",
      method: "BANK_TRANSFER",
      bankReference: "SPEI-1",
      idempotencyKey: key(),
    })
    expect((await getPayment(paymentId)).status).toBe("PENDING")
    expect(await balances(playerId)).toEqual(["3000.00"])
    expect(await globalBalance("BANK")).toBe("0.00")
    await expect(getCreditReceipt(paymentId)).rejects.toThrow(/verifique/)
    const t = (await getPayment(paymentId)).bankTransfer!
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await globalBalance("BANK")).toBe("1000.00")
    expect(await balances(playerId)).toEqual(["2000.00"])
    expect((await getPayment(paymentId)).status).toBe("CONFIRMED")
    expect((await getCreditReceipt(paymentId)).content).toMatchObject({
      amount: "1000.00",
      applied: "1000.00",
      remainingOutstanding: "2000.00",
    })
  })

  it("transferencia que llega cuando la deuda ya estaba cubierta: se recibe pero no se aplica (fondos por devolver)", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    const { paymentId } = await registerPayment(cashier, {
      playerId,
      amount: "1000",
      origin: "ADMINISTRATIVE",
      method: "BANK_TRANSFER",
      idempotencyKey: key(),
    })
    await pay(playerId, "700")
    const t = (await getPayment(paymentId)).bankTransfer!
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await balances(playerId)).toEqual(["0.00"])
    const view = await getPayment(paymentId)
    expect(view).toMatchObject({ applied: "300.00", unapplied: "700.00" })
    expect(await globalBalance("BANK")).toBe("1000.00")
    expect(await globalBalance("UNAPPLIED_PLAYER_FUNDS")).toBe("-700.00")
    const summary = await getPlayerCreditSummary(playerId, { showPhone: false })
    expect(summary).toMatchObject({
      outstanding: "0.00",
      unappliedFunds: "700.00",
    })
  })

  it("una transferencia de COMPRA verificada después de entregar se aplica a SU deuda, no por FIFO", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await creditDebt(participationId, "3000", { transfer: "2000" })
    expect(await balances(playerId)).toEqual(["1000.00", "3000.00"])
    const t = await prisma.bankTransferVerification.findFirstOrThrow({
      where: { referenceType: "PurchasePayment" },
    })
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await balances(playerId)).toEqual(["1000.00", "1000.00"])
    const alloc = await prisma.paymentAllocation.findFirstOrThrow()
    expect(alloc.source).toBe("PURCHASE_PAYMENT")
    expect(await prisma.receivablePayment.count()).toBe(0)
  })

  it("transferencia rechazada: abono REJECTED y la deuda no cambia", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    const { paymentId } = await registerPayment(cashier, {
      playerId,
      amount: "500",
      origin: "SESSION",
      method: "BANK_TRANSFER",
      idempotencyKey: key(),
    })
    await rejectBankTransfer(
      cashier,
      (await getPayment(paymentId)).bankTransfer!.id,
      { reason: "No llegó al banco" }
    )
    expect((await getPayment(paymentId)).status).toBe("REJECTED")
    expect(await balances(playerId)).toEqual(["1000.00"])
  })

  it("terminal aprobada reduce deuda sin aumentar efectivo; la liquidación no duplica; rechazada no cuenta", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "2000")
    const cashBefore = (await cashBalanceOf(prisma, sessionId)).balance.toFixed(
      2
    )
    const declined = await registerPayment(cashier, {
      playerId,
      amount: "500",
      origin: "SESSION",
      method: "CARD_DEBIT",
      result: "DECLINED",
      idempotencyKey: key(),
    })
    expect((await getPayment(declined.paymentId)).status).toBe("REJECTED")
    expect(await balances(playerId)).toEqual(["2000.00"])
    const ok = await registerPayment(cashier, {
      playerId,
      amount: "800",
      origin: "SESSION",
      method: "CARD_CREDIT",
      result: "APPROVED",
      terminalReference: "AUT-9",
      approvalConfirmed: true,
      idempotencyKey: key(),
    })
    expect(await balances(playerId)).toEqual(["1200.00"])
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      cashBefore
    )
    expect(await globalBalance("CARD_TERMINAL_CLEARING")).toBe("800.00")
    const debtPaymentsBefore = await globalBalance("PLAYER_DEBT_PAYMENTS")
    await registerCardSettlement(cashier, {
      paymentIds: [ok.paymentId],
      depositedAmount: "800",
      depositVerified: true,
      idempotencyKey: key(),
    })
    expect(await globalBalance("BANK")).toBe("800.00")
    expect(await globalBalance("CARD_TERMINAL_CLEARING")).toBe("0.00")
    expect(await globalBalance("PLAYER_DEBT_PAYMENTS")).toBe(debtPaymentsBefore)
    expect(await balances(playerId)).toEqual(["1200.00"])
    await expect(
      registerCardSettlement(cashier, {
        paymentIds: [ok.paymentId],
        depositedAmount: "800",
        depositVerified: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya fue liquidado/)
  })
})

describe("abonos administrativos y custodia", () => {
  it("fuera de sesión: no toca la caja cerrada; el efectivo queda en custodia y su depósito no duplica ingresos", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "3000")
    await closeSessionForTest(sessionId)
    const closedCash = (await cashBalanceOf(prisma, sessionId)).balance.toFixed(
      2
    )
    // Sin sesión abierta no hay abonos "de sesión".
    await expect(pay(playerId, "100")).rejects.toThrow(/administrativo/)
    const cash = await registerPayment(cashier, {
      playerId,
      amount: "1500",
      origin: "ADMINISTRATIVE",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    expect(await getPayment(cash.paymentId)).toMatchObject({
      origin: "ADMINISTRATIVE",
      session: null,
      status: "CONFIRMED",
    })
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      closedCash
    )
    expect(await balances(playerId)).toEqual(["1500.00"])
    const custody = await getCustodySummary()
    expect(custody.total).toBe("1500.00")
    expect(custody.custodians[0]).toMatchObject({
      custodian: { id: cashier.id },
      balance: "1500.00",
    })
    // Transferencia administrativa verificada: banco +1 vez.
    const tr = await registerPayment(cashier, {
      playerId,
      amount: "500",
      origin: "ADMINISTRATIVE",
      method: "BANK_TRANSFER",
      idempotencyKey: key(),
    })
    await confirmBankTransfer(
      cashier,
      (await getPayment(tr.paymentId)).bankTransfer!.id,
      { verifiedInBank: true }
    )
    expect(await globalBalance("BANK")).toBe("500.00")
    // Depósito de la custodia: custodia − / banco + (no es un abono nuevo).
    const debtPaymentsBefore = await globalBalance("PLAYER_DEBT_PAYMENTS")
    const k = key()
    await depositCustody(cashier, {
      custodianUserId: cashier.id,
      amount: "1000",
      depositVerified: true,
      idempotencyKey: k,
    })
    await depositCustody(cashier, {
      custodianUserId: cashier.id,
      amount: "1000",
      depositVerified: true,
      idempotencyKey: k,
    })
    expect((await getCustodySummary()).total).toBe("500.00")
    expect(await globalBalance("BANK")).toBe("1500.00")
    expect(await globalBalance("PLAYER_DEBT_PAYMENTS")).toBe(debtPaymentsBefore)
    expect(await balances(playerId)).toEqual(["1000.00"])
    // No se deposita más de lo que hay en custodia.
    await expect(
      depositCustody(cashier, {
        custodianUserId: cashier.id,
        amount: "600",
        depositVerified: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/insuficientes/i)
  })

  it("la custodia no se convierte en fondo de la siguiente sesión: la caja nueva abre en $0", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await closeSessionForTest(sessionId)
    await registerPayment(cashier, {
      playerId,
      amount: "400",
      origin: "ADMINISTRATIVE",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await prisma.$executeRawUnsafe(
      `UPDATE "chip_set_inventory_states" SET "custodyNominal" = "custodyNominal" + "circulationNominal", "circulationNominal" = 0`
    )
    const next = await openRealSession()
    expect((await cashBalanceOf(prisma, next)).balance.toFixed(2)).toBe("0.00")
    expect((await getCustodySummary()).total).toBe("400.00")
  })

  it("dos depósitos simultáneos de la misma custodia no la dejan negativa", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await registerPayment(cashier, {
      playerId,
      amount: "600",
      origin: "ADMINISTRATIVE",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    const results = await Promise.allSettled([
      depositCustody(cashier, {
        custodianUserId: cashier.id,
        amount: "500",
        depositVerified: true,
        idempotencyKey: key(),
      }),
      depositCustody(cashier, {
        custodianUserId: cashier.id,
        amount: "500",
        depositVerified: true,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect((await getCustodySummary()).total).toBe("100.00")
  })
})

describe("reversos, comprobantes y seguridad", () => {
  it("reverso: contraasientos de dinero y aplicaciones, sin borrar nada, y comprobante ANULADO", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await creditDebt(participationId, "1000")
    const first = await pay(playerId, "1500")
    const second = await pay(playerId, "300")
    expect(await balances(playerId)).toEqual(["0.00", "200.00"])
    const cashBefore = (await cashBalanceOf(prisma, sessionId)).balance
    const k = key()
    await reversePayment(cashier, first.paymentId, {
      reason: "Se registró a otro jugador por error",
      idempotencyKey: k,
    })
    await reversePayment(cashier, first.paymentId, {
      reason: "Se registró a otro jugador por error",
      idempotencyKey: k,
    })
    // Se restaura exactamente lo que aplicó el primer abono; el segundo queda igual.
    expect(await balances(playerId)).toEqual(["1000.00", "700.00"])
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      cashBefore.sub(1500).toFixed(2)
    )
    expect((await getPayment(first.paymentId)).status).toBe("REVERSED")
    expect((await getPayment(second.paymentId)).status).toBe("CONFIRMED")
    const receipt = await getCreditReceipt(first.paymentId)
    expect(receipt).toMatchObject({ status: "VOIDED", intact: true })
    // 3 aplicaciones (2 del primero, 1 del segundo) + 2 contraasientos.
    expect(await prisma.paymentAllocation.count()).toBe(5)
  })

  it("comprobante histórico inmutable y PNG descargable", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "2000")
    const a = await pay(playerId, "500")
    const before = await getCreditReceipt(a.paymentId)
    await pay(playerId, "500")
    const after = await getCreditReceipt(a.paymentId)
    expect(after.contentHash).toBe(before.contentHash)
    expect(after.content.remainingOutstanding).toBe("1500.00")
    signInAs(cashier._user)
    const res = await receiptImageRoute.GET(
      new NextRequest(
        `http://localhost:3000/api/credits/payments/${a.paymentId}/receipt/image`,
        { headers: { host: "localhost:3000" } }
      ),
      { params: Promise.resolve({ id: a.paymentId }) }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-disposition")).toMatch(/abono-.*\.png/)
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(1, 4)
        .toString()
    ).toBe("PNG")
    await expect(
      prisma.receivablePaymentReceipt.updateMany({ data: { contentHash: "x" } })
    ).rejects.toThrow()
    await expect(prisma.paymentAllocation.deleteMany()).rejects.toThrow()
    await expect(
      prisma.receivablePayment.updateMany({ data: { amount: "1" } })
    ).rejects.toThrow()
  })

  it("la base impide aplicar más que la deuda o que el abono (aun saltándose el servicio)", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "500")
    const debt = await prisma.playerDebt.findFirstOrThrow()
    await expect(
      prisma.paymentAllocation.create({
        data: {
          receivableId: debt.id,
          playerId,
          source: "CHIP_SETTLEMENT_OFFSET",
          settlementId: "x",
          amount: "600",
          allocationOrder: 1,
          createdById: cashier.id,
        },
      })
    ).rejects.toThrow()
    expect(await balances(playerId)).toEqual(["500.00"])
  })

  it("estado de cuenta cronológico, tablero, permisos y auditoría", async () => {
    const { playerId, participationId } = await seat()
    await creditDebt(participationId, "1000")
    await pay(playerId, "400")
    await registerPayment(cashier, {
      playerId,
      amount: "100",
      origin: "SESSION",
      method: "BANK_TRANSFER",
      idempotencyKey: key(),
    })
    const st = await getPlayerStatement(playerId)
    expect(st.lines.map((l) => [l.kind, l.balance])).toEqual([
      ["CREDIT", "1000.00"],
      ["PAYMENT", "600.00"],
    ])
    expect(st.pending).toHaveLength(1)
    expect((await listPlayersWithDebt())[0]).toMatchObject({
      outstanding: "600.00",
      openCount: 1,
    })
    signOut()
    expect((await call(summaryRoute.GET)).status).toBe(401)
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      const a = await actorFor(role)
      signInAs(a._user)
      expect((await call(summaryRoute.GET)).status).toBe(200)
      const res = await call(paymentsRoute.POST, {
        method: "POST",
        body: {
          playerId,
          amount: "10",
          origin: "SESSION",
          method: "CASH",
          cashReceived: true,
          idempotencyKey: key(),
        },
      })
      expect(res.status).toBe(201)
    }
    const actions = (await auditRows()).map((r) => r.action)
    for (const a of [
      "PAYMENT_REGISTERED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_ALLOCATED",
      "RECEIVABLE_PARTIALLY_PAID",
      "RECEIPT_CREATED",
    ])
      expect(actions).toContain(a)
    // Ni inventarios ni cajas por mesa.
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
    expect(await prisma.cashBox.count()).toBe(1)
  })
})
