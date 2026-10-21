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
import { lockOpenSession } from "@/modules/session-tables/session-table.service"
import {
  bumpSettlementVersionInTx,
  dec,
  fmt,
  lockSettlement,
  materialOf,
  planForInTx,
  planInputOf,
  recordSettlementStatus,
  SETTLEMENT_STALE_MESSAGE,
  SETTLEMENT_TX,
  type DebtInfo,
  type Db,
  type SettlementCore,
  type Tx,
} from "@/modules/settlements/settlement-core"
import { currentSettlementDeclaration } from "@/modules/settlements/settlement.declaration"
import type { SettlementPlan } from "@/modules/settlements/settlement.math"
import {
  discardStagedFile,
  promoteStoredFileInTx,
  readEvidence,
  stagePrivateFile,
} from "@/modules/signatures/evidence-storage"
import {
  assertMeaningfulSignature,
  inspectSignaturePng,
  renderSignaturePng,
  type Strokes,
} from "@/modules/signatures/signature.strokes"

/**
 * Firma OBLIGATORIA de toda liquidación (Módulo 11), con la infraestructura
 * del Módulo 09 (trazos → PNG en el servidor, almacenamiento privado,
 * snapshot canónico con huella). Incluye devoluciones de $0, con o sin
 * deuda y con o sin compensación.
 *
 * Flujo: el servidor PREPARA el resumen exacto (snapshot inmutable) → el
 * jugador lo revisa y firma en el celular del cajero → firma VALID y la
 * liquidación queda READY_FOR_CONFIRMATION → el cajero confirma la
 * recepción física, que vuelve a verificar firma, versión, integridad y la
 * parte MATERIAL (importes, decisión, FIFO, neto) dentro de su transacción.
 *
 * La firma NO recibe fichas, no compensa deuda ni mueve dinero. Es
 * evidencia operativa (no firma electrónica avanzada ni biometría). Nunca
 * se reutiliza: una por snapshot y una sola VALID por liquidación.
 */

export const SETTLEMENT_SIGNATURE_MESSAGES = {
  received:
    "La recepción ya se confirmó: la firma de esta liquidación no cambia.",
  closed: "Esta liquidación ya no admite firmas.",
  alreadySigned:
    "Firma registrada. El cajero debe confirmar la recepción de las fichas.",
  stale: SETTLEMENT_STALE_MESSAGE,
} as const

// ── Contenido firmado ────────────────────────────────────────────────

export type SettlementSnapshotContent = {
  documentType: "PLAYER_SETTLEMENT"
  settlementId: string
  folio: string
  settlementVersion: number
  player: { id: string; name: string }
  session: { id: string; folio: string }
  table: { id: string; name: string }
  participationId: string
  returnedNominalAmount: string
  /** Saldo global de deuda consultado al preparar (informativo). */
  debtBalance: string
  offsetDecision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
  offsetAmount: string
  /** Distribución FIFO PREVISTA (solo si se compensa). */
  allocations: {
    order: number
    receivableId: string
    purchaseFolio: string
    sessionFolio: string
    tableName: string
    amount: string
    balanceBefore: string
    balanceAfter: string
  }[]
  remainingDebt: string
  netPayoutAmount: string
  /** Antes de recibir las fichas no existen pagos: siempre $0. */
  confirmedPayoutAmount: string
  /** Importe previsto pendiente de pago (= neto). */
  pendingPayoutAmount: string
  declarationText: string
  declarationVersion: string
}

export function snapshotContentFor(
  s: Pick<
    SettlementCore,
    | "id"
    | "folio"
    | "version"
    | "participationId"
    | "player"
    | "session"
    | "table"
    | "playerId"
  >,
  plan: SettlementPlan,
  debts: Map<string, DebtInfo>
): SettlementSnapshotContent {
  const declaration = currentSettlementDeclaration()
  return {
    documentType: "PLAYER_SETTLEMENT",
    settlementId: s.id,
    folio: s.folio,
    settlementVersion: s.version,
    player: { id: s.player.id, name: s.player.name },
    session: { id: s.session.id, folio: s.session.folio },
    table: { id: s.table.id, name: s.table.name },
    participationId: s.participationId,
    returnedNominalAmount: fmt(plan.returned),
    debtBalance: fmt(plan.outstanding),
    offsetDecision: plan.decision,
    offsetAmount: fmt(plan.offset),
    allocations: plan.allocations.map((a) => {
      const d = debts.get(a.receivableId)
      return {
        order: a.order,
        receivableId: a.receivableId,
        purchaseFolio: d?.purchaseFolio ?? "",
        sessionFolio: d?.sessionFolio ?? "",
        tableName: d?.tableName ?? "",
        amount: fmt(a.amount),
        balanceBefore: fmt(a.balanceBefore),
        balanceAfter: fmt(a.balanceAfter),
      }
    }),
    remainingDebt: fmt(plan.remainingDebt),
    netPayoutAmount: fmt(plan.net),
    confirmedPayoutAmount: "0.00",
    pendingPayoutAmount: fmt(plan.net),
    declarationText: declaration.text,
    declarationVersion: declaration.version,
  }
}

/** Parte material del contenido mostrado (se compara al confirmar). */
export function materialFromContent(c: SettlementSnapshotContent) {
  return {
    settlementId: c.settlementId,
    settlementVersion: c.settlementVersion,
    playerId: c.player.id,
    participationId: c.participationId,
    returnedNominalAmount: c.returnedNominalAmount,
    offsetDecision: c.offsetDecision,
    offsetAmount: c.offsetAmount,
    allocations: c.allocations.map((a) => ({
      receivableId: a.receivableId,
      amount: a.amount,
    })),
    netPayoutAmount: c.netPayoutAmount,
    declarationVersion: c.declarationVersion,
  }
}

export function payloadOf(
  content: SettlementSnapshotContent,
  preparedAt: Date,
  preparedById: string
) {
  return { ...content, preparedAt: preparedAt.toISOString(), preparedById }
}

const snapshotSelect = {
  id: true,
  settlementId: true,
  playerId: true,
  settlementVersion: true,
  content: true,
  declarationText: true,
  declarationVersion: true,
  preparedAt: true,
  preparedById: true,
  contentHash: true,
  materialHash: true,
  payloadHash: true,
} satisfies Prisma.SettlementSignatureSnapshotSelect

type SnapshotRow = Prisma.SettlementSignatureSnapshotGetPayload<{
  select: typeof snapshotSelect
}>

/** La fila no fue manipulada: contenido, parte material y carga coinciden con sus huellas. */
export function settlementSnapshotIntact(r: SnapshotRow) {
  const content = r.content as unknown as SettlementSnapshotContent
  return (
    canonicalHash(content) === r.contentHash &&
    canonicalHash(materialFromContent(content)) === r.materialHash &&
    canonicalHash(payloadOf(content, r.preparedAt, r.preparedById)) ===
      r.payloadHash &&
    content.declarationText === r.declarationText &&
    content.settlementVersion === r.settlementVersion
  )
}

function snapshotView(r: SnapshotRow) {
  return {
    snapshotId: r.id,
    payloadHash: r.payloadHash,
    preparedAt: r.preparedAt.toISOString(),
    ...(r.content as unknown as SettlementSnapshotContent),
  }
}
export type SettlementSummaryView = ReturnType<typeof snapshotView>

function assertSignable(s: SettlementCore) {
  if (s.status === "PENDING_PAYOUT" || s.status === "COMPLETED")
    throw new BusinessRuleError(SETTLEMENT_SIGNATURE_MESSAGES.received)
  if (s.status !== "DRAFT" && s.status !== "READY_FOR_CONFIRMATION")
    throw new BusinessRuleError(SETTLEMENT_SIGNATURE_MESSAGES.closed)
}

async function assertParticipationActive(db: Db, participationId: string) {
  const p = await db.tableParticipation.findUnique({
    where: { id: participationId },
    select: { status: true },
  })
  if (p?.status !== "ACTIVE")
    throw new BusinessRuleError("El jugador ya no está activo en la mesa.")
}

async function settlementSession(id: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id },
    select: { sessionId: true },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  return s.sessionId
}

// ── Preparar el resumen ──────────────────────────────────────────────

/**
 * Prepara (o reutiliza) el resumen EXACTO que verá el jugador. Si existe
 * una firma VALID cuya parte material ya no coincide con el plan vigente
 * (p. ej. cambiaron las deudas a compensar), se invalida, la liquidación
 * sube de versión y se prepara un resumen nuevo.
 */
export async function prepareSettlementSignatureSummary(
  actor: SessionUser,
  settlementId: string,
  ctx: RequestContext = {}
) {
  const sessionId = await settlementSession(settlementId)
  const snapshot = await prisma.$transaction(async (tx) => {
    await lockOpenSession(
      tx,
      sessionId,
      "La sesión debe estar abierta para firmar."
    )
    let s = await lockSettlement(tx, settlementId)
    assertSignable(s)
    await assertParticipationActive(tx, s.participationId)
    let { plan, debts } = await planForInTx(tx, planInputOf(s))
    const declaration = currentSettlementDeclaration()
    const valid = await tx.settlementSignature.findFirst({
      where: { settlementId, status: "VALID" },
      select: { id: true, snapshot: { select: snapshotSelect } },
    })
    if (valid) {
      const current = canonicalHash(materialOf(s, plan, declaration.version))
      if (valid.snapshot.materialHash === current) return valid.snapshot
      await bumpSettlementVersionInTx(
        tx,
        actor,
        s,
        "El resumen firmado ya no corresponde a la liquidación (cambiaron las deudas o la declaración)",
        {},
        ctx
      )
      s = await lockSettlement(tx, settlementId)
      ;({ plan, debts } = await planForInTx(tx, planInputOf(s)))
    }
    const content = snapshotContentFor(s, plan, debts)
    const contentHash = canonicalHash(content)
    const existing = await tx.settlementSignatureSnapshot.findUnique({
      where: { settlementId_contentHash: { settlementId, contentHash } },
      select: { ...snapshotSelect, signature: { select: { id: true } } },
    })
    if (existing && !existing.signature) return existing
    if (existing)
      throw new ConflictError(
        "Este resumen ya fue firmado y no se reutiliza. Recarga para preparar uno nuevo."
      )
    const preparedAt = new Date()
    const created = await tx.settlementSignatureSnapshot.create({
      data: {
        settlementId,
        playerId: s.playerId,
        settlementVersion: s.version,
        content: content as unknown as Prisma.InputJsonValue,
        declarationText: content.declarationText,
        declarationVersion: content.declarationVersion,
        preparedAt,
        preparedById: actor.id,
        contentHash,
        materialHash: canonicalHash(materialFromContent(content)),
        payloadHash: canonicalHash(payloadOf(content, preparedAt, actor.id)),
      },
      select: snapshotSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_SUMMARY_PREPARED,
        entityType: "SettlementSignatureSnapshot",
        entityId: created.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          settlementId,
          folio: s.folio,
          playerId: s.playerId,
          sessionId: s.sessionId,
          snapshotDigest: created.payloadHash,
          settlementVersion: s.version,
          returned: content.returnedNominalAmount,
          offsetDecision: content.offsetDecision,
          offset: content.offsetAmount,
          net: content.netPayoutAmount,
          declarationVersion: content.declarationVersion,
        },
      },
      tx
    )
    return created
  }, SETTLEMENT_TX)
  return {
    ...(await getSettlementSignatureStatus(settlementId)),
    summary: snapshotView(snapshot),
  }
}

// ── Estado ────────────────────────────────────────────────────────────

const user = { select: { id: true, name: true } } as const

export async function getSettlementSignatureStatus(settlementId: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      status: true,
      signatureId: true,
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
    },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  const valid = s.signatures.find((x) => x.status === "VALID") ?? null
  let current = false
  if (valid) {
    if (s.signatureId === valid.id) current = true
    else if (s.status === "DRAFT" || s.status === "READY_FOR_CONFIRMATION") {
      const core = await prisma.playerSettlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: {
          id: true,
          version: true,
          playerId: true,
          participationId: true,
          returnedNominalAmount: true,
          offsetDecision: true,
          requestedOffsetAmount: true,
        },
      })
      try {
        const { plan } = await planForInTx(prisma, planInputOf(core))
        current =
          canonicalHash(
            materialOf(core, plan, currentSettlementDeclaration().version)
          ) === valid.snapshot.materialHash
      } catch {
        current = false
      }
    }
  }
  return {
    settlementId,
    settlementStatus: s.status,
    /** TODA liquidación requiere firma (incluso con $0 devueltos). */
    required: true,
    validSignature: valid
      ? {
          id: valid.id,
          signedAt: valid.signedAt.toISOString(),
          capturedBy: valid.capturedBy,
          snapshotHash: valid.snapshot.payloadHash,
          /** Coincide con el plan vigente (o es la usada en la recepción). */
          current,
          summary: snapshotView(valid.snapshot),
        }
      : null,
    confirmedSignatureId: s.signatureId,
    history: s.signatures.map((x) => ({
      id: x.id,
      status: x.status,
      signedAt: x.signedAt.toISOString(),
      capturedBy: x.capturedBy,
      invalidatedAt: x.invalidatedAt?.toISOString() ?? null,
      invalidatedBy: x.invalidatedBy,
      invalidationReason: x.invalidationReason,
      snapshotHash: x.snapshot.payloadHash,
      settlementVersion: x.snapshot.settlementVersion,
    })),
  }
}
export type SettlementSignatureStatusView = Awaited<
  ReturnType<typeof getSettlementSignatureStatus>
>

// ── Capturar ─────────────────────────────────────────────────────────

/**
 * Registra la firma del jugador (trazos) para el resumen preparado. El
 * servidor genera el PNG, lo guarda en privado y, con la liquidación
 * bloqueada, verifica que el resumen siga vigente. Deja la liquidación en
 * READY_FOR_CONFIRMATION; no recibe fichas ni mueve dinero.
 */
export async function captureSettlementSignature(
  actor: SessionUser,
  settlementId: string,
  input: {
    snapshotId: string
    payloadHash: string
    strokes: Strokes
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const replay = async () => {
    const r = await prisma.settlementSignature.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, settlementId: true, snapshotId: true },
    })
    if (
      r &&
      (r.settlementId !== settlementId || r.snapshotId !== input.snapshotId)
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra firma"
      )
    return r
  }
  const previous = await replay()
  if (previous) return { signatureId: previous.id, replayed: true }
  const sessionId = await settlementSession(settlementId)

  let png: Buffer
  try {
    assertMeaningfulSignature(input.strokes)
    png = renderSignaturePng(input.strokes)
    if (inspectSignaturePng(png).ink < 150)
      throw new Error("Debes registrar tu firma para continuar.")
  } catch (e) {
    await recordAudit({
      action: AUDIT_ACTIONS.SETTLEMENT_SIGNATURE_REJECTED,
      entityType: "PlayerSettlement",
      entityId: settlementId,
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
    purpose: "SETTLEMENT_SIGNATURE",
    createdById: actor.id,
  })
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockOpenSession(
        tx,
        sessionId,
        "La sesión debe estar abierta para firmar."
      )
      const s = await lockSettlement(tx, settlementId)
      const again = await tx.settlementSignature.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
      assertSignable(s)
      const snapshot = await tx.settlementSignatureSnapshot.findFirst({
        where: { id: input.snapshotId, settlementId },
        select: { ...snapshotSelect, signature: { select: { id: true } } },
      })
      if (!snapshot) throw new NotFoundError("Resumen de firma no encontrado")
      // El jugador firma lo que el servidor preparó (no algo armado en el navegador).
      if (
        snapshot.payloadHash !== input.payloadHash ||
        !settlementSnapshotIntact(snapshot)
      )
        throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.stale)
      if (snapshot.signature)
        throw new ConflictError(
          "Este resumen ya fue firmado: una firma no se reutiliza. Prepara uno nuevo."
        )
      if (snapshot.settlementVersion !== s.version)
        throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.stale)
      const { plan } = await planForInTx(tx, planInputOf(s))
      if (
        canonicalHash(
          materialOf(s, plan, currentSettlementDeclaration().version)
        ) !== snapshot.materialHash
      )
        throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.stale)
      const valid = await tx.settlementSignature.findFirst({
        where: { settlementId, status: "VALID" },
        select: { id: true },
      })
      if (valid)
        throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.alreadySigned)
      await assertParticipationActive(tx, s.participationId)
      await promoteStoredFileInTx(tx, file.id, { settlementId })
      const created = await tx.settlementSignature.create({
        data: {
          settlementId,
          playerId: s.playerId,
          snapshotId: snapshot.id,
          fileId: file.id,
          imageHash: file.sha256,
          signedAt: new Date(),
          capturedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      if (s.status === "DRAFT") {
        const { count } = await tx.playerSettlement.updateMany({
          where: { id: s.id, status: "DRAFT", version: s.version },
          data: { status: "READY_FOR_CONFIRMATION" },
        })
        if (count !== 1)
          throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.stale)
        await recordSettlementStatus(
          tx,
          s.id,
          "DRAFT",
          "READY_FOR_CONFIRMATION",
          actor.id,
          "Firma del jugador registrada"
        )
      }
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_SIGNATURE_CAPTURED,
          entityType: "SettlementSignature",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            settlementId,
            folio: s.folio,
            playerId: s.playerId,
            sessionId: s.sessionId,
            snapshotId: snapshot.id,
            snapshotDigest: snapshot.payloadHash,
            evidenceFileId: file.id,
            imageDigest: file.sha256,
            returned: fmt(dec(s.returnedNominalAmount)),
            net: fmt(plan.net),
            note: "Firma capturada en el dispositivo del operador; la recepción de fichas aún no se confirma.",
          },
        },
        tx
      )
      return { id: created.id, replayed: false }
    }, SETTLEMENT_TX)
    if (result.replayed) await discardStagedFile(file.id, "replay")
    return { signatureId: result.id, replayed: result.replayed }
  } catch (error) {
    await discardStagedFile(file.id, "transaction-failed")
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { signatureId: again.id, replayed: true }
      throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.alreadySigned)
    }
    throw error
  }
}

// ── Verificación para la recepción ───────────────────────────────────

/**
 * Llamado DENTRO de la transacción de recepción (liquidación bloqueada):
 * bloquea la firma VALID y comprueba jugador, versión, integridad del
 * snapshot y de la imagen. Devuelve la parte material firmada para que la
 * recepción la compare con el plan recalculado.
 */
export async function findValidSettlementSignatureInTx(
  tx: Tx,
  lookup: { settlementId: string; playerId: string; version: number }
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "settlement_signatures"
    WHERE "settlementId" = ${lookup.settlementId} AND "status" = 'VALID' FOR UPDATE
  `
  if (rows.length === 0) return null
  const sig = await tx.settlementSignature.findUniqueOrThrow({
    where: { id: rows[0].id },
    select: {
      id: true,
      playerId: true,
      imageHash: true,
      fileId: true,
      file: { select: { status: true, sha256: true, settlementId: true } },
      snapshot: { select: snapshotSelect },
    },
  })
  if (
    sig.playerId !== lookup.playerId ||
    sig.snapshot.playerId !== lookup.playerId
  )
    throw new BusinessRuleError(
      "La firma no corresponde al jugador de la liquidación."
    )
  if (!settlementSnapshotIntact(sig.snapshot))
    throw new BusinessRuleError(
      "El resumen firmado no supera la verificación de integridad."
    )
  if (sig.snapshot.settlementVersion !== lookup.version)
    throw new ConflictError(SETTLEMENT_SIGNATURE_MESSAGES.stale)
  if (
    sig.file.status !== "ACTIVE" ||
    sig.file.sha256 !== sig.imageHash ||
    sig.file.settlementId !== lookup.settlementId
  )
    throw new BusinessRuleError("La evidencia de la firma no está disponible.")
  const evidence = await readEvidence(sig.fileId)
  if (!evidence || sha256Hex(evidence.bytes) !== sig.imageHash)
    throw new BusinessRuleError("La evidencia de la firma no está disponible.")
  return {
    signatureId: sig.id,
    materialHash: sig.snapshot.materialHash,
    snapshotDigest: sig.snapshot.payloadHash,
    content: sig.snapshot.content as unknown as SettlementSnapshotContent,
  }
}

// ── Evidencia privada ────────────────────────────────────────────────

export async function getSettlementSignatureEvidence(
  actor: SessionUser,
  settlementId: string,
  signatureId: string | null,
  ctx: RequestContext = {}
) {
  const sig = await prisma.settlementSignature.findFirst({
    where: signatureId
      ? { id: signatureId, settlementId }
      : {
          settlementId,
          OR: [{ status: "VALID" }, { confirmedSettlement: { isNot: null } }],
        },
    orderBy: { signedAt: "desc" },
    select: { id: true, fileId: true, status: true, imageHash: true },
  })
  if (!sig) throw new NotFoundError("Firma no encontrada")
  const evidence = await readEvidence(sig.fileId)
  if (!evidence || evidence.sha256 !== sig.imageHash)
    throw new NotFoundError("Evidencia no disponible")
  await recordAudit({
    action: AUDIT_ACTIONS.SETTLEMENT_SIGNATURE_EVIDENCE_VIEWED,
    entityType: "SettlementSignature",
    entityId: sig.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { settlementId, status: sig.status },
  })
  return { bytes: evidence.bytes, mimeType: evidence.mimeType }
}
