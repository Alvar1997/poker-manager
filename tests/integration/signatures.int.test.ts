import { randomUUID } from "node:crypto"

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as evidenceRoute from "@/app/api/purchases/[id]/signature-evidence/route"
import * as receiptImageRoute from "@/app/api/purchases/[id]/receipt/image/route"
import * as receiptRoute from "@/app/api/purchases/[id]/receipt/route"
import * as signaturesRoute from "@/app/api/purchases/[id]/signatures/route"
import * as summaryRoute from "@/app/api/purchases/[id]/signature-summary/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  cancelPurchase,
  confirmDelivery,
  createPurchase,
  getPurchase,
  recordCreditAuthorization,
  recordPayment,
  requestReversal,
  updateDraft,
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
} from "@/modules/sessions/session.service"
import { cleanupOrphanedFiles } from "@/modules/signatures/evidence-storage"
import {
  getReceipt,
  voidReceiptInTx,
} from "@/modules/signatures/receipt.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"
import { inspectSignaturePng } from "@/modules/signatures/signature.strokes"

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
const D = (v: Prisma.Decimal | string) => new Prisma.Decimal(v)

/** Trazos de prueba (onda + rúbrica), como los que genera un dedo. */
const STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

/** Llama a un handler que responde binario (PNG) sin parsear JSON. */
async function raw(
  handler: (
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> }
  ) => Promise<Response>,
  id: string,
  query = ""
) {
  return handler(
    new NextRequest(`http://localhost:3000/api/purchases/${id}/x${query}`, {
      headers: { host: "localhost:3000" },
    }),
    { params: Promise.resolve({ id }) }
  )
}

let cashier: Actor
let partner: Actor
let partner2: Actor
let sessionId: string
let t25: string

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
  partner2 = await actorFor("PARTNER")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId: d.id, quantity: 100 }],
    idempotencyKey: key(),
  })
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
  sessionId = s.id
  t25 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
  ).id
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
})

async function seat() {
  const player = await createTestPlayer()
  const r = await addPlayerToTable(cashier, sessionId, t25, {
    playerId: player.id,
    idempotencyKey: key(),
  })
  return { playerId: player.id, participationId: r.participationId }
}

/** Compra con crédito: importe, efectivo parcial y socio autorizador. */
async function creditPurchase(
  participationId: string,
  amount = "5000",
  cash = "1000",
  partnerId = partner.id
) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  if (cash !== "0")
    await recordPayment(cashier, purchaseId, {
      method: "CASH",
      amount: cash,
      cashReceived: true,
      idempotencyKey: key(),
    })
  await recordCreditAuthorization(cashier, purchaseId, {
    partnerId,
    channel: "VERBAL",
    idempotencyKey: key(),
  })
  return purchaseId
}

async function sign(purchaseId: string, actor: Actor = cashier, k = key()) {
  const prepared = await prepareSignatureSummary(actor, purchaseId)
  await captureSignature(actor, purchaseId, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: k,
  })
  return prepared.summary
}

async function deliver(purchaseId: string, k = key()) {
  const p = await getPurchase(purchaseId)
  return confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: k,
  })
}

async function effects() {
  const state = await prisma.chipSetInventoryState.findFirstOrThrow()
  return {
    circulation: D(state.circulationNominal).toFixed(2),
    reserved: D(state.reservedNominal).toFixed(2),
    deliveries: await prisma.chipNominalMovement.count({
      where: { movementType: "CHIP_DELIVERY" },
    }),
    debts: await prisma.playerDebt.count(),
    cashTx: await prisma.cashTransaction.count(),
    receipts: await prisma.purchaseReceipt.count(),
  }
}

describe("firma de reconocimiento de crédito", () => {
  it("prepara el resumen en el servidor, captura la firma real en almacenamiento privado y NO entrega nada", async () => {
    const { participationId, playerId } = await seat()
    const id = await creditPurchase(participationId)
    const summary = await sign(id)
    expect(summary).toMatchObject({
      playerId,
      nominalAmount: "5000.00",
      confirmedPaymentsAmount: "1000.00",
      pendingTransferAmount: "0.00",
      outstandingCreditAmount: "4000.00",
      partnerName: partner.name,
      authorizationChannel: "VERBAL",
      purchaseType: "INITIAL_PURCHASE",
      declarationVersion: "2026-10-v1",
    })
    expect(summary.declarationText).toMatch(/^Reconozco haber solicitado/)
    const sig = await prisma.purchaseSignature.findFirstOrThrow({
      include: { file: true },
    })
    expect(sig).toMatchObject({ status: "VALID", playerId, purchaseId: id })
    expect(sig.file).toMatchObject({
      status: "ACTIVE",
      mimeType: "image/png",
      purchaseId: id,
    })
    expect(sig.file.storageKey).toMatch(/^evidence\/[0-9a-f-]{36}$/)
    const blob = await prisma.evidenceBlob.findUniqueOrThrow({
      where: { storageKey: sig.file.storageKey },
    })
    const png = Buffer.from(blob.bytes)
    expect(inspectSignaturePng(png).ink).toBeGreaterThan(150)
    // Firmar no mueve fichas, dinero ni crea deuda (FIR-16).
    expect(await effects()).toMatchObject({
      circulation: "0.00",
      deliveries: 0,
      debts: 0,
      cashTx: 0,
      receipts: 0,
    })
    expect((await getPurchase(id)).status).toBe("DRAFT")
  })

  it("el cajero confirma DESPUÉS: una sola salida, una sola deuda, pagos y comprobante con firma", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    const k = key()
    await deliver(id, k)
    await deliver(id, k) // reintento
    const after = await effects()
    expect(after).toMatchObject({
      circulation: "5000.00",
      deliveries: 1,
      debts: 1,
      cashTx: 1,
      receipts: 1,
    })
    const delivery = await prisma.purchaseDelivery.findUniqueOrThrow({
      where: { purchaseId: id },
    })
    const sig = await prisma.purchaseSignature.findFirstOrThrow()
    expect(delivery.signatureId).toBe(sig.id)
    const receipt = await getReceipt(id, cashier)
    expect(receipt).toMatchObject({
      status: "AVAILABLE",
      intact: true,
      hasSignature: true,
    })
    expect(receipt.content).toMatchObject({
      nominalAmount: "5000.00",
      confirmedPayments: "1000.00",
      initialCredit: "4000.00",
      purchaseLabel: "Compra inicial",
      partner: { name: partner.name, channel: "VERBAL" },
    })
    expect(JSON.stringify(receipt.content)).not.toMatch(/denomination|\+52/i)
    // No se duplica el comprobante.
    await getReceipt(id, cashier)
    expect(await prisma.purchaseReceipt.count()).toBe(1)
  })

  it("una compra totalmente pagada se entrega sin firma y también tiene comprobante", async () => {
    const { participationId } = await seat()
    const { purchaseId } = await createPurchase(cashier, {
      participationId,
      nominalAmount: "1000",
      idempotencyKey: key(),
    })
    await recordPayment(cashier, purchaseId, {
      method: "CASH",
      amount: "1000",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await expect(prepareSignatureSummary(cashier, purchaseId)).rejects.toThrow(
      /no requiere firma/
    )
    await deliver(purchaseId)
    const receipt = await getReceipt(purchaseId, cashier)
    expect(receipt.hasSignature).toBe(false)
    expect(receipt.content.initialCredit).toBe("0.00")
  })

  it("cada recompra con crédito exige su propia firma (no se reutiliza la anterior)", async () => {
    const { participationId } = await seat()
    const p1 = await creditPurchase(participationId, "2000", "500")
    await sign(p1)
    await deliver(p1)
    const p2 = await creditPurchase(participationId, "3000", "0")
    await expect(deliver(p2)).rejects.toThrow(/firma/i)
    const prepared = await sign(p2)
    expect(prepared).toMatchObject({ purchaseType: "REBUY", rebuyNumber: 1 })
    await deliver(p2)
    const signatures = await prisma.purchaseSignature.findMany()
    expect(new Set(signatures.map((s) => s.purchaseId)).size).toBe(2)
    expect(await prisma.playerDebt.count()).toBe(2)
  })

  it("un resumen firmado no se vuelve a firmar ni se acepta una huella que el servidor no preparó", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    const prepared = await prepareSignatureSummary(cashier, id)
    await expect(
      captureSignature(cashier, id, {
        snapshotId: prepared.summary.snapshotId,
        payloadHash: "0".repeat(64),
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/firmar nuevamente/)
    await captureSignature(cashier, id, {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: key(),
    })
    await expect(
      captureSignature(cashier, id, {
        snapshotId: prepared.summary.snapshotId,
        payloadHash: prepared.summary.payloadHash,
        strokes: STROKES,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/no se reutiliza|ya/)
    // Los intentos fallidos no dejan evidencia "activa" huérfana.
    expect(await prisma.storedFile.count({ where: { status: "ACTIVE" } })).toBe(
      1
    )
    expect(
      await prisma.storedFile.count({ where: { status: "PENDING" } })
    ).toBe(0)
  })

  it("rechaza una firma vacía o trivial", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    const prepared = await prepareSignatureSummary(cashier, id)
    for (const strokes of [
      [[[500, 200]]],
      [
        [
          [10, 10],
          [12, 11],
          [14, 12],
        ],
      ],
    ] as [number, number][][][])
      await expect(
        captureSignature(cashier, id, {
          snapshotId: prepared.summary.snapshotId,
          payloadHash: prepared.summary.payloadHash,
          strokes,
          idempotencyKey: key(),
        })
      ).rejects.toThrow(/demasiado corta|vacía|firma/)
    expect(await prisma.purchaseSignature.count()).toBe(0)
    expect(await prisma.storedFile.count()).toBe(0)
  })
})

describe("invalidación por cambios materiales", () => {
  it("cambiar el importe invalida la firma (se conserva como evidencia) y exige firmar de nuevo", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    const v = (await getPurchase(id)).version
    await updateDraft(cashier, id, {
      nominalAmount: "6000",
      expectedVersion: v,
    })
    const old = await prisma.purchaseSignature.findFirstOrThrow()
    expect(old).toMatchObject({
      status: "INVALIDATED",
      invalidatedById: cashier.id,
    })
    expect(old.invalidationReason).toMatch(/importe/i)
    // La evidencia anterior sigue ahí.
    expect(
      await prisma.storedFile.findUniqueOrThrow({ where: { id: old.fileId } })
    ).toMatchObject({ status: "ACTIVE" })
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await expect(deliver(id)).rejects.toThrow(/firma/i)
    const again = await sign(id)
    expect(again.outstandingCreditAmount).toBe("5000.00")
    await deliver(id)
    expect(await prisma.purchaseSignature.count()).toBe(2)
    expect(await prisma.signatureSnapshot.count()).toBe(2)
  })

  it("cambiar de socio o registrar otro pago invalida la firma", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner2.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    expect((await prisma.purchaseSignature.findFirstOrThrow()).status).toBe(
      "INVALIDATED"
    )
    const s2 = await sign(id)
    expect(s2.partnerName).toBe(partner2.name)
    await recordPayment(cashier, id, {
      method: "CASH",
      amount: "500",
      cashReceived: true,
      idempotencyKey: key(),
    })
    const statuses = (await prisma.purchaseSignature.findMany()).map(
      (s) => s.status
    )
    expect(statuses).toEqual(["INVALIDATED", "INVALIDATED"])
    await expect(deliver(id)).rejects.toThrow(/socio/)
  })

  it("si otra compra del jugador se entrega antes, la numeración firmada ya no corresponde", async () => {
    const { participationId } = await seat()
    const p1 = await creditPurchase(participationId, "2000", "500")
    const p2 = await creditPurchase(participationId, "2000", "500")
    await sign(p1)
    const s2 = await sign(p2)
    expect(s2.purchaseType).toBe("INITIAL_PURCHASE")
    await deliver(p1)
    await expect(deliver(p2)).rejects.toThrow(/firmar nuevamente/)
    const again = await sign(p2)
    expect(again).toMatchObject({ purchaseType: "REBUY", rebuyNumber: 1 })
    expect(
      (await prisma.purchaseSignature.findMany({ where: { purchaseId: p2 } }))
        .map((s) => s.status)
        .sort()
    ).toEqual(["INVALIDATED", "VALID"])
    await deliver(p2)
  })

  it("cancelar después de firmar: firma CANCELLED conservada, sin deuda, reserva liberada", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId, "4000", "0")
    await sign(id)
    await cancelPurchase(cashier, id, { reason: "El jugador desistió" })
    const sig = await prisma.purchaseSignature.findFirstOrThrow()
    expect(sig.status).toBe("CANCELLED")
    expect(await effects()).toMatchObject({
      debts: 0,
      deliveries: 0,
      reserved: "0.00",
      receipts: 0,
    })
    await expect(prepareSignatureSummary(cashier, id)).rejects.toThrow(
      /cancelada y no admite nuevas firmas/
    )
  })

  it("un pago posterior a la entrega no modifica el snapshot firmado ni el comprobante", async () => {
    const { participationId } = await seat()
    const { purchaseId: id } = await createPurchase(cashier, {
      participationId,
      nominalAmount: "3000",
      idempotencyKey: key(),
    })
    await recordPayment(cashier, id, {
      method: "BANK_TRANSFER",
      amount: "3000",
      idempotencyKey: key(),
    })
    await recordCreditAuthorization(cashier, id, {
      partnerId: partner.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    await sign(id)
    await deliver(id)
    const before = await getReceipt(id, cashier)
    const snapBefore = await prisma.signatureSnapshot.findFirstOrThrow()
    const t = await prisma.bankTransferVerification.findFirstOrThrow()
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    const after = await getReceipt(id, cashier)
    expect(after.contentHash).toBe(before.contentHash)
    expect(after.content.initialCredit).toBe("3000.00")
    expect(await prisma.signatureSnapshot.findFirstOrThrow()).toEqual(
      snapBefore
    )
    expect((await prisma.purchaseSignature.findFirstOrThrow()).status).toBe(
      "VALID"
    )
    expect((await getPurchase(id)).debt?.currentBalance).toBe("0.00")
  })
})

describe("concurrencia e idempotencia", () => {
  it("dos firmas simultáneas no crean dos firmas VALID ni dejan archivos activos huérfanos", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    const prepared = await prepareSignatureSummary(cashier, id)
    const attempt = () =>
      captureSignature(cashier, id, {
        snapshotId: prepared.summary.snapshotId,
        payloadHash: prepared.summary.payloadHash,
        strokes: STROKES,
        idempotencyKey: key(),
      })
    const results = await Promise.allSettled([attempt(), attempt(), attempt()])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.purchaseSignature.count({ where: { status: "VALID" } })
    ).toBe(1)
    expect(await prisma.storedFile.count({ where: { status: "ACTIVE" } })).toBe(
      1
    )
    expect(await cleanupOrphanedFiles(0)).toBe(0)
    // Los huérfanos no conservan su contenido binario.
    const orphans = await prisma.storedFile.findMany({
      where: { status: "ORPHANED" },
    })
    expect(orphans.length).toBe(2)
    expect(
      await prisma.evidenceBlob.count({
        where: { storageKey: { in: orphans.map((o) => o.storageKey) } },
      })
    ).toBe(0)
  })

  it("la misma clave de firma devuelve la misma firma (doble clic / red)", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    const prepared = await prepareSignatureSummary(cashier, id)
    const input = {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: key(),
    }
    const [a, b] = await Promise.all([
      captureSignature(cashier, id, input),
      captureSignature(cashier, id, input),
    ])
    expect(a.signatureId).toBe(b.signatureId)
    expect(await prisma.purchaseSignature.count()).toBe(1)
  })

  it("dos confirmaciones concurrentes con distinta clave entregan una sola vez", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    const results = await Promise.allSettled([deliver(id), deliver(id)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await effects()).toMatchObject({
      deliveries: 1,
      debts: 1,
      receipts: 1,
      circulation: "5000.00",
    })
  })

  it("una invalidación y una entrega simultáneas se serializan: nunca se entrega con firma invalidada", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    const v = (await getPurchase(id)).version
    const results = await Promise.allSettled([
      deliver(id),
      updateDraft(cashier, id, { nominalAmount: "5500", expectedVersion: v }),
    ])
    const delivered = await prisma.purchaseDelivery.findUnique({
      where: { purchaseId: id },
      include: { signature: true },
    })
    if (delivered) {
      // Ganó la entrega: la firma usada sigue VALID y el cambio de importe falló.
      expect(delivered.signature?.status).toBe("VALID")
      expect(results[1].status).toBe("rejected")
    } else {
      // Ganó el cambio: la firma quedó invalidada y la entrega falló.
      expect(results[0].status).toBe("rejected")
      expect((await prisma.purchaseSignature.findFirstOrThrow()).status).toBe(
        "INVALIDATED"
      )
    }
  })
})

describe("evidencia, comprobantes y seguridad", () => {
  it("la base impide sustituir la imagen, editar el snapshot o borrar evidencia", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    await deliver(id)
    const sig = await prisma.purchaseSignature.findFirstOrThrow({
      include: { file: true },
    })
    await expect(
      prisma.evidenceBlob.update({
        where: { storageKey: sig.file.storageKey },
        data: { bytes: new Uint8Array([1, 2, 3]) },
      })
    ).rejects.toThrow()
    await expect(
      prisma.evidenceBlob.delete({ where: { storageKey: sig.file.storageKey } })
    ).rejects.toThrow()
    await expect(
      prisma.signatureSnapshot.updateMany({
        data: { outstandingCreditAmount: "1" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.purchaseSignature.update({
        where: { id: sig.id },
        data: {
          status: "INVALIDATED",
          invalidatedAt: new Date(),
          invalidatedById: cashier.id,
          invalidationReason: "Intento posterior a la entrega",
        },
      })
    ).rejects.toThrow()
    await expect(
      prisma.purchaseReceipt.updateMany({ data: { contentHash: "x" } })
    ).rejects.toThrow()
    await expect(prisma.purchaseReceipt.deleteMany()).rejects.toThrow()
  })

  it("el reverso conserva comprobante y firma; anular marca VOIDED sin borrar nada", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    await deliver(id)
    await requestReversal(cashier, id, {
      reason: "Solicitud de prueba de reverso",
      idempotencyKey: key(),
    })
    expect((await getReceipt(id, cashier)).status).toBe("AVAILABLE")
    const before = await getReceipt(id, cashier)
    await prisma.$transaction((tx) =>
      voidReceiptInTx(tx, cashier, id, {
        reason: "Reverso aprobado",
        reference: "REV-TEST",
      })
    )
    const after = await getReceipt(id, cashier)
    expect(after).toMatchObject({
      status: "VOIDED",
      voidReference: "REV-TEST",
      contentHash: before.contentHash,
      intact: true,
    })
    expect((await prisma.purchaseSignature.findFirstOrThrow()).status).toBe(
      "VALID"
    )
  })

  it("API: firma solo con trazos, evidencia privada, PNG del comprobante y sin PDF ni URLs públicas", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    signInAs(cashier._user)
    const prepared = await call(summaryRoute.POST, {
      method: "POST",
      params: { id },
    })
    expect(prepared.status).toBe(200)
    const summary = (
      prepared.json.data as {
        summary: { snapshotId: string; payloadHash: string }
      }
    ).summary
    // Una imagen arbitraria no se acepta como firma.
    const upload = await call(signaturesRoute.POST, {
      method: "POST",
      params: { id },
      body: {
        snapshotId: summary.snapshotId,
        payloadHash: summary.payloadHash,
        image: "data:image/png;base64,AAAA",
        strokes: STROKES,
        idempotencyKey: key(),
      },
    })
    expect(upload.status).toBe(400)
    const signed = await call(signaturesRoute.POST, {
      method: "POST",
      params: { id },
      body: {
        snapshotId: summary.snapshotId,
        payloadHash: summary.payloadHash,
        strokes: STROKES,
        idempotencyKey: key(),
      },
    })
    expect(signed.status).toBe(201)
    expect(signed.text).not.toMatch(/storageKey|evidence\//)
    const evidence = await raw(evidenceRoute.GET, id)
    expect(evidence.status).toBe(200)
    expect(evidence.headers.get("content-type")).toBe("image/png")
    expect(evidence.headers.get("cache-control")).toBe("private, no-store")
    await deliver(id)
    const receipt = await call(receiptRoute.GET, { params: { id } })
    expect(receipt.status).toBe(200)
    expect(receipt.text).not.toMatch(/storageKey|evidence\/|application\/pdf/)

    // PNG del comprobante (descarga), con la firma (usuario autorizado).
    const res = await raw(receiptImageRoute.GET, id)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="comprobante-.*\.png"/
    )
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(1, 4).toString()).toBe("PNG")
    expect(bytes.length).toBeGreaterThan(5000)

    // Sin sesión: nada.
    signOut()
    expect((await raw(evidenceRoute.GET, id)).status).toBe(401)
    expect((await call(receiptRoute.GET, { params: { id } })).status).toBe(401)
    // Usuario desactivado (cambio de permisos): ya no accede.
    const former = await actorFor("CASHIER")
    signInAs(former._user)
    await prisma.user.update({
      where: { id: former.id },
      data: { isActive: false },
    })
    expect((await raw(evidenceRoute.GET, id)).status).toBe(401)
    // Firma de otra compra con un id de compra distinto: no se expone.
    signInAs(cashier._user)
    const other = await seat()
    const otherId = await creditPurchase(other.participationId, "1000", "0")
    const sig = await prisma.purchaseSignature.findFirstOrThrow({
      where: { purchaseId: id },
    })
    const cross = await raw(
      evidenceRoute.GET,
      otherId,
      `?signatureId=${sig.id}`
    )
    expect(cross.status).toBe(404)
    // No existe ruta PDF.
    await expect(
      import("@/app/api/purchases/[id]/receipt/pdf/route" as string)
    ).rejects.toThrow()
  })

  it("auditoría completa sin imágenes en la bitácora", async () => {
    const { participationId } = await seat()
    const id = await creditPurchase(participationId)
    await sign(id)
    await deliver(id)
    const actions = (await auditRows()).map((r) => r.action)
    for (const a of [
      "SIGNATURE_SUMMARY_PREPARED",
      "SIGNATURE_CAPTURED",
      "PURCHASE_DELIVERY_CONFIRMED",
      "RECEIPT_CREATED",
    ])
      expect(actions).toContain(a)
    const captured = (await auditRows("SIGNATURE_CAPTURED"))[0]
    expect(captured.metadata).toMatchObject({ purchaseId: id })
    expect(
      (captured.metadata as Record<string, unknown>).snapshotDigest
    ).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(await auditRows())).not.toMatch(/base64|iVBOR/)
  })
})
