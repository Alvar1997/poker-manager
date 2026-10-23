import "server-only"

import type { Prisma } from "@/generated/prisma/client"
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
import { assertPlayerSelectable } from "@/modules/players/player.rules"
import {
  occupySeatInTx,
  releaseSeatInTx,
  SEAT_TAKEN_MESSAGE,
} from "@/modules/table-floor/seat-core"
import type { TransferInput } from "@/modules/session-tables/session-table.schemas"
import {
  lockOpenSession,
  lockSessionTable,
  TABLE_TX,
  type Db,
  type Tx,
} from "@/modules/session-tables/session-table.service"

/**
 * Participación de jugadores (Módulo 07).
 *
 * - Un jugador solo puede tener UNA participación ACTIVE por sesión (índice
 *   único parcial): nunca está en 25/25 y 10/10 a la vez.
 * - Registrar o transferir NO genera compra, cobro, pago, crédito ni
 *   movimiento de inventario: el jugador conserva sus fichas físicas.
 * - La transferencia es atómica: cierra el origen (TRANSFERRED), crea la
 *   participación destino (ACTIVE) y el registro TableTransfer en la misma
 *   transacción, con las dos mesas bloqueadas en orden fijo.
 * - La salida definitiva SOLO ocurre desde una liquidación (Módulo 11):
 *   SETTLING (fichas recibidas, falta pagar; ya no ocupa silla) y SETTLED
 *   (terminada). No hay endpoint que marque estos estados manualmente.
 * - Mientras exista una liquidación en curso (DRAFT/READY_FOR_CONFIRMATION)
 *   la participación no admite compras ni transferencias, y un jugador con
 *   liquidación pendiente de pago (SETTLING) no reingresa en la sesión.
 */

const user = { select: { id: true, name: true } } as const

const participationSelect = {
  id: true,
  sessionId: true,
  status: true,
  joinedAt: true,
  leftAt: true,
  exitReason: true,
  settlementId: true,
  sourceParticipationId: true,
  player: { select: { id: true, name: true, nickname: true, phone: true } },
  sessionTable: {
    select: {
      id: true,
      tableId: true,
      table: { select: { id: true, name: true } },
    },
  },
  cycle: { select: { id: true, cycleNumber: true } },
  joinedBy: user,
  leftBy: user,
} satisfies Prisma.TableParticipationSelect

type ParticipationRecord = Prisma.TableParticipationGetPayload<{
  select: typeof participationSelect
}>

function toView(p: ParticipationRecord, opts: { showPhone: boolean }) {
  return {
    id: p.id,
    sessionId: p.sessionId,
    status: p.status,
    joinedAt: p.joinedAt.toISOString(),
    leftAt: p.leftAt?.toISOString() ?? null,
    exitReason: p.exitReason,
    settlementId: p.settlementId,
    sourceParticipationId: p.sourceParticipationId,
    player: {
      id: p.player.id,
      name: p.player.name,
      nickname: p.player.nickname,
      phone: opts.showPhone ? p.player.phone : null,
    },
    table: p.sessionTable.table,
    sessionTableId: p.sessionTable.id,
    cycle: p.cycle,
    joinedBy: p.joinedBy,
    leftBy: p.leftBy,
  }
}
export type ParticipationView = ReturnType<typeof toView>

// ── Consultas ─────────────────────────────────────────────────────────

export async function listParticipations(
  sessionId: string,
  filters: {
    status?: "ACTIVE" | "TRANSFERRED" | "SETTLING" | "SETTLED" | "WITHDRAWN"
    tableId?: string
  },
  opts: { showPhone: boolean }
) {
  const session = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const rows = await prisma.tableParticipation.findMany({
    where: {
      sessionId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.tableId
        ? { sessionTable: { tableId: filters.tableId } }
        : {}),
    },
    orderBy: { joinedAt: "desc" },
    select: participationSelect,
  })
  return rows.map((p) => toView(p, opts))
}

export async function getActiveParticipants(
  sessionId: string,
  tableId: string,
  opts: { showPhone: boolean }
) {
  return listParticipations(sessionId, { status: "ACTIVE", tableId }, opts)
}

export async function getParticipation(
  sessionId: string,
  participationId: string,
  opts: { showPhone: boolean }
) {
  const p = await prisma.tableParticipation.findFirst({
    where: { id: participationId, sessionId },
    select: participationSelect,
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  return toView(p, opts)
}

/** Liquidación en curso (sin efectos todavía) de una participación. */
export async function activeSettlementOf(db: Db, participationId: string) {
  return db.playerSettlement.findFirst({
    where: {
      participationId,
      status: { in: ["DRAFT", "READY_FOR_CONFIRMATION"] },
    },
    select: { id: true, folio: true, status: true },
  })
}

export const SETTLEMENT_IN_PROGRESS_MESSAGE =
  "El jugador tiene una liquidación en curso: termínala o cancélala antes de continuar."

export const SETTLING_REENTRY_MESSAGE =
  "El jugador tiene una liquidación pendiente de pago en esta sesión: termina de pagarla antes de volver a registrarlo."

async function activeElsewhereMessage(
  db: Db,
  sessionId: string,
  playerId: string,
  tableId: string
) {
  const active = await db.tableParticipation.findFirst({
    where: { sessionId, playerId, status: "ACTIVE" },
    select: {
      sessionTable: {
        select: { tableId: true, table: { select: { name: true } } },
      },
    },
  })
  if (!active) return null
  return active.sessionTable.tableId === tableId
    ? "Este jugador ya está activo en esta mesa."
    : `Este jugador ya se encuentra activo en la ${active.sessionTable.table.name}. Utiliza la opción Cambiar de mesa.`
}

/** ¿El asiento del ciclo vigente de la mesa está ocupado? (mensajes tras una carrera). */
async function seatTaken(tableId: string, seatNumber: number) {
  const seat = await prisma.tableSeatAssignment.findFirst({
    where: {
      seatNumber,
      releasedAt: null,
      sessionTable: { tableId },
      cycle: { status: "OPEN" },
    },
    select: { id: true },
  })
  return Boolean(seat)
}

// ── Registrar jugador ─────────────────────────────────────────────────

/**
 * Incorpora un jugador a la mesa (ciclo vigente). No compra, no entrega
 * fichas, no cobra. Con `seatNumber` ocupa además ese asiento en la misma
 * transacción (queda «pendiente de compra» hasta su primera entrega).
 */
export async function addPlayerToTable(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: { playerId: string; idempotencyKey: string; seatNumber?: number },
  ctx: RequestContext = {}
) {
  const replay = async () =>
    prisma.tableParticipation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: {
        id: true,
        sessionId: true,
        playerId: true,
        sessionTable: { select: { tableId: true } },
      },
    })
  const previous = await replay()
  if (previous) {
    if (
      previous.sessionId !== sessionId ||
      previous.playerId !== input.playerId ||
      previous.sessionTable.tableId !== tableId
    ) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro registro"
      )
    }
    return { participationId: previous.id, replayed: true }
  }
  try {
    const id = await prisma.$transaction(async (tx) => {
      const session = await lockOpenSession(
        tx,
        sessionId,
        "La sesión debe estar abierta para registrar jugadores."
      )
      const st = await tx.sessionTable.findUnique({
        where: { sessionId_tableId: { sessionId, tableId } },
        select: { id: true },
      })
      if (!st)
        throw new BusinessRuleError(
          "La mesa debe estar abierta para registrar jugadores."
        )
      // Bloqueo de la mesa: un cierre simultáneo espera a este registro (o al revés).
      const table = await lockSessionTable(tx, st.id)
      const sameKey = await tx.tableParticipation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (sameKey) return { id: sameKey.id, replayed: true }
      const cycle = table.cycles[0]
      if (table.status !== "OPEN" || !cycle)
        throw new BusinessRuleError(
          "La mesa debe estar abierta para registrar jugadores."
        )
      // Bloqueo del jugador: serializa con la confirmación de su liquidación
      // (Módulo 11), que también lo bloquea.
      await tx.$queryRaw`SELECT "id" FROM "players" WHERE "id" = ${input.playerId} FOR UPDATE`
      const player = await tx.player.findUnique({
        where: { id: input.playerId },
        select: { id: true, name: true, isActive: true },
      })
      if (!player) throw new NotFoundError("Jugador no encontrado")
      assertPlayerSelectable(player)
      const settling = await tx.tableParticipation.findFirst({
        where: { sessionId, playerId: player.id, status: "SETTLING" },
        select: { id: true },
      })
      if (settling) throw new ConflictError(SETTLING_REENTRY_MESSAGE)
      const conflict = await activeElsewhereMessage(
        tx,
        sessionId,
        player.id,
        tableId
      )
      if (conflict) throw new ConflictError(conflict)
      const created = await tx.tableParticipation.create({
        data: {
          sessionId,
          sessionTableId: st.id,
          cycleId: cycle.id,
          playerId: player.id,
          joinedById: actor.id,
          joinedAt: new Date(),
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      if (input.seatNumber)
        await occupySeatInTx(
          tx,
          actor,
          {
            participation: {
              id: created.id,
              sessionId,
              sessionTableId: st.id,
              cycleId: cycle.id,
              playerId: player.id,
            },
            seatNumber: input.seatNumber,
            idempotencyKey: `seat-${input.idempotencyKey}`,
            tableName: table.table.name,
            sessionFolio: session.folio,
          },
          ctx
        )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.TABLE_PLAYER_JOINED,
          entityType: "TableParticipation",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            cycleId: cycle.id,
            folio: session.folio,
            table: table.table.name,
            tableId,
            cycleNumber: cycle.cycleNumber,
            playerId: player.id,
            ...(input.seatNumber ? { seatNumber: input.seatNumber } : {}),
          },
        },
        tx
      )
      return { id: created.id, replayed: false }
    }, TABLE_TX)
    return { participationId: id.id, replayed: id.replayed }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { participationId: again.id, replayed: true }
      if (input.seatNumber && (await seatTaken(tableId, input.seatNumber)))
        throw new ConflictError(SEAT_TAKEN_MESSAGE)
      const message = await activeElsewhereMessage(
        prisma,
        sessionId,
        input.playerId,
        tableId
      )
      throw new ConflictError(
        message ?? "Este jugador ya está activo en otra mesa."
      )
    }
    throw error
  }
}

// ── Transferir ────────────────────────────────────────────────────────

/**
 * Cambia al jugador de mesa SIN liquidar, contar fichas, cobrar ni pagar,
 * y sin mover inventario. Las compras anteriores conservan su mesa; las
 * futuras usarán la participación destino. Idempotente por clave.
 */
export async function transferPlayer(
  actor: SessionUser,
  sessionId: string,
  input: TransferInput,
  ctx: RequestContext = {}
) {
  const replay = async () =>
    prisma.tableTransfer.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, sessionId: true, sourceParticipationId: true },
    })
  const previous = await replay()
  if (previous) {
    if (
      previous.sessionId !== sessionId ||
      previous.sourceParticipationId !== input.sourceParticipationId
    ) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra transferencia"
      )
    }
    return { ...(await getTransfer(previous.id)), replayed: true }
  }
  try {
    const transferId = await prisma.$transaction(async (tx) => {
      const session = await lockOpenSession(
        tx,
        sessionId,
        "La sesión debe estar abierta para transferir jugadores."
      )
      const source = await tx.tableParticipation.findFirst({
        where: { id: input.sourceParticipationId, sessionId },
        select: {
          id: true,
          sessionTableId: true,
          playerId: true,
          status: true,
        },
      })
      if (!source)
        throw new NotFoundError(
          "Participación de origen no encontrada en esta sesión"
        )
      if (source.status !== "ACTIVE") {
        const done = await tx.tableTransfer.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        })
        if (done) return { id: done.id, replayed: true }
        throw new ConflictError(
          "El jugador ya no está activo en la mesa de origen."
        )
      }
      const destination = await tx.sessionTable.findUnique({
        where: {
          sessionId_tableId: { sessionId, tableId: input.destinationTableId },
        },
        select: { id: true },
      })
      if (!destination)
        throw new BusinessRuleError("La mesa destino debe estar abierta.")
      if (destination.id === source.sessionTableId) {
        throw new BusinessRuleError(
          "El jugador ya está en esa mesa: elige una mesa destino diferente."
        )
      }
      // Ambas mesas bloqueadas en orden fijo (sin interbloqueos).
      const [firstId, secondId] = [source.sessionTableId, destination.id].sort()
      const first = await lockSessionTable(tx, firstId)
      const second = await lockSessionTable(tx, secondId)
      const from = first.id === source.sessionTableId ? first : second
      const to = first.id === destination.id ? first : second
      if (from.status !== "OPEN" || !from.cycles[0])
        throw new BusinessRuleError("La mesa de origen debe estar abierta.")
      if (to.status !== "OPEN" || !to.cycles[0])
        throw new BusinessRuleError("La mesa destino debe estar abierta.")

      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${source.id} FOR UPDATE`
      // Reintento simultáneo con la misma clave: esperó el bloqueo → misma transferencia.
      const sameKey = await tx.tableTransfer.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (sameKey) return { id: sameKey.id, replayed: true }
      // Liquidación en curso (Módulo 11): primero terminarla o cancelarla.
      if (await activeSettlementOf(tx, source.id))
        throw new ConflictError(SETTLEMENT_IN_PROGRESS_MESSAGE)
      const now = new Date()
      // El asiento de origen se libera antes de cerrar la participación.
      await releaseSeatInTx(tx, actor, source.id, "TRANSFER", ctx)
      const { count } = await tx.tableParticipation.updateMany({
        where: { id: source.id, status: "ACTIVE" },
        data: {
          status: "TRANSFERRED",
          leftAt: now,
          leftById: actor.id,
          exitReason: "TRANSFER",
        },
      })
      if (count !== 1) {
        throw new ConflictError(
          "El jugador ya no está activo en la mesa de origen (¿se transfirió en otra solicitud?)."
        )
      }
      const created = await tx.tableParticipation.create({
        data: {
          sessionId,
          sessionTableId: to.id,
          cycleId: to.cycles[0].id,
          playerId: source.playerId,
          joinedById: actor.id,
          joinedAt: now,
          sourceParticipationId: source.id,
          idempotencyKey: `transfer-${input.idempotencyKey}`,
        },
        select: { id: true },
      })
      if (input.destinationSeatNumber)
        await occupySeatInTx(
          tx,
          actor,
          {
            participation: {
              id: created.id,
              sessionId,
              sessionTableId: to.id,
              cycleId: to.cycles[0].id,
              playerId: source.playerId,
            },
            seatNumber: input.destinationSeatNumber,
            idempotencyKey: `seat-transfer-${input.idempotencyKey}`,
            tableName: to.table.name,
            sessionFolio: session.folio,
          },
          ctx
        )
      const transfer = await tx.tableTransfer.create({
        data: {
          sessionId,
          playerId: source.playerId,
          sourceParticipationId: source.id,
          destinationParticipationId: created.id,
          sourceSessionTableId: from.id,
          destinationSessionTableId: to.id,
          transferredById: actor.id,
          transferredAt: now,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.TABLE_PLAYER_TRANSFERRED,
          entityType: "TableTransfer",
          entityId: transfer.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            cycleId: to.cycles[0].id,
            folio: session.folio,
            playerId: source.playerId,
            from: from.table.name,
            to: to.table.name,
            sourceParticipationId: source.id,
            destinationParticipationId: created.id,
            ...(input.destinationSeatNumber
              ? { destinationSeatNumber: input.destinationSeatNumber }
              : {}),
          },
        },
        tx
      )
      return { id: transfer.id, replayed: false }
    }, TABLE_TX)
    return {
      ...(await getTransfer(transferId.id)),
      replayed: transferId.replayed,
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { ...(await getTransfer(again.id)), replayed: true }
      if (
        input.destinationSeatNumber &&
        (await seatTaken(input.destinationTableId, input.destinationSeatNumber))
      )
        throw new ConflictError(SEAT_TAKEN_MESSAGE)
      throw new ConflictError("El jugador ya tiene otra participación activa.")
    }
    throw error
  }
}

const transferSelect = {
  id: true,
  sessionId: true,
  transferredAt: true,
  notes: true,
  player: { select: { id: true, name: true, nickname: true } },
  transferredBy: user,
  sourceParticipation: { select: { id: true, status: true } },
  destinationParticipation: { select: { id: true, status: true } },
  sourceSessionTable: {
    select: { table: { select: { id: true, name: true } } },
  },
  destinationSessionTable: {
    select: { table: { select: { id: true, name: true } } },
  },
} satisfies Prisma.TableTransferSelect

type TransferRecord = Prisma.TableTransferGetPayload<{
  select: typeof transferSelect
}>
function toTransferView(t: TransferRecord) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    transferredAt: t.transferredAt.toISOString(),
    notes: t.notes,
    player: t.player,
    transferredBy: t.transferredBy,
    sourceParticipation: t.sourceParticipation,
    destinationParticipation: t.destinationParticipation,
    from: t.sourceSessionTable.table,
    to: t.destinationSessionTable.table,
  }
}

async function getTransfer(id: string) {
  return toTransferView(
    await prisma.tableTransfer.findUniqueOrThrow({
      where: { id },
      select: transferSelect,
    })
  )
}

export async function listTransfers(sessionId: string) {
  const session = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const rows = await prisma.tableTransfer.findMany({
    where: { sessionId },
    orderBy: { transferredAt: "desc" },
    select: transferSelect,
  })
  return rows.map(toTransferView)
}

// ── Contratos para módulos futuros ────────────────────────────────────

/**
 * CONTRATO (Módulo 08 — compras): valida que la participación esté ACTIVE,
 * en una mesa OPEN con ciclo vigente y en una sesión OPEN. La compra debe
 * guardar participación, mesa y ciclo devueltos (no cambian si el jugador
 * se transfiere después).
 */
export async function validateParticipationForPurchase(
  db: Db,
  participationId: string,
  playerId?: string
) {
  const p = await db.tableParticipation.findUnique({
    where: { id: participationId },
    select: {
      id: true,
      status: true,
      playerId: true,
      cycleId: true,
      session: { select: { id: true, status: true } },
      sessionTable: { select: { id: true, status: true, tableId: true } },
      cycle: { select: { status: true } },
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  if (playerId && p.playerId !== playerId)
    throw new BusinessRuleError(
      "La participación no corresponde a este jugador."
    )
  if (p.session.status !== "OPEN")
    throw new BusinessRuleError("La sesión debe estar abierta.")
  if (p.sessionTable.status !== "OPEN" || p.cycle.status !== "OPEN")
    throw new BusinessRuleError("La mesa debe estar abierta.")
  if (p.status !== "ACTIVE")
    throw new BusinessRuleError("El jugador ya no está activo en esta mesa.")
  // Durante una liquidación en curso no hay compras ni recompras (Módulo 11).
  if (await activeSettlementOf(db, p.id))
    throw new BusinessRuleError(SETTLEMENT_IN_PROGRESS_MESSAGE)
  return {
    participationId: p.id,
    playerId: p.playerId,
    sessionId: p.session.id,
    sessionTableId: p.sessionTable.id,
    tableId: p.sessionTable.tableId,
    cycleId: p.cycleId,
  }
}

/** CONTRATO: la mesa admite operaciones ordinarias (sesión y mesa abiertas). */
export async function validateTableReadyForOperations(
  db: Db,
  sessionId: string,
  tableId: string
) {
  const st = await db.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: {
      id: true,
      status: true,
      session: { select: { status: true } },
      cycles: { where: { status: "OPEN" }, select: { id: true } },
    },
  })
  if (
    !st ||
    st.session.status !== "OPEN" ||
    st.status !== "OPEN" ||
    st.cycles.length === 0
  ) {
    throw new BusinessRuleError(
      "La mesa debe estar abierta en una sesión abierta."
    )
  }
  return { sessionTableId: st.id, cycleId: st.cycles[0].id }
}

/**
 * Verificador de liquidaciones (el real lo registra el Módulo 11:
 * `settlementVerifier` en src/modules/settlements/settlement.service.ts).
 * `target` indica a qué estado pasa la participación: SETTLING exige la
 * recepción confirmada; SETTLED, la liquidación terminada.
 */
export interface SettlementVerifier {
  /** Debe lanzar si la liquidación no existe, no está confirmada o no corresponde. */
  assertConfirmedSettlement(
    tx: Tx,
    settlementId: string,
    participation: { id: string; playerId: string; sessionId: string },
    target?: "SETTLING" | "SETTLED"
  ): Promise<void>
}

/** Hasta el Módulo 11 no hay liquidaciones: la salida definitiva está bloqueada. */
export const unavailableSettlementVerifier: SettlementVerifier = {
  async assertConfirmedSettlement() {
    throw new BusinessRuleError(
      "El retiro definitivo requiere una liquidación confirmada. Estará disponible con el módulo de liquidaciones."
    )
  },
}

/**
 * CONTRATO (Módulo 11): finaliza la participación ACTIVE (o SETTLING, ya
 * con su liquidación) como SETTLED únicamente con una liquidación terminada,
 * propia del jugador y no usada antes (`settlementId` es único). No hay
 * endpoint que lo haga manualmente.
 */
export async function completeParticipationFromSettlementInTx(
  tx: Tx,
  actor: SessionUser,
  input: { participationId: string; settlementId: string },
  verifier: SettlementVerifier = unavailableSettlementVerifier,
  ctx: RequestContext = {}
) {
  await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${input.participationId} FOR UPDATE`
  const p = await tx.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: {
      id: true,
      playerId: true,
      sessionId: true,
      status: true,
      settlementId: true,
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  if (p.status === "SETTLED" && p.settlementId === input.settlementId)
    return { replayed: true }
  if (p.status === "SETTLING") {
    if (p.settlementId !== input.settlementId)
      throw new BusinessRuleError(
        "La participación pertenece a otra liquidación."
      )
  } else if (p.status !== "ACTIVE")
    throw new BusinessRuleError("La participación no está activa.")
  await verifier.assertConfirmedSettlement(tx, input.settlementId, p, "SETTLED")
  // Desde ACTIVE deja la silla en la misma transacción (Módulo 11).
  if (p.status === "ACTIVE")
    await releaseSeatInTx(tx, actor, p.id, "SETTLEMENT", ctx)
  const { count } = await tx.tableParticipation.updateMany({
    where: { id: p.id, status: p.status },
    data:
      p.status === "SETTLING"
        ? { status: "SETTLED" }
        : {
            status: "SETTLED",
            settlementId: input.settlementId,
            leftAt: new Date(),
            leftById: actor.id,
            exitReason: "SETTLEMENT",
          },
  })
  if (count !== 1) throw new ConflictError("La participación cambió de estado")
  await recordAudit(
    {
      action: AUDIT_ACTIONS.TABLE_PARTICIPATION_SETTLED,
      entityType: "TableParticipation",
      entityId: p.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        settlementId: input.settlementId,
        playerId: p.playerId,
        sessionId: p.sessionId,
      },
    },
    tx
  )
  return { replayed: false }
}

/**
 * CONTRATO (Módulo 11): el jugador terminó de jugar y devolvió sus fichas,
 * pero falta pagarle. La participación ACTIVE pasa a SETTLING: deja la silla
 * (salida registrada), no admite compras ni transferencias y queda ligada a
 * su liquidación hasta que se pague por completo (→ SETTLED).
 */
export async function markParticipationSettlingInTx(
  tx: Tx,
  actor: SessionUser,
  input: { participationId: string; settlementId: string },
  verifier: SettlementVerifier = unavailableSettlementVerifier,
  ctx: RequestContext = {}
) {
  await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${input.participationId} FOR UPDATE`
  const p = await tx.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: {
      id: true,
      playerId: true,
      sessionId: true,
      status: true,
      settlementId: true,
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  if (p.status === "SETTLING" && p.settlementId === input.settlementId)
    return { replayed: true }
  if (p.status !== "ACTIVE")
    throw new BusinessRuleError("La participación no está activa.")
  await verifier.assertConfirmedSettlement(
    tx,
    input.settlementId,
    p,
    "SETTLING"
  )
  // SETTLING ya no ocupa silla: el asiento se libera en esta transacción.
  await releaseSeatInTx(tx, actor, p.id, "SETTLEMENT", ctx)
  const { count } = await tx.tableParticipation.updateMany({
    where: { id: p.id, status: "ACTIVE" },
    data: {
      status: "SETTLING",
      settlementId: input.settlementId,
      leftAt: new Date(),
      leftById: actor.id,
      exitReason: "SETTLEMENT",
    },
  })
  if (count !== 1) throw new ConflictError("La participación cambió de estado")
  await recordAudit(
    {
      action: AUDIT_ACTIONS.TABLE_PARTICIPATION_SETTLING,
      entityType: "TableParticipation",
      entityId: p.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        settlementId: input.settlementId,
        playerId: p.playerId,
        sessionId: p.sessionId,
      },
    },
    tx
  )
  return { replayed: false }
}

/**
 * CONTRATO (Módulo 17, PRIVADO): finaliza la participación ACTIVE como
 * SETTLED cuando la jugada financiada por la casa quedó CONCILIADA
 * (devolución física verificada o retorno cero confirmado). No hay pago al
 * jugador: el resultado se administra en su sección privada. Libera la silla
 * en la misma transacción. La base exige `bankingGameId` (excluyente con
 * `settlementId`). La auditoría de la mesa es la ordinaria (sin datos del
 * financiamiento).
 */
export async function completeParticipationFromBankingGameInTx(
  tx: Tx,
  actor: SessionUser,
  input: { participationId: string; bankingGameId: string },
  ctx: RequestContext = {}
) {
  await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${input.participationId} FOR UPDATE`
  const p = await tx.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: {
      id: true,
      playerId: true,
      sessionId: true,
      status: true,
      bankingGameId: true,
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  if (p.status === "SETTLED" && p.bankingGameId === input.bankingGameId)
    return { replayed: true }
  if (p.status !== "ACTIVE")
    throw new BusinessRuleError("La participación no está activa.")
  const game = await tx.bankingGame.findUnique({
    where: { id: input.bankingGameId },
    select: { playerId: true, sessionId: true, status: true },
  })
  if (
    !game ||
    game.playerId !== p.playerId ||
    game.sessionId !== p.sessionId ||
    game.status !== "CONFIRMED"
  )
    throw new BusinessRuleError(
      "La salida requiere la conciliación confirmada del jugador."
    )
  await releaseSeatInTx(tx, actor, p.id, "SETTLEMENT", ctx)
  const { count } = await tx.tableParticipation.updateMany({
    where: { id: p.id, status: "ACTIVE" },
    data: {
      status: "SETTLED",
      bankingGameId: input.bankingGameId,
      leftAt: new Date(),
      leftById: actor.id,
      exitReason: "SETTLEMENT",
    },
  })
  if (count !== 1) throw new ConflictError("La participación cambió de estado")
  await recordAudit(
    {
      action: AUDIT_ACTIONS.TABLE_PARTICIPATION_SETTLED,
      entityType: "TableParticipation",
      entityId: p.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: { playerId: p.playerId, sessionId: p.sessionId },
    },
    tx
  )
  return { replayed: false }
}
