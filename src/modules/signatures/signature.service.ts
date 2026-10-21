import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { canonicalHash, sha256Hex } from "@/lib/canonical-json"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  paymentEffect,
  effectiveAmount,
} from "@/modules/purchases/purchase.math"
import {
  loadPurchaseCreditStateInTx,
  type PurchaseCreditState,
} from "@/modules/purchases/purchase.service"
import {
  SIGNATURE_STALE_MESSAGE,
  type SignatureLookup,
} from "@/modules/purchases/signature-gateway"
import { validateParticipationForPurchase } from "@/modules/session-tables/participation.service"
import { lockOpenSession } from "@/modules/session-tables/session-table.service"
import {
  discardStagedFile,
  promoteStoredFileInTx,
  readEvidence,
  stagePrivateFile,
} from "@/modules/signatures/evidence-storage"
import { invalidatePurchaseSignaturesInTx } from "@/modules/signatures/signature-invalidation"
import { currentDeclaration } from "@/modules/signatures/signature.declaration"
import {
  assertMeaningfulSignature,
  inspectSignaturePng,
  renderSignaturePng,
  type Strokes,
} from "@/modules/signatures/signature.strokes"

/**
 * Firmas de reconocimiento de crédito (Módulo 09).
 *
 * Flujo: compra con crédito y socio autorizador → el servidor PREPARA el
 * resumen (snapshot inmutable con huella canónica) → el jugador lo revisa y
 * firma en el dispositivo del cajero → se guarda la firma VALID (imagen
 * privada) → el cajero confirma la entrega en el Módulo 08, que vuelve a
 * verificar todo dentro de su transacción.
 *
 * Una firma NO mueve fichas, dinero ni crea deuda. Es evidencia operativa de
 * aceptación (no firma electrónica avanzada ni verificación biométrica).
 */

type Tx = Prisma.TransactionClient
const SIG_TX = { maxWait: 15_000, timeout: 30_000 } as const
const user = { select: { id: true, name: true } } as const

export const SIGNATURE_MESSAGES = {
  cancelled: "Esta compra fue cancelada y no admite nuevas firmas.",
  delivered: "La compra ya fue entregada: su firma no se modifica.",
  notRequired: "La compra está totalmente pagada: no requiere firma.",
  partnerRequired:
    "Primero registra al socio que autorizó el crédito. Revisa el importe antes de firmar.",
  alreadySigned: "Firma registrada. El cajero debe confirmar la entrega.",
  stale: SIGNATURE_STALE_MESSAGE,
} as const

// ── Contenido del reconocimiento ─────────────────────────────────────

export type SnapshotContent = {
  purchaseId: string
  playerId: string
  playerName: string
  sessionId: string
  sessionFolio: string
  tableId: string
  tableName: string
  purchaseFolio: string
  purchaseType: "INITIAL_PURCHASE" | "REBUY"
  rebuyNumber: number | null
  nominalAmount: string
  confirmedPaymentsAmount: string
  pendingTransferAmount: string
  outstandingCreditAmount: string
  payments: { method: string; amount: string }[]
  creditAuthorizationId: string
  authorizedByPartnerId: string
  partnerName: string
  authorizationChannel: "VERBAL" | "MESSAGE"
  declarationText: string
  declarationVersion: string
  purchaseVersion: number
}

function assertSignable(state: PurchaseCreditState) {
  const p = state.purchase
  if (p.status === "CANCELLED")
    throw new BusinessRuleError(SIGNATURE_MESSAGES.cancelled)
  if (p.status !== "DRAFT" && p.status !== "READY_FOR_DELIVERY")
    throw new BusinessRuleError(SIGNATURE_MESSAGES.delivered)
  if (!state.financials.outstanding.greaterThan(0))
    throw new BusinessRuleError(SIGNATURE_MESSAGES.notRequired)
  if (!state.authorization)
    throw new BusinessRuleError(SIGNATURE_MESSAGES.partnerRequired)
}

/** Contenido VIGENTE (desde la base, nunca desde el navegador). */
export function snapshotContentOf(state: PurchaseCreditState): SnapshotContent {
  const p = state.purchase
  const f = state.financials
  const a = state.authorization!
  const declaration = currentDeclaration()
  return {
    purchaseId: p.id,
    playerId: p.player.id,
    playerName: p.player.name,
    sessionId: p.sessionId,
    sessionFolio: p.session.folio,
    tableId: p.table.id,
    tableName: p.table.name,
    purchaseFolio: p.folio,
    purchaseType: state.projectedNumber.purchaseType,
    rebuyNumber: state.projectedNumber.rebuyNumber,
    nominalAmount: f.nominalAmount.toFixed(2),
    confirmedPaymentsAmount: f.confirmedPayments.toFixed(2),
    pendingTransferAmount: f.pendingTransfers.toFixed(2),
    outstandingCreditAmount: f.outstanding.toFixed(2),
    payments: p.payments
      .map((x) => ({
        id: x.id,
        method: x.method,
        amount: new Prisma.Decimal(x.amount),
        status: x.status,
        transferStatus: x.bankTransfer?.status ?? null,
        transferConfirmedAmount: x.bankTransfer?.confirmedAmount
          ? new Prisma.Decimal(x.bankTransfer.confirmedAmount)
          : null,
      }))
      .filter((x) => paymentEffect(x) === "CONFIRMED")
      .map((x) => ({
        method: x.method,
        amount: effectiveAmount(x).toFixed(2),
      })),
    creditAuthorizationId: a.id,
    authorizedByPartnerId: a.authorizedByPartner.id,
    partnerName: a.partnerNameSnapshot,
    authorizationChannel: a.authorizationChannel,
    declarationText: declaration.text,
    declarationVersion: declaration.version,
    purchaseVersion: p.version,
  }
}

type SnapshotRow = Prisma.SignatureSnapshotGetPayload<{
  select: typeof snapshotSelect
}>

const snapshotSelect = {
  id: true,
  purchaseId: true,
  playerId: true,
  playerNameSnapshot: true,
  sessionId: true,
  sessionFolioSnapshot: true,
  tableId: true,
  tableNameSnapshot: true,
  purchaseFolio: true,
  purchaseType: true,
  rebuyNumber: true,
  nominalAmount: true,
  confirmedPaymentsAmount: true,
  pendingTransferAmount: true,
  outstandingCreditAmount: true,
  paymentsSnapshot: true,
  creditAuthorizationId: true,
  authorizedByPartnerId: true,
  partnerNameSnapshot: true,
  authorizationChannel: true,
  declarationText: true,
  declarationVersion: true,
  purchaseVersion: true,
  preparedAt: true,
  preparedById: true,
  contentHash: true,
  payloadHash: true,
} satisfies Prisma.SignatureSnapshotSelect

/** Reconstruye el contenido firmado desde las columnas guardadas. */
export function contentFromRow(r: SnapshotRow): SnapshotContent {
  return {
    purchaseId: r.purchaseId,
    playerId: r.playerId,
    playerName: r.playerNameSnapshot,
    sessionId: r.sessionId,
    sessionFolio: r.sessionFolioSnapshot,
    tableId: r.tableId,
    tableName: r.tableNameSnapshot,
    purchaseFolio: r.purchaseFolio,
    purchaseType: r.purchaseType,
    rebuyNumber: r.rebuyNumber,
    nominalAmount: new Prisma.Decimal(r.nominalAmount).toFixed(2),
    confirmedPaymentsAmount: new Prisma.Decimal(
      r.confirmedPaymentsAmount
    ).toFixed(2),
    pendingTransferAmount: new Prisma.Decimal(r.pendingTransferAmount).toFixed(
      2
    ),
    outstandingCreditAmount: new Prisma.Decimal(
      r.outstandingCreditAmount
    ).toFixed(2),
    payments: r.paymentsSnapshot as SnapshotContent["payments"],
    creditAuthorizationId: r.creditAuthorizationId,
    authorizedByPartnerId: r.authorizedByPartnerId,
    partnerName: r.partnerNameSnapshot,
    authorizationChannel: r.authorizationChannel,
    declarationText: r.declarationText,
    declarationVersion: r.declarationVersion,
    purchaseVersion: r.purchaseVersion,
  }
}

export function payloadOf(
  content: SnapshotContent,
  preparedAt: Date,
  preparedById: string
) {
  return { ...content, preparedAt: preparedAt.toISOString(), preparedById }
}

/** La fila no fue manipulada: su contenido y su carga coinciden con sus huellas. */
export function snapshotIntact(r: SnapshotRow) {
  const content = contentFromRow(r)
  return (
    canonicalHash(content) === r.contentHash &&
    canonicalHash(payloadOf(content, r.preparedAt, r.preparedById)) ===
      r.payloadHash
  )
}

function snapshotView(r: SnapshotRow) {
  return {
    snapshotId: r.id,
    payloadHash: r.payloadHash,
    preparedAt: r.preparedAt.toISOString(),
    ...contentFromRow(r),
  }
}
export type SignatureSummaryView = ReturnType<typeof snapshotView>

// ── Preparar el resumen ──────────────────────────────────────────────

async function lockPurchaseRow(tx: Tx, purchaseId: string) {
  const rows = await tx.$queryRaw<{ id: string; sessionId: string }[]>`
    SELECT "id", "sessionId" FROM "chip_purchases" WHERE "id" = ${purchaseId} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Compra no encontrada")
  return rows[0]
}

async function purchaseSession(purchaseId: string) {
  const p = await prisma.chipPurchase.findUnique({
    where: { id: purchaseId },
    select: { sessionId: true },
  })
  if (!p) throw new NotFoundError("Compra no encontrada")
  return p.sessionId
}

/**
 * Prepara (o reutiliza) el reconocimiento EXACTO que verá el jugador. Si la
 * compra tenía una firma VALID para un contenido distinto (p. ej. cambió la
 * declaración o la numeración proyectada), la invalida con motivo.
 */
export async function prepareSignatureSummary(
  actor: SessionUser,
  purchaseId: string,
  ctx: RequestContext = {}
) {
  const sessionId = await purchaseSession(purchaseId)
  const result = await prisma.$transaction(async (tx) => {
    await lockOpenSession(
      tx,
      sessionId,
      "La sesión debe estar abierta para firmar."
    )
    await lockPurchaseRow(tx, purchaseId)
    const state = await loadPurchaseCreditStateInTx(tx, purchaseId)
    assertSignable(state)
    const content = snapshotContentOf(state)
    const contentHash = canonicalHash(content)
    const valid = await tx.purchaseSignature.findFirst({
      where: { purchaseId, status: "VALID" },
      select: { id: true, snapshot: { select: snapshotSelect } },
    })
    if (valid && valid.snapshot.contentHash === contentHash)
      return { snapshot: valid.snapshot, created: false }
    if (valid)
      await invalidatePurchaseSignaturesInTx(
        tx,
        {
          purchaseId,
          actorId: actor.id,
          reason:
            "El resumen firmado ya no corresponde a la compra (cambio material o de declaración)",
        },
        ctx
      )
    const existing = await tx.signatureSnapshot.findUnique({
      where: { purchaseId_contentHash: { purchaseId, contentHash } },
      select: snapshotSelect,
    })
    if (existing) return { snapshot: existing, created: false }
    const preparedAt = new Date()
    const payloadHash = canonicalHash(payloadOf(content, preparedAt, actor.id))
    const snapshot = await tx.signatureSnapshot.create({
      data: {
        purchaseId,
        playerId: content.playerId,
        playerNameSnapshot: content.playerName,
        sessionId: content.sessionId,
        sessionFolioSnapshot: content.sessionFolio,
        tableId: content.tableId,
        tableNameSnapshot: content.tableName,
        purchaseFolio: content.purchaseFolio,
        purchaseType: content.purchaseType,
        rebuyNumber: content.rebuyNumber,
        nominalAmount: content.nominalAmount,
        confirmedPaymentsAmount: content.confirmedPaymentsAmount,
        pendingTransferAmount: content.pendingTransferAmount,
        outstandingCreditAmount: content.outstandingCreditAmount,
        paymentsSnapshot: content.payments,
        creditAuthorizationId: content.creditAuthorizationId,
        authorizedByPartnerId: content.authorizedByPartnerId,
        partnerNameSnapshot: content.partnerName,
        authorizationChannel: content.authorizationChannel,
        declarationText: content.declarationText,
        declarationVersion: content.declarationVersion,
        purchaseVersion: content.purchaseVersion,
        preparedAt,
        preparedById: actor.id,
        contentHash,
        payloadHash,
      },
      select: snapshotSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SIGNATURE_SUMMARY_PREPARED,
        entityType: "SignatureSnapshot",
        entityId: snapshot.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          purchaseId,
          playerId: content.playerId,
          sessionId: content.sessionId,
          snapshotDigest: payloadHash,
          purchaseVersion: content.purchaseVersion,
          creditAmount: content.outstandingCreditAmount,
          declarationVersion: content.declarationVersion,
        },
      },
      tx
    )
    return { snapshot, created: true }
  }, SIG_TX)
  return {
    ...(await getSignatureStatus(purchaseId)),
    summary: snapshotView(result.snapshot),
  }
}

// ── Estado y consulta ────────────────────────────────────────────────

export async function getSignatureStatus(purchaseId: string) {
  const purchase = await prisma.chipPurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      status: true,
      signatures: {
        orderBy: { signedAt: "desc" },
        select: {
          id: true,
          status: true,
          signedAt: true,
          invalidatedAt: true,
          invalidationReason: true,
          capturedBy: user,
          invalidatedBy: user,
          snapshot: { select: snapshotSelect },
        },
      },
      delivery: { select: { signatureId: true } },
    },
  })
  if (!purchase) throw new NotFoundError("Compra no encontrada")
  const state = await loadPurchaseCreditStateInTx(prisma, purchaseId)
  const required = state.financials.outstanding.greaterThan(0)
  const valid = purchase.signatures.find((s) => s.status === "VALID") ?? null
  let currentHash: string | null = null
  if (
    required &&
    state.authorization &&
    (purchase.status === "DRAFT" || purchase.status === "READY_FOR_DELIVERY")
  )
    currentHash = canonicalHash(snapshotContentOf(state))
  return {
    purchaseId,
    purchaseStatus: purchase.status,
    required: required || Boolean(purchase.delivery?.signatureId),
    partnerRegistered: Boolean(state.authorization),
    validSignature: valid
      ? {
          id: valid.id,
          signedAt: valid.signedAt.toISOString(),
          capturedBy: valid.capturedBy,
          snapshotHash: valid.snapshot.payloadHash,
          /** Coincide con el contenido vigente de la compra. */
          current:
            purchase.delivery?.signatureId === valid.id ||
            valid.snapshot.contentHash === currentHash,
          summary: snapshotView(valid.snapshot),
        }
      : null,
    deliveredSignatureId: purchase.delivery?.signatureId ?? null,
    history: purchase.signatures.map((s) => ({
      id: s.id,
      status: s.status,
      signedAt: s.signedAt.toISOString(),
      capturedBy: s.capturedBy,
      invalidatedAt: s.invalidatedAt?.toISOString() ?? null,
      invalidatedBy: s.invalidatedBy,
      invalidationReason: s.invalidationReason,
      snapshotHash: s.snapshot.payloadHash,
      purchaseVersion: s.snapshot.purchaseVersion,
    })),
  }
}
export type SignatureStatusView = Awaited<ReturnType<typeof getSignatureStatus>>

// ── Capturar la firma ────────────────────────────────────────────────

/**
 * Registra la firma del jugador para un snapshot preparado. El navegador
 * envía trazos; el servidor genera el PNG, lo guarda en almacenamiento
 * privado y, en una transacción con la compra bloqueada, verifica que el
 * snapshot siga vigente y crea la firma VALID. No entrega fichas.
 */
export async function captureSignature(
  actor: SessionUser,
  purchaseId: string,
  input: {
    snapshotId: string
    payloadHash: string
    strokes: Strokes
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const replay = async () => {
    const r = await prisma.purchaseSignature.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, purchaseId: true, snapshotId: true },
    })
    if (r && (r.purchaseId !== purchaseId || r.snapshotId !== input.snapshotId))
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra firma"
      )
    return r
  }
  const previous = await replay()
  if (previous) return { signatureId: previous.id, replayed: true }
  const sessionId = await purchaseSession(purchaseId)

  let png: Buffer
  try {
    assertMeaningfulSignature(input.strokes)
    png = renderSignaturePng(input.strokes)
    if (inspectSignaturePng(png).ink < 150)
      throw new Error("Debes registrar tu firma para continuar.")
  } catch (e) {
    await recordAudit({
      action: AUDIT_ACTIONS.SIGNATURE_REJECTED,
      entityType: "ChipPurchase",
      entityId: purchaseId,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      result: "FAILURE",
      metadata: { reason: e instanceof Error ? e.message : "Firma inválida" },
    })
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "Firma inválida"
    )
  }

  const file = await stagePrivateFile({
    bytes: png,
    mimeType: "image/png",
    purpose: "PURCHASE_SIGNATURE",
    createdById: actor.id,
  })
  try {
    const signatureId = await prisma.$transaction(async (tx) => {
      await lockOpenSession(
        tx,
        sessionId,
        "La sesión debe estar abierta para firmar."
      )
      await lockPurchaseRow(tx, purchaseId)
      const again = await tx.purchaseSignature.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
      const state = await loadPurchaseCreditStateInTx(tx, purchaseId)
      assertSignable(state)
      const snapshot = await tx.signatureSnapshot.findFirst({
        where: { id: input.snapshotId, purchaseId },
        select: { ...snapshotSelect, signature: { select: { id: true } } },
      })
      if (!snapshot) throw new NotFoundError("Resumen de firma no encontrado")
      // El jugador firma lo que el servidor preparó (no algo construido en el navegador).
      if (
        snapshot.payloadHash !== input.payloadHash ||
        !snapshotIntact(snapshot)
      )
        throw new ConflictError(SIGNATURE_MESSAGES.stale)
      if (snapshot.signature)
        throw new ConflictError(
          "Este reconocimiento ya fue firmado: una firma no se reutiliza. Prepara uno nuevo."
        )
      if (snapshot.contentHash !== canonicalHash(snapshotContentOf(state)))
        throw new ConflictError(SIGNATURE_MESSAGES.stale)
      const valid = await tx.purchaseSignature.findFirst({
        where: { purchaseId, status: "VALID" },
        select: { id: true },
      })
      if (valid) throw new ConflictError(SIGNATURE_MESSAGES.alreadySigned)
      await validateParticipationForPurchase(
        tx,
        state.purchase.participationId,
        state.purchase.playerId
      )
      await promoteStoredFileInTx(tx, file.id, purchaseId)
      const signedAt = new Date()
      const created = await tx.purchaseSignature.create({
        data: {
          purchaseId,
          playerId: snapshot.playerId,
          snapshotId: snapshot.id,
          fileId: file.id,
          imageHash: file.sha256,
          signedAt,
          capturedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SIGNATURE_CAPTURED,
          entityType: "PurchaseSignature",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            purchaseId,
            playerId: snapshot.playerId,
            sessionId: snapshot.sessionId,
            snapshotId: snapshot.id,
            snapshotDigest: snapshot.payloadHash,
            evidenceFileId: file.id,
            imageDigest: file.sha256,
            creditAmount: new Prisma.Decimal(
              snapshot.outstandingCreditAmount
            ).toFixed(2),
            note: "Firma capturada en el dispositivo del operador; la entrega aún no se confirma.",
          },
        },
        tx
      )
      return { id: created.id, replayed: false }
    }, SIG_TX)
    if (signatureId.replayed) await discardStagedFile(file.id, "replay")
    return { signatureId: signatureId.id, replayed: signatureId.replayed }
  } catch (error) {
    await discardStagedFile(file.id, "transaction-failed")
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { signatureId: again.id, replayed: true }
      throw new ConflictError(SIGNATURE_MESSAGES.alreadySigned)
    }
    throw error
  }
}

// ── Verificación para la entrega (Módulo 08) ─────────────────────────

/**
 * Llamado DENTRO de la transacción de entrega (compra ya bloqueada): bloquea
 * la firma VALID, comprueba jugador, versión, integridad del snapshot,
 * que el contenido vigente sea exactamente el firmado y la integridad de la
 * imagen. Una firma INVALIDATED/CANCELLED nunca se devuelve.
 */
export async function findValidPurchaseSignatureInTx(
  tx: Tx,
  lookup: SignatureLookup
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "purchase_signatures"
    WHERE "purchaseId" = ${lookup.purchaseId} AND "status" = 'VALID' FOR UPDATE
  `
  if (rows.length === 0) return null
  const sig = await tx.purchaseSignature.findUniqueOrThrow({
    where: { id: rows[0].id },
    select: {
      id: true,
      playerId: true,
      imageHash: true,
      fileId: true,
      file: { select: { status: true, sha256: true } },
      snapshot: { select: snapshotSelect },
    },
  })
  if (
    sig.playerId !== lookup.playerId ||
    sig.snapshot.playerId !== lookup.playerId
  )
    throw new BusinessRuleError(
      "La firma no corresponde al jugador de la compra."
    )
  if (!snapshotIntact(sig.snapshot))
    throw new BusinessRuleError(
      "El resumen firmado no supera la verificación de integridad."
    )
  if (sig.snapshot.purchaseVersion !== lookup.summaryVersion)
    throw new BusinessRuleError(SIGNATURE_MESSAGES.stale)
  const state = await loadPurchaseCreditStateInTx(tx, lookup.purchaseId)
  if (
    !state.authorization ||
    canonicalHash(snapshotContentOf(state)) !== sig.snapshot.contentHash
  )
    throw new BusinessRuleError(SIGNATURE_MESSAGES.stale)
  if (sig.file.status !== "ACTIVE" || sig.file.sha256 !== sig.imageHash)
    throw new BusinessRuleError("La evidencia de la firma no está disponible.")
  const evidence = await readEvidence(sig.fileId)
  if (!evidence || sha256Hex(evidence.bytes) !== sig.imageHash)
    throw new BusinessRuleError("La evidencia de la firma no está disponible.")
  return {
    signatureId: sig.id,
    expectedNumber: {
      purchaseType: sig.snapshot.purchaseType,
      rebuyNumber: sig.snapshot.rebuyNumber,
    },
  }
}

// ── Evidencia privada ────────────────────────────────────────────────

/**
 * Devuelve el PNG de una firma (solo desde el servidor, tras autorizar).
 * Por defecto: la firma de la entrega o la VALID vigente.
 */
export async function getSignatureEvidence(
  actor: SessionUser,
  purchaseId: string,
  signatureId: string | null,
  ctx: RequestContext = {}
) {
  const sig = await prisma.purchaseSignature.findFirst({
    where: signatureId
      ? { id: signatureId, purchaseId }
      : {
          purchaseId,
          OR: [{ status: "VALID" }, { delivery: { isNot: null } }],
        },
    orderBy: { signedAt: "desc" },
    select: { id: true, fileId: true, status: true, imageHash: true },
  })
  if (!sig) throw new NotFoundError("Firma no encontrada")
  const evidence = await readEvidence(sig.fileId)
  if (!evidence || evidence.sha256 !== sig.imageHash)
    throw new NotFoundError("Evidencia no disponible")
  await recordAudit({
    action: AUDIT_ACTIONS.SIGNATURE_EVIDENCE_VIEWED,
    entityType: "PurchaseSignature",
    entityId: sig.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { purchaseId, status: sig.status },
  })
  return {
    bytes: evidence.bytes,
    mimeType: evidence.mimeType,
    signatureId: sig.id,
  }
}

/** PNG de la firma de una entrega (para el comprobante), sin auditar de nuevo. */
export async function deliverySignaturePng(purchaseId: string) {
  const delivery = await prisma.purchaseDelivery.findUnique({
    where: { purchaseId },
    select: { signature: { select: { fileId: true, imageHash: true } } },
  })
  if (!delivery?.signature) return null
  const evidence = await readEvidence(delivery.signature.fileId)
  return evidence && evidence.sha256 === delivery.signature.imageHash
    ? evidence.bytes
    : null
}
