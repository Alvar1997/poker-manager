import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
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
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  applyChipSettlementOffsetInTx,
  lockPlayerInTx,
  receivablesOf,
  reverseSettlementOffsetsInTx,
} from "@/modules/credits/receivable.service"
import {
  readNominal,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import {
  confirmNominalChipDeliveryInTx,
  confirmNominalChipReturnInTx,
  reserveNominalAmountInTx,
} from "@/modules/inventory/reservation.service"
import {
  activeSettlementOf,
  completeParticipationFromSettlementInTx,
  markParticipationSettlingInTx,
} from "@/modules/session-tables/participation.service"
import {
  lockOpenSession,
  lockSessionTable,
} from "@/modules/session-tables/session-table.service"
import { issueFolio } from "@/modules/settings/folio.service"
import {
  ADMINISTRATIVE_FLOW_MESSAGE,
  hasBankingGameInSession,
} from "@/modules/purchases/purchase.service"
import {
  bumpSettlementVersionInTx,
  dec,
  fmt,
  invalidateSettlementSignaturesInTx,
  lockPayable,
  lockSettlement,
  materialOf,
  planForInTx,
  planInputOf,
  recordSettlementStatus,
  refreshPayableInTx,
  SETTLEMENT_STALE_MESSAGE,
  SETTLEMENT_TX,
  settlementVerifier,
  type Db,
  type Tx,
} from "@/modules/settlements/settlement-core"
import { currentSettlementDeclaration } from "@/modules/settlements/settlement.declaration"
import { payableState } from "@/modules/settlements/settlement.math"
import {
  executeCashPayoutInTx,
  payoutView,
} from "@/modules/settlements/settlement-payout.service"
import {
  createSettlementReceiptInTx,
  voidSettlementReceiptsInTx,
} from "@/modules/settlements/settlement-receipt.service"
import { findValidSettlementSignatureInTx } from "@/modules/settlements/settlement-signature.service"
import type {
  ConfirmReturnInput,
  CreateSettlementInput,
  ReverseSettlementInput,
  SettlementsQuery,
  UpdateSettlementDraftInput,
} from "@/modules/settlements/settlement.schemas"

/**
 * Liquidaciones de jugadores (Módulo 11).
 *
 * Flujo: participación ACTIVE final → borrador (valor NOMINAL devuelto, sin
 * denominaciones, puede ser $0; decisión EXPLÍCITA de compensar) → resumen
 * firmado por el jugador (SIEMPRE) → el cajero confirma la recepción física
 * → (en una transacción) entrada nominal al inventario compartido una sola
 * vez si > 0, compensación FIFO del Módulo 10 solo por el importe decidido,
 * cuenta por pagar por el neto, pago inmediato opcional en efectivo,
 * participación SETTLING/SETTLED, comprobante digital y auditoría.
 *
 * - La compensación NO es obligatoria: NO_COMPENSATE conserva la deuda; la
 *   distribución, cuando hay compensación, es FIFO y no editable.
 * - Un borrador no tiene efectos: no toca inventario, deudas ni dinero.
 * - El plan se recalcula dentro de la transacción; si ya no coincide con lo
 *   firmado, la recepción se bloquea y se exige una nueva firma.
 * - La recepción confirmada es inmutable (trigger); se corrige con reverso.
 */

const user = { select: { id: true, name: true } } as const

async function participationHead(participationId: string) {
  const p = await prisma.tableParticipation.findUnique({
    where: { id: participationId },
    select: { sessionId: true, sessionTableId: true },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  return p
}

async function settlementHead(id: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id },
    select: { sessionId: true, sessionTableId: true, idempotencyKey: true },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  return s
}

async function assertWithinCirculation(db: Db, returned: Prisma.Decimal) {
  const nominal = await readNominal(db, await sharedChipSetId(db))
  if (returned.greaterThan(nominal.circulation))
    throw new BusinessRuleError(
      `El valor devuelto excede las fichas en circulación (${fmt(nominal.circulation)}). Revisa el importe.`
    )
}

async function lockParticipation(tx: Tx, participationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${participationId} FOR UPDATE`
  return tx.tableParticipation.findUniqueOrThrow({
    where: { id: participationId },
    select: {
      id: true,
      status: true,
      playerId: true,
      sessionId: true,
      sessionTableId: true,
      cycleId: true,
      sessionTable: { select: { tableId: true } },
    },
  })
}

// ── Vista previa ──────────────────────────────────────────────────────

function previewView(
  plan: Awaited<ReturnType<typeof planForInTx>>["plan"],
  debts: Awaited<ReturnType<typeof planForInTx>>["debts"]
) {
  return {
    returnedNominalAmount: fmt(plan.returned),
    outstandingDebt: fmt(plan.outstanding),
    offsetDecision: plan.decision,
    offsetAmount: fmt(plan.offset),
    allocations: plan.allocations.map((a) => {
      const d = debts.get(a.receivableId)
      return {
        receivableId: a.receivableId,
        order: a.order,
        purchaseFolio: d?.purchaseFolio ?? "",
        sessionFolio: d?.sessionFolio ?? "",
        tableName: d?.tableName ?? "",
        createdAt: d?.createdAt.toISOString() ?? null,
        amount: fmt(a.amount),
        balanceBefore: fmt(a.balanceBefore),
        balanceAfter: fmt(a.balanceAfter),
      }
    }),
    netPayoutAmount: fmt(plan.net),
    remainingDebt: fmt(plan.remainingDebt),
  }
}
export type SettlementPreview = ReturnType<typeof previewView>

/** Vista previa INFORMATIVA (el servidor recalcula al confirmar). */
export async function previewDraft(input: {
  participationId: string
  returnedNominalAmount: string
  offsetDecision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
  offsetAmount?: string
}) {
  const p = await prisma.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: { playerId: true },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  try {
    const { plan, debts } = await planForInTx(prisma, {
      playerId: p.playerId,
      returned: dec(input.returnedNominalAmount),
      decision: input.offsetDecision,
      requested: input.offsetAmount ? dec(input.offsetAmount) : null,
    })
    return { valid: true as const, ...previewView(plan, debts) }
  } catch (e) {
    if (e instanceof BusinessRuleError)
      return { valid: false as const, message: e.message }
    throw e
  }
}

export async function previewSettlement(id: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id },
    select: {
      playerId: true,
      returnedNominalAmount: true,
      offsetDecision: true,
      requestedOffsetAmount: true,
    },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  try {
    const { plan, debts } = await planForInTx(prisma, planInputOf(s))
    return { valid: true as const, ...previewView(plan, debts) }
  } catch (e) {
    if (e instanceof BusinessRuleError)
      return { valid: false as const, message: e.message }
    throw e
  }
}

/** Contexto para iniciar una liquidación desde un jugador activo. */
export async function getSettlementContext(participationId: string) {
  const p = await prisma.tableParticipation.findUnique({
    where: { id: participationId },
    select: {
      id: true,
      status: true,
      player: { select: { id: true, name: true, nickname: true } },
      session: { select: { id: true, folio: true, status: true } },
      sessionTable: {
        select: {
          status: true,
          table: { select: { id: true, name: true } },
        },
      },
      cycle: { select: { cycleNumber: true, status: true } },
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  const [active, pendingPurchases, preview] = await Promise.all([
    activeSettlementOf(prisma, p.id),
    prisma.chipPurchase.findMany({
      where: {
        participationId: p.id,
        status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
      },
      select: { id: true, folio: true },
    }),
    planForInTx(prisma, {
      playerId: p.player.id,
      returned: dec(0),
      decision: "NO_COMPENSATE",
      requested: null,
    }),
  ])
  const receivables = await prisma.playerDebt.findMany({
    where: { id: { in: [...preview.debts.keys()] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      originalAmount: true,
      session: { select: { folio: true } },
      purchase: { select: { folio: true, table: { select: { name: true } } } },
      authorization: { select: { partnerNameSnapshot: true } },
    },
  })
  const balances = new Map(
    (await receivablesOf(prisma, p.player.id)).map((r) => [r.id, r])
  )
  // Compras confirmadas del jugador en la SESIÓN (todas las mesas): base del
  // resultado individual (devuelto − comprado), que NO es un faltante.
  const bought = await prisma.chipPurchase.aggregate({
    where: {
      sessionId: p.session.id,
      playerId: p.player.id,
      status: "CONFIRMED",
    },
    _sum: { nominalAmount: true },
    _count: { _all: true },
  })
  // Crédito originado por las compras de la SESIÓN (deudas de su origen).
  const sessionCredit = await prisma.playerDebt.aggregate({
    where: { sessionId: p.session.id, playerId: p.player.id },
    _sum: { originalAmount: true },
  })
  const boughtNominal = dec(bought._sum.nominalAmount ?? 0)
  const creditNominal = dec(sessionCredit._sum.originalAmount ?? 0)
  return {
    purchasedInSession: {
      nominal: fmt(boughtNominal),
      count: bought._count._all,
      /** Comprado a crédito en esta sesión (deuda original). */
      credit: fmt(creditNominal),
      /** Cubierto con pagos (efectivo, terminal, transferencias). */
      paid: fmt(boughtNominal.sub(creditNominal)),
    },
    participation: {
      id: p.id,
      status: p.status,
      player: p.player,
      session: p.session,
      table: p.sessionTable.table,
      tableStatus: p.sessionTable.status,
      cycleNumber: p.cycle.cycleNumber,
    },
    activeSettlement: active,
    pendingPurchases,
    outstandingDebt: fmt(preview.plan.outstanding),
    debts: receivables.map((d) => {
      const b = balances.get(d.id)
      return {
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        purchaseFolio: d.purchase.folio,
        tableName: d.purchase.table.name,
        sessionFolio: d.session.folio,
        partnerName: d.authorization.partnerNameSnapshot,
        originalAmount: fmt(dec(d.originalAmount)),
        appliedAmount: fmt(b?.applied ?? dec(0)),
        balance: fmt(b?.balance ?? dec(0)),
      }
    }),
  }
}
export type SettlementContext = Awaited<ReturnType<typeof getSettlementContext>>

// ── Crear ─────────────────────────────────────────────────────────────

/**
 * Inicia la liquidación (DRAFT) de la participación ACTIVE final. No exige
 * que el jugador no tenga deudas ni que haya comprado en esta mesa; no
 * mueve inventario, deudas ni dinero y no cierra la participación.
 */
export async function createSettlement(
  actor: SessionUser,
  input: CreateSettlementInput,
  ctx: RequestContext = {}
) {
  const returned = dec(input.returnedNominalAmount)
  const requested = input.offsetAmount ? dec(input.offsetAmount) : null
  const replay = async () => {
    const r = await prisma.playerSettlement.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, participationId: true, returnedNominalAmount: true },
    })
    if (
      r &&
      (r.participationId !== input.participationId ||
        !dec(r.returnedNominalAmount).equals(returned))
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra liquidación"
      )
    return r
  }
  const previous = await replay()
  if (previous) return { settlementId: previous.id, replayed: true }
  const head = await participationHead(input.participationId)
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await lockOpenSession(
        tx,
        head.sessionId,
        "La sesión debe estar abierta para liquidar jugadores."
      )
      // Mesa bloqueada: una compra nueva o un cierre simultáneo esperan.
      const table = await lockSessionTable(tx, head.sessionTableId)
      const p = await lockParticipation(tx, input.participationId)
      const again = await tx.playerSettlement.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { settlementId: again.id, replayed: true }
      if (table.status !== "OPEN" || table.cycles[0]?.id !== p.cycleId)
        throw new BusinessRuleError(
          "La mesa debe estar abierta en su ciclo vigente."
        )
      if (p.status !== "ACTIVE")
        throw new BusinessRuleError(
          "Solo se liquida una participación activa (el jugador ya no está en la mesa)."
        )
      const live = await activeSettlementOf(tx, p.id)
      if (live)
        throw new ConflictError(
          `El jugador ya tiene la liquidación ${live.folio} en curso.`
        )
      // Módulo 17: una jugada financiada por la casa NO se liquida pagando
      // el valor devuelto: su salida se concilia en la sección privada.
      if (await hasBankingGameInSession(tx, p.playerId, p.sessionId))
        throw new BusinessRuleError(ADMINISTRATIVE_FLOW_MESSAGE)
      const pending = await tx.chipPurchase.findFirst({
        where: {
          participationId: p.id,
          status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
        },
        select: { folio: true },
      })
      if (pending)
        throw new BusinessRuleError(
          `El jugador tiene la compra ${pending.folio} sin entregar: confírmala o cancélala antes de liquidar.`
        )
      await assertWithinCirculation(tx, returned)
      const { plan } = await planForInTx(tx, {
        playerId: p.playerId,
        returned,
        decision: input.offsetDecision,
        requested,
      })
      const folio = await issueFolio(tx, "SETTLEMENT")
      const created = await tx.playerSettlement.create({
        data: {
          folio,
          sessionId: p.sessionId,
          sessionTableId: p.sessionTableId,
          cycleId: p.cycleId,
          participationId: p.id,
          playerId: p.playerId,
          tableId: p.sessionTable.tableId,
          returnedNominalAmount: returned,
          offsetDecision: input.offsetDecision,
          requestedOffsetAmount: requested,
          exitKind: input.exitKind ?? (returned.isZero() ? "OUT" : "CASHOUT"),
          notes: input.notes ?? null,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordSettlementStatus(tx, created.id, null, "DRAFT", actor.id)
      const meta = {
        folio,
        playerId: p.playerId,
        sessionId: p.sessionId,
        sessionFolio: session.folio,
        table: table.table.name,
        tableId: p.sessionTable.tableId,
        participationId: p.id,
        returned: fmt(returned),
      }
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_CREATED,
          entityType: "PlayerSettlement",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { ...meta, status: "DRAFT" },
        },
        tx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_OFFSET_DECIDED,
          entityType: "PlayerSettlement",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            ...meta,
            decision: input.offsetDecision,
            requested: requested ? fmt(requested) : null,
            plannedOffset: fmt(plan.offset),
            outstandingDebt: fmt(plan.outstanding),
            note: "Decisión explícita del cajero; la vista previa se recalcula al confirmar.",
          },
        },
        tx
      )
      return { settlementId: created.id, replayed: false }
    }, SETTLEMENT_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { settlementId: again.id, replayed: true }
      throw new ConflictError(
        "El jugador ya tiene una liquidación en curso (otra solicitud la creó al mismo tiempo)."
      )
    }
    throw error
  }
}

// ── Editar borrador ───────────────────────────────────────────────────

/**
 * Cambia importe devuelto, decisión o importe a compensar. Todo cambio
 * material sube la versión, INVALIDA la firma anterior (se conserva) y
 * regresa a DRAFT: hay que firmar de nuevo.
 */
export async function updateSettlementDraft(
  actor: SessionUser,
  id: string,
  input: UpdateSettlementDraftInput,
  ctx: RequestContext = {}
) {
  const head = await settlementHead(id)
  await prisma.$transaction(async (tx) => {
    await lockOpenSession(
      tx,
      head.sessionId,
      "La sesión debe estar abierta para editar la liquidación."
    )
    const s = await lockSettlement(tx, id)
    if (s.status !== "DRAFT" && s.status !== "READY_FOR_CONFIRMATION")
      throw new BusinessRuleError(
        "Solo un borrador se edita: la recepción ya se confirmó o la liquidación terminó."
      )
    if (s.version !== input.expectedVersion)
      throw new ConflictError(
        "La liquidación cambió desde que la revisaste. Recarga e intenta de nuevo."
      )
    const decision = input.offsetDecision ?? s.offsetDecision
    const returned =
      input.returnedNominalAmount !== undefined
        ? dec(input.returnedNominalAmount)
        : dec(s.returnedNominalAmount)
    const requested =
      decision !== "PARTIAL"
        ? null
        : input.offsetAmount !== undefined && input.offsetAmount !== null
          ? dec(input.offsetAmount)
          : s.requestedOffsetAmount
            ? dec(s.requestedOffsetAmount)
            : null
    const material =
      !returned.equals(dec(s.returnedNominalAmount)) ||
      decision !== s.offsetDecision ||
      !(requested ?? dec(-1)).equals(
        s.requestedOffsetAmount ? dec(s.requestedOffsetAmount) : dec(-1)
      )
    const { plan } = await planForInTx(tx, {
      playerId: s.playerId,
      returned,
      decision,
      requested,
    })
    await assertWithinCirculation(tx, returned)
    if (material) {
      await bumpSettlementVersionInTx(
        tx,
        actor,
        s,
        "Cambio en la liquidación antes de recibir las fichas",
        {
          returnedNominalAmount: returned,
          offsetDecision: decision,
          requestedOffsetAmount: requested,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
        ctx
      )
    } else if (input.notes !== undefined) {
      await tx.playerSettlement.update({
        where: { id },
        data: { notes: input.notes },
      })
    }
    const meta = {
      folio: s.folio,
      playerId: s.playerId,
      sessionId: s.sessionId,
      participationId: s.participationId,
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_UPDATED_DRAFT,
        entityType: "PlayerSettlement",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          ...meta,
          changes: {
            returned: {
              from: fmt(dec(s.returnedNominalAmount)),
              to: fmt(returned),
            },
            decision: { from: s.offsetDecision, to: decision },
            requested: {
              from: s.requestedOffsetAmount
                ? fmt(dec(s.requestedOffsetAmount))
                : null,
              to: requested ? fmt(requested) : null,
            },
          },
          versionFrom: s.version,
          versionTo: material ? s.version + 1 : s.version,
          signatureInvalidated:
            material && s.status === "READY_FOR_CONFIRMATION",
        },
      },
      tx
    )
    if (decision !== s.offsetDecision || material)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_OFFSET_DECIDED,
          entityType: "PlayerSettlement",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            ...meta,
            decision,
            requested: requested ? fmt(requested) : null,
            plannedOffset: fmt(plan.offset),
            outstandingDebt: fmt(plan.outstanding),
          },
        },
        tx
      )
  }, SETTLEMENT_TX)
  return getSettlement(id)
}

// ── Cancelar ──────────────────────────────────────────────────────────

/** Cancela un borrador (sin efectos que revertir). La firma queda CANCELLED. */
export async function cancelSettlement(
  actor: SessionUser,
  id: string,
  input: { reason: string },
  ctx: RequestContext = {}
) {
  await settlementHead(id)
  await prisma.$transaction(async (tx) => {
    const s = await lockSettlement(tx, id)
    if (s.status === "CANCELLED") return
    if (s.status !== "DRAFT" && s.status !== "READY_FOR_CONFIRMATION")
      throw new BusinessRuleError(
        "La recepción ya se confirmó: una liquidación con efectos no se cancela (requiere reverso)."
      )
    await invalidateSettlementSignaturesInTx(
      tx,
      {
        settlementId: id,
        actorId: actor.id,
        reason: `Liquidación cancelada: ${input.reason}`,
        status: "CANCELLED",
      },
      ctx
    )
    const { count } = await tx.playerSettlement.updateMany({
      where: { id, status: s.status },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: input.reason,
      },
    })
    if (count !== 1) throw new ConflictError("La liquidación cambió de estado.")
    await recordSettlementStatus(
      tx,
      id,
      s.status,
      "CANCELLED",
      actor.id,
      input.reason
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_CANCELLED,
        entityType: "PlayerSettlement",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: s.folio,
          playerId: s.playerId,
          sessionId: s.sessionId,
          participationId: s.participationId,
          from: s.status,
          to: "CANCELLED",
          reason: input.reason,
        },
      },
      tx
    )
  }, SETTLEMENT_TX)
  return getSettlement(id)
}

// ── Confirmar la recepción ────────────────────────────────────────────

/**
 * El cajero confirma que RECIBIÓ físicamente las fichas (después de la
 * firma). Todo ocurre en UNA transacción; un reintento con la misma clave
 * devuelve el mismo resultado sin duplicar inventario, compensaciones,
 * cuentas por pagar ni pagos.
 */
export async function confirmReturn(
  actor: SessionUser,
  id: string,
  input: ConfirmReturnInput,
  ctx: RequestContext = {}
) {
  const head = await settlementHead(id)
  const replayed = async () => {
    const r = await prisma.playerSettlement.findUnique({
      where: { confirmIdempotencyKey: input.idempotencyKey },
      select: { id: true },
    })
    if (r && r.id !== id)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra liquidación"
      )
    return Boolean(r)
  }
  if (await replayed())
    return { settlement: await getSettlement(id), replayed: true }
  const immediate = input.immediateCashAmount
    ? dec(input.immediateCashAmount)
    : null
  try {
    const wasReplay = await prisma.$transaction(async (tx) => {
      // 1–2. Sesión operativa y liquidación bloqueadas.
      const session = await lockOpenSession(
        tx,
        head.sessionId,
        "La sesión debe estar abierta para recibir fichas."
      )
      const s = await lockSettlement(tx, id)
      if (s.confirmIdempotencyKey === input.idempotencyKey) return true
      if (s.status === "PENDING_PAYOUT" || s.status === "COMPLETED")
        throw new ConflictError(
          "La recepción de esta liquidación ya se confirmó."
        )
      if (s.status === "DRAFT")
        throw new BusinessRuleError(
          "Falta la firma del jugador: toda liquidación requiere firma, incluso con $0 devueltos."
        )
      if (s.status !== "READY_FOR_CONFIRMATION")
        throw new BusinessRuleError("Esta liquidación ya no admite recepción.")
      if (s.version !== input.expectedVersion)
        throw new ConflictError(
          "La liquidación cambió desde que revisaste el resumen. Revísalo de nuevo."
        )
      // Retorno CERO solo con confirmación EXPRESA: ningún jugador se lleva
      // fichas y la ausencia de fichas nunca se asume.
      if (
        dec(s.returnedNominalAmount).isZero() &&
        input.zeroReturnConfirmed !== true
      )
        throw new BusinessRuleError(
          "El jugador devuelve $0: confirma expresamente que terminó sin fichas y no conserva fichas de esta participación."
        )
      if (
        dec(s.returnedNominalAmount).greaterThan(0) &&
        input.chipsReceived !== true
      )
        throw new BusinessRuleError(
          "Confirma que recibiste físicamente las fichas del jugador."
        )
      // 3. Mesa y participación vigentes.
      const table = await lockSessionTable(tx, s.sessionTableId)
      if (table.status !== "OPEN" || table.cycles[0]?.id !== s.cycleId)
        throw new BusinessRuleError(
          "La mesa de esta liquidación ya no está abierta en el mismo ciclo."
        )
      const p = await lockParticipation(tx, s.participationId)
      if (p.status !== "ACTIVE")
        throw new BusinessRuleError("El jugador ya no está activo en la mesa.")
      // 4. Jugador bloqueado: serializa con abonos y otras compensaciones.
      await lockPlayerInTx(tx, s.playerId)
      // 5. Firma vigente, íntegra y de esta versión.
      const signature = await findValidSettlementSignatureInTx(tx, {
        settlementId: id,
        playerId: s.playerId,
        version: s.version,
      })
      if (!signature)
        throw new BusinessRuleError(
          "Falta la firma del jugador: toda liquidación requiere firma, incluso con $0 devueltos."
        )
      // 6. Plan recalculado con las deudas REALES de este momento. Si lo
      // decidido ya no es posible (p. ej. un abono redujo la deuda por
      // debajo de la compensación), también es un cambio respecto de lo firmado.
      let plan: Awaited<ReturnType<typeof planForInTx>>["plan"]
      try {
        ;({ plan } = await planForInTx(tx, planInputOf(s)))
      } catch (e) {
        if (e instanceof BusinessRuleError)
          throw new ConflictError(
            `${e.message} Edita la liquidación y solicita una nueva firma.`
          )
        throw e
      }
      if (
        canonicalHash(
          materialOf(s, plan, currentSettlementDeclaration().version)
        ) !== signature.materialHash
      )
        throw new ConflictError(SETTLEMENT_STALE_MESSAGE)
      if (immediate && immediate.greaterThan(plan.net))
        throw new BusinessRuleError(
          `El pago inmediato excede el pago neto de ${fmt(plan.net)}.`
        )
      const now = new Date()
      const auditBase = {
        folio: s.folio,
        playerId: s.playerId,
        sessionId: s.sessionId,
        sessionFolio: session.folio,
        table: s.table.name,
        tableId: s.tableId,
        participationId: s.participationId,
      }

      // 7. Entrada NOMINAL al inventario compartido, una sola vez (> 0).
      let chipReturnOperationId: string | null = null
      if (plan.returned.greaterThan(0)) {
        const op = await confirmNominalChipReturnInTx(
          tx,
          actor,
          {
            amount: plan.returned,
            referenceType: "PlayerSettlement",
            referenceId: id,
            tableId: s.tableId,
            sessionId: s.sessionId,
            playerId: s.playerId,
            idempotencyKey: `settlement-return-${id}`,
          },
          ctx
        )
        chipReturnOperationId = op.operationId
      }
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_CHIPS_RECEIVED,
          entityType: "PlayerSettlement",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            ...auditBase,
            returned: fmt(plan.returned),
            inventoryOperationId: chipReturnOperationId,
            note: plan.returned.isZero()
              ? "Devolución de $0: sin movimiento nominal artificial."
              : "Entrada nominal al inventario compartido (sin denominaciones).",
          },
        },
        tx
      )

      // 8. Compensación FIFO solo por el importe decidido (sin dinero).
      if (plan.offset.greaterThan(0)) {
        const applied = await applyChipSettlementOffsetInTx(
          tx,
          actor.id,
          { playerId: s.playerId, settlementId: id, amount: plan.offset },
          ctx
        )
        const same =
          applied.length === plan.allocations.length &&
          applied.every(
            (a, i) =>
              a.receivableId === plan.allocations[i].receivableId &&
              a.amount.equals(plan.allocations[i].amount)
          )
        if (!same) throw new ConflictError(SETTLEMENT_STALE_MESSAGE)
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SETTLEMENT_DEBT_OFFSET_APPLIED,
            entityType: "PlayerSettlement",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              ...auditBase,
              decision: plan.decision,
              offset: fmt(plan.offset),
              outstandingBefore: fmt(plan.outstanding),
              remainingDebt: fmt(plan.remainingDebt),
              allocations: applied.map((a) => ({
                receivableId: a.receivableId,
                order: a.order,
                amount: fmt(a.amount),
                balanceAfter: fmt(a.balanceAfter),
              })),
              note: "Compensación con fichas: no es ingreso de efectivo ni de banco.",
            },
          },
          tx
        )
      }

      // 9. Cuenta por pagar por el neto (puede ser $0: sin movimiento ficticio).
      const payable = await tx.settlementPayable.create({
        data: {
          settlementId: id,
          playerId: s.playerId,
          sourceSessionId: s.sessionId,
          originalAmount: plan.net,
          status: plan.net.isZero() ? "PAID" : "OPEN",
          paidAt: plan.net.isZero() ? now : null,
          createdById: actor.id,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_PAYABLE_CREATED,
          entityType: "SettlementPayable",
          entityId: payable.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { ...auditBase, settlementId: id, amount: fmt(plan.net) },
        },
        tx
      )

      // 10. Recepción registrada (lo firmado ya no se edita).
      const { count } = await tx.playerSettlement.updateMany({
        where: { id, status: "READY_FOR_CONFIRMATION", version: s.version },
        data: {
          status: "PENDING_PAYOUT",
          receivedAt: now,
          receivedById: actor.id,
          zeroReturnConfirmed: dec(s.returnedNominalAmount).isZero(),
          signatureId: signature.signatureId,
          debtBalanceSnapshot: plan.outstanding,
          offsetAmount: plan.offset,
          netPayoutAmount: plan.net,
          chipReturnOperationId,
          confirmIdempotencyKey: input.idempotencyKey,
        },
      })
      if (count !== 1)
        throw new ConflictError("La liquidación cambió de estado.")
      await recordSettlementStatus(
        tx,
        id,
        "READY_FOR_CONFIRMATION",
        "PENDING_PAYOUT",
        actor.id,
        "Recepción de fichas confirmada por el cajero"
      )

      // 11. Pago inmediato opcional (efectivo de la caja de la sesión).
      if (immediate) {
        await executeCashPayoutInTx(
          tx,
          actor,
          s,
          {
            payableId: payable.id,
            sequence: 1,
            amount: immediate,
            funding: {
              funding: "SESSION_CASH",
              sessionId: s.sessionId,
              custodianUserId: null,
            },
            notes: "Pago inmediato al confirmar la recepción",
            idempotencyKey: `settlement-immediate-${id}`,
          },
          ctx
        )
      }

      // 12. Participación: SETTLING (falta pagar) o SETTLED (liquidada).
      const state = await refreshPayableInTx(
        tx,
        actor,
        { ...s, status: "PENDING_PAYOUT" },
        ctx
      )
      if (state.status !== "PAID")
        await markParticipationSettlingInTx(
          tx,
          actor,
          { participationId: s.participationId, settlementId: id },
          settlementVerifier,
          ctx
        )

      // 13. Comprobante digital de recepción (snapshot inmutable).
      await createSettlementReceiptInTx(
        tx,
        actor,
        id,
        { kind: "RECEPTION" },
        ctx
      )
      return false
    }, SETTLEMENT_TX)
    return { settlement: await getSettlement(id), replayed: wasReplay }
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (await replayed())
        return { settlement: await getSettlement(id), replayed: true }
      throw new ConflictError(
        "Otra operación modificó esta liquidación al mismo tiempo. Recarga e intenta de nuevo."
      )
    }
    throw error
  }
}

// ── Reverso ───────────────────────────────────────────────────────────

/**
 * Reverso LEGÍTIMO de una recepción confirmada, solo si no hubo pagos
 * reales ni transferencias en trámite (si los hubo, requiere resolución
 * administrativa documentada) y con la sesión abierta. Contraasientos:
 * las compensaciones se revierten (la deuda vuelve), las fichas vuelven a
 * circulación SOLO si el cajero declara que se las regresó físicamente al
 * jugador, la cuenta por pagar se anula y el comprobante queda ANULADO.
 * Nada se borra. El jugador, si sigue jugando, se registra de nuevo.
 */
export async function reverseSettlement(
  actor: SessionUser,
  id: string,
  input: ReverseSettlementInput,
  ctx: RequestContext = {}
) {
  const head = await settlementHead(id)
  const previous = await prisma.settlementReversal.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { settlementId: true },
  })
  if (previous) {
    if (previous.settlementId !== id)
      throw new AppError("CONFLICT", "Clave de operación reutilizada")
    return { settlement: await getSettlement(id), replayed: true }
  }
  await prisma.$transaction(async (tx) => {
    await lockOpenSession(
      tx,
      head.sessionId,
      "La sesión de la liquidación ya no está abierta: el reverso requiere resolución administrativa documentada."
    )
    const s = await lockSettlement(tx, id)
    if (s.status !== "PENDING_PAYOUT" && s.status !== "COMPLETED")
      throw new BusinessRuleError(
        s.status === "REVERSED"
          ? "Esta liquidación ya fue revertida."
          : "Solo se revierte una liquidación con recepción confirmada (un borrador se cancela)."
      )
    const returned = dec(s.returnedNominalAmount)
    if (returned.greaterThan(0) && input.chipsHandedBack !== true)
      throw new BusinessRuleError(
        "Confirma que regresaste físicamente las fichas al jugador: si siguen bajo custodia, no se revierte."
      )
    await lockPlayerInTx(tx, s.playerId)
    // Módulo 16: una liquidación corregida ya tiene efectos nuevos
    // (obligaciones, contraasientos); el reverso simple los ignoraría.
    if (
      (await tx.settlementCorrection.count({ where: { settlementId: id } })) > 0
    )
      throw new BusinessRuleError(
        "Esta liquidación tiene correcciones ejecutadas (Módulo 16): el reverso automático no procede."
      )
    const { payable, state } = await lockPayable(tx, id)
    if (state.executed.greaterThan(0) || state.reserved.greaterThan(0))
      throw new BusinessRuleError(
        "Esta liquidación ya tiene pagos reales o transferencias en trámite: el reverso automático no procede y requiere resolución administrativa documentada."
      )
    let chipOperationId: string | null = null
    if (returned.greaterThan(0)) {
      const reservation = await reserveNominalAmountInTx(
        tx,
        actor,
        {
          amount: returned,
          referenceType: "SettlementReversal",
          referenceId: id,
          tableId: s.tableId,
          sessionId: s.sessionId,
          playerId: s.playerId,
          expiresAt: new Date(Date.now() + 5 * 60_000),
          idempotencyKey: `settlement-reversal-reserve-${id}`,
        },
        ctx
      )
      const op = await confirmNominalChipDeliveryInTx(
        tx,
        actor,
        reservation.id,
        `settlement-reversal-delivery-${id}`,
        ctx
      )
      chipOperationId = op.operationId
    }
    const restored = await reverseSettlementOffsetsInTx(tx, actor.id, id)
    await tx.settlementPayable.update({
      where: { id: payable.id },
      data: { status: "VOIDED", voidedAt: new Date() },
    })
    await tx.settlementReversal.create({
      data: {
        settlementId: id,
        reason: input.reason,
        chipOperationId,
        createdById: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
    })
    const { count } = await tx.playerSettlement.updateMany({
      where: { id, status: s.status },
      data: { status: "REVERSED", reversedAt: new Date() },
    })
    if (count !== 1) throw new ConflictError("La liquidación cambió de estado.")
    await recordSettlementStatus(
      tx,
      id,
      s.status,
      "REVERSED",
      actor.id,
      input.reason
    )
    await voidSettlementReceiptsInTx(
      tx,
      id,
      `Liquidación revertida: ${input.reason}`
    )
    const participation = await tx.tableParticipation.findUniqueOrThrow({
      where: { id: s.participationId },
      select: { status: true },
    })
    if (participation.status === "SETTLING")
      await completeParticipationFromSettlementInTx(
        tx,
        actor,
        { participationId: s.participationId, settlementId: id },
        settlementVerifier,
        ctx
      )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_REVERSED,
        entityType: "PlayerSettlement",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: s.folio,
          playerId: s.playerId,
          sessionId: s.sessionId,
          participationId: s.participationId,
          from: s.status,
          to: "REVERSED",
          reason: input.reason,
          chipsBackToCirculation: fmt(returned),
          inventoryOperationId: chipOperationId,
          offsetsRestored: restored.map((r) => ({
            receivableId: r.receivableId,
            amount: fmt(r.amount),
          })),
          payableVoided: fmt(state.original),
          note: "Sin pagos reales: no se inventa ninguna devolución de dinero.",
        },
      },
      tx
    )
  }, SETTLEMENT_TX)
  return { settlement: await getSettlement(id), replayed: false }
}

// ── Consultas ─────────────────────────────────────────────────────────

const detailSelect = {
  id: true,
  folio: true,
  status: true,
  version: true,
  sessionId: true,
  participationId: true,
  returnedNominalAmount: true,
  exitKind: true,
  zeroReturnConfirmed: true,
  offsetDecision: true,
  requestedOffsetAmount: true,
  debtBalanceSnapshot: true,
  offsetAmount: true,
  netPayoutAmount: true,
  chipReturnOperationId: true,
  signatureId: true,
  notes: true,
  createdAt: true,
  receivedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  reversedAt: true,
  player: { select: { id: true, name: true, nickname: true } },
  session: { select: { id: true, folio: true, status: true } },
  table: { select: { id: true, name: true } },
  cycle: { select: { cycleNumber: true } },
  participation: { select: { id: true, status: true } },
  createdBy: user,
  receivedBy: user,
  cancelledBy: user,
  allocations: {
    orderBy: [{ allocatedAt: "asc" }, { allocationOrder: "asc" }],
    select: {
      id: true,
      kind: true,
      amount: true,
      allocationOrder: true,
      receivable: {
        select: {
          id: true,
          purchase: {
            select: { folio: true, table: { select: { name: true } } },
          },
          session: { select: { folio: true } },
        },
      },
    },
  },
  payable: {
    select: {
      id: true,
      originalAmount: true,
      status: true,
      paidAt: true,
      voidedAt: true,
      payouts: {
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          amount: true,
          method: true,
          funding: true,
          status: true,
          bankReference: true,
          notes: true,
          failureReason: true,
          createdAt: true,
          resolvedAt: true,
          executedAt: true,
          session: { select: { id: true, folio: true } },
          custodian: user,
          paymentAccount: {
            select: {
              id: true,
              name: true,
              bankName: true,
              accountNumberLast4: true,
            },
          },
          financialTransaction: { select: { id: true, folio: true } },
          requestedBy: user,
          resolvedBy: user,
          receipt: { select: { id: true, status: true } },
        },
      },
    },
  },
  reversal: { select: { reason: true, createdAt: true, createdBy: user } },
  receipts: { select: { id: true, kind: true, status: true } },
  statusHistory: {
    orderBy: { changedAt: "asc" },
    select: {
      fromStatus: true,
      toStatus: true,
      changedAt: true,
      reason: true,
      changedBy: user,
    },
  },
} satisfies Prisma.PlayerSettlementSelect

type DetailRow = Prisma.PlayerSettlementGetPayload<{
  select: typeof detailSelect
}>

function detailView(r: DetailRow) {
  const payable = r.payable
  const state = payable
    ? payableState(
        dec(payable.originalAmount),
        payable.payouts.map((p) => ({
          amount: dec(p.amount),
          status: p.status,
        }))
      )
    : null
  return {
    id: r.id,
    folio: r.folio,
    status: r.status,
    version: r.version,
    sessionId: r.sessionId,
    participationId: r.participationId,
    player: r.player,
    session: r.session,
    table: r.table,
    cycleNumber: r.cycle.cycleNumber,
    participationStatus: r.participation.status,
    returnedNominalAmount: fmt(dec(r.returnedNominalAmount)),
    offsetDecision: r.offsetDecision,
    exitKind: r.exitKind,
    zeroReturnConfirmed: r.zeroReturnConfirmed,
    requestedOffsetAmount: r.requestedOffsetAmount
      ? fmt(dec(r.requestedOffsetAmount))
      : null,
    debtBalanceSnapshot: r.debtBalanceSnapshot
      ? fmt(dec(r.debtBalanceSnapshot))
      : null,
    offsetAmount: r.offsetAmount ? fmt(dec(r.offsetAmount)) : null,
    netPayoutAmount: r.netPayoutAmount ? fmt(dec(r.netPayoutAmount)) : null,
    chipReturnOperationId: r.chipReturnOperationId,
    signatureId: r.signatureId,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    receivedAt: r.receivedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancellationReason: r.cancellationReason,
    reversedAt: r.reversedAt?.toISOString() ?? null,
    createdBy: r.createdBy,
    receivedBy: r.receivedBy,
    cancelledBy: r.cancelledBy,
    offsets: r.allocations.map((a) => ({
      id: a.id,
      kind: a.kind,
      order: a.allocationOrder,
      amount: fmt(dec(a.amount)),
      receivableId: a.receivable.id,
      purchaseFolio: a.receivable.purchase.folio,
      tableName: a.receivable.purchase.table.name,
      sessionFolio: a.receivable.session.folio,
    })),
    payable: payable
      ? {
          id: payable.id,
          status: payable.status,
          paidAt: payable.paidAt?.toISOString() ?? null,
          voidedAt: payable.voidedAt?.toISOString() ?? null,
          netPayout: fmt(state!.original),
          paid: fmt(state!.executed),
          inTransit: fmt(state!.reserved),
          pending: fmt(state!.pending),
          available: fmt(state!.available),
        }
      : null,
    payouts: payable ? payable.payouts.map(payoutView) : [],
    reversal: r.reversal
      ? {
          reason: r.reversal.reason,
          createdAt: r.reversal.createdAt.toISOString(),
          createdBy: r.reversal.createdBy,
        }
      : null,
    hasReceipt: r.receipts.some((x) => x.kind === "RECEPTION"),
    history: r.statusHistory.map((h) => ({
      ...h,
      changedAt: h.changedAt.toISOString(),
    })),
  }
}
export type SettlementView = ReturnType<typeof detailView>

export async function getSettlement(id: string) {
  const row = await prisma.playerSettlement.findUnique({
    where: { id },
    select: detailSelect,
  })
  if (!row) throw new NotFoundError("Liquidación no encontrada")
  return detailView(row)
}

export async function listSettlements(query: SettlementsQuery) {
  const where: Prisma.PlayerSettlementWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.playerId ? { playerId: query.playerId } : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.playerSettlement.count({ where }),
    prisma.playerSettlement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        folio: true,
        status: true,
        returnedNominalAmount: true,
        offsetDecision: true,
        offsetAmount: true,
        netPayoutAmount: true,
        createdAt: true,
        receivedAt: true,
        player: { select: { id: true, name: true, nickname: true } },
        session: { select: { id: true, folio: true } },
        table: { select: { id: true, name: true } },
        payable: {
          select: {
            originalAmount: true,
            payouts: { select: { amount: true, status: true } },
          },
        },
      },
    }),
  ])
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => {
      const state = r.payable
        ? payableState(
            dec(r.payable.originalAmount),
            r.payable.payouts.map((p) => ({
              amount: dec(p.amount),
              status: p.status,
            }))
          )
        : null
      return {
        id: r.id,
        folio: r.folio,
        status: r.status,
        player: r.player,
        session: r.session,
        table: r.table,
        returnedNominalAmount: fmt(dec(r.returnedNominalAmount)),
        offsetDecision: r.offsetDecision,
        offsetAmount: r.offsetAmount ? fmt(dec(r.offsetAmount)) : null,
        netPayoutAmount: r.netPayoutAmount ? fmt(dec(r.netPayoutAmount)) : null,
        pending: state ? fmt(state.pending) : null,
        createdAt: r.createdAt.toISOString(),
        receivedAt: r.receivedAt?.toISOString() ?? null,
      }
    }),
  }
}
export type SettlementListItem = Awaited<
  ReturnType<typeof listSettlements>
>["items"][number]

/** Deuda global vigente del jugador (informativa; se revalida al confirmar). */
export async function playerOutstanding(playerId: string) {
  const list = await receivablesOf(prisma, playerId)
  return fmt(list.reduce((acc, r) => acc.add(r.balance), dec(0)))
}

/** Efectivo disponible en la caja de la sesión (informativo para la pantalla). */
export async function sessionCashAvailable(sessionId: string) {
  return fmt((await cashBalanceOf(prisma, sessionId)).balance)
}

// ── Contratos para el Módulo 12 (cierre) ─────────────────────────────

/**
 * Estado de liquidaciones de una sesión para el cierre de mesas y de la
 * sesión: las que están en curso (DRAFT/READY_FOR_CONFIRMATION) BLOQUEAN
 * el cierre (devoluciones físicas sin confirmar); las PENDING_PAYOUT no lo
 * bloquean (fichas recibidas, firma y obligación registradas) y sobreviven
 * al cierre para pagarse administrativamente.
 */
export async function getSessionSettlementOverview(db: Db, sessionId: string) {
  const [inProgress, pendingPayout] = await Promise.all([
    db.playerSettlement.findMany({
      where: {
        sessionId,
        status: { in: ["DRAFT", "READY_FOR_CONFIRMATION"] },
      },
      select: {
        id: true,
        folio: true,
        status: true,
        player: { select: { id: true, name: true } },
        table: { select: { name: true } },
      },
    }),
    db.playerSettlement.count({
      where: { sessionId, status: "PENDING_PAYOUT" },
    }),
  ])
  return { inProgress, pendingPayoutCount: pendingPayout }
}

/** Lanza si hay liquidaciones con devolución física sin confirmar. */
export async function assertNoSettlementsInProgress(db: Db, sessionId: string) {
  const { inProgress } = await getSessionSettlementOverview(db, sessionId)
  if (inProgress.length > 0)
    throw new BusinessRuleError(
      `Hay ${inProgress.length} liquidación(es) en curso sin recepción confirmada (${inProgress
        .map((s) => s.folio)
        .join(", ")}): confírmalas o cancélalas.`
    )
}
