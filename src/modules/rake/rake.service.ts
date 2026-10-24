import "server-only"

import { randomUUID } from "node:crypto"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { Prisma } from "@/generated/prisma/client"
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

import { nominalEffectInTx } from "./nominal-effect"
import {
  cycleRake,
  dec,
  fmt,
  rakeModeChangeBlocker,
  runningTotals,
  ZERO,
  type RakeModeValue,
} from "./rake.math"
import type {
  RakeCorrectionInput,
  RakeCountInput,
  RakeEntryInput,
  RakeModeInput,
} from "./rake.schemas"

/**
 * Rake por mesa (Módulo 18, simplificado). Pertenece a la casa; se
 * registra por mesa lógica y ciclo. Las fichas del recipiente son custodia
 * de la casa:
 *  - MANUAL: cada registro entra al inventario al capturarse; el conteo al
 *    cerrar la mesa es de COMPROBACIÓN (muestra diferencia, no mueve fichas).
 *  - FINAL_COUNT: el conteo determina el rake y registra su entrada.
 *  - CORRECCIÓN (±, motivo): movimiento nuevo con su efecto nominal real;
 *    lo capturado originalmente se conserva.
 * No hay efectivo: el rake no es una venta ni una entrada de caja.
 * Orden de bloqueos: sesión (FOR SHARE) → ciclo (FOR UPDATE) → inventario.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TX = { maxWait: 15_000, timeout: 30_000 } as const
const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`

async function lockSessionInTx(tx: Tx, sessionId: string, action: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "poker_sessions"
     WHERE "id" = ${sessionId} FOR SHARE`
  if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
  if (rows[0].status !== "OPEN" && rows[0].status !== "CLOSING")
    throw new BusinessRuleError(
      `La sesión debe estar abierta o en cierre para ${action}. Una sesión cerrada no se modifica.`
    )
}

async function lockCycleInTx(
  tx: Tx,
  sessionId: string,
  tableId: string,
  cycleId: string | undefined
) {
  const st = await tx.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true, table: { select: { rakeMode: true, name: true } } },
  })
  if (!st) throw new NotFoundError("La mesa no forma parte de la sesión")
  const cycle = cycleId
    ? await tx.sessionTableCycle.findFirst({
        where: { id: cycleId, sessionTableId: st.id },
      })
    : await tx.sessionTableCycle.findFirst({
        where: { sessionTableId: st.id, status: "OPEN" },
      })
  if (!cycle)
    throw new BusinessRuleError(
      cycleId
        ? "El ciclo no pertenece a esta mesa de la sesión."
        : "La mesa no está abierta: indica el ciclo cerrado al que corresponde el rake."
    )
  await tx.$queryRaw`SELECT "id" FROM "session_table_cycles" WHERE "id" = ${cycle.id} FOR UPDATE`
  const count = await tx.rakeCount.findUnique({
    where: { cycleId: cycle.id },
    select: { id: true, modeSnapshot: true, countedAmount: true },
  })
  return { cycle, table: st.table, count }
}

// ── Consultas ─────────────────────────────────────────────────────────

export async function getTableRake(
  sessionId: string,
  tableId: string,
  db: Db = prisma
) {
  const st = await db.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: {
      session: { select: { id: true, folio: true, status: true } },
      table: { select: { id: true, name: true, rakeMode: true } },
      cycles: {
        orderBy: { cycleNumber: "asc" },
        select: {
          id: true,
          cycleNumber: true,
          status: true,
          openedAt: true,
          closedAt: true,
          rakeMovements: {
            orderBy: { recordedAt: "asc" },
            select: {
              id: true,
              kind: true,
              amount: true,
              effectiveAt: true,
              recordedAt: true,
              notes: true,
              reason: true,
              correctsMovementId: true,
              correctsCountId: true,
              recordedBy: { select: { name: true } },
            },
          },
          rakeCount: {
            select: {
              id: true,
              modeSnapshot: true,
              registeredAmount: true,
              countedAmount: true,
              countedAt: true,
              notes: true,
              countedBy: { select: { name: true } },
            },
          },
        },
      },
    },
  })
  if (!st) throw new NotFoundError("La mesa no forma parte de la sesión")
  let total = ZERO
  let pendingCount = 0
  let differences = 0
  const cycles = st.cycles.map((c) => {
    const mode: RakeModeValue = c.rakeCount?.modeSnapshot ?? st.table.rakeMode
    const r = cycleRake({
      mode,
      cycleClosed: c.status === "CLOSED",
      entries: c.rakeMovements
        .filter((m) => m.kind === "MANUAL_ENTRY")
        .map((m) => dec(m.amount)),
      corrections: c.rakeMovements
        .filter((m) => m.kind === "CORRECTION")
        .map((m) => dec(m.amount)),
      count: c.rakeCount ? { counted: dec(c.rakeCount.countedAmount) } : null,
    })
    total = total.add(r.recognized)
    if (r.status === "COUNT_PENDING") pendingCount++
    if (r.status === "DIFFERENCE") differences++
    return {
      id: c.id,
      cycleNumber: c.cycleNumber,
      status: c.status,
      openedAt: c.openedAt.toISOString(),
      closedAt: c.closedAt?.toISOString() ?? null,
      mode,
      rakeStatus: r.status,
      registered: fmt(r.registered),
      corrected: fmt(r.corrected),
      recognized: fmt(r.recognized),
      counted: r.counted ? fmt(r.counted) : null,
      difference: r.difference ? fmt(r.difference) : null,
      movementCount: c.rakeMovements.length,
      movements: runningTotals(
        c.rakeMovements.map((m) => ({ ...m, amount: dec(m.amount) }))
      ).map((m) => ({
        id: m.id,
        kind: m.kind,
        amount: fmt(m.amount),
        cumulative: fmt(m.cumulative),
        effectiveAt: m.effectiveAt.toISOString(),
        recordedAt: m.recordedAt.toISOString(),
        late: m.recordedAt.getTime() - m.effectiveAt.getTime() > 5 * 60_000,
        notes: m.notes,
        reason: m.reason,
        recordedBy: m.recordedBy.name,
      })),
      count: c.rakeCount
        ? {
            id: c.rakeCount.id,
            registered: fmt(dec(c.rakeCount.registeredAmount)),
            counted: fmt(dec(c.rakeCount.countedAmount)),
            countedAt: c.rakeCount.countedAt.toISOString(),
            countedBy: c.rakeCount.countedBy.name,
            notes: c.rakeCount.notes,
          }
        : null,
    }
  })
  return {
    session: st.session,
    table: st.table,
    cycles,
    totals: {
      recognized: fmt(total),
      cyclesPendingCount: pendingCount,
      cyclesWithDifference: differences,
    },
  }
}
export type TableRakeView = Awaited<ReturnType<typeof getTableRake>>

/** Rake de la SESIÓN (ambas mesas) para la conciliación global. */
export async function getSessionRakeSummary(db: Db, sessionId: string) {
  const tables = await db.sessionTable.findMany({
    where: { sessionId },
    select: { tableId: true },
  })
  const views = await Promise.all(
    tables.map((t) => getTableRake(sessionId, t.tableId, db))
  )
  return {
    recognized: views.reduce((a, v) => a.add(v.totals.recognized), ZERO),
    cyclesPendingCount: views.reduce(
      (a, v) => a + v.totals.cyclesPendingCount,
      0
    ),
    cyclesWithDifference: views.reduce(
      (a, v) => a + v.totals.cyclesWithDifference,
      0
    ),
    byTable: views.map((v) => ({
      table: { id: v.table.id, name: v.table.name },
      mode: v.table.rakeMode,
      ...v.totals,
    })),
  }
}

// ── Captura manual ────────────────────────────────────────────────────

export async function recordRakeEntry(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: RakeEntryInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.rakeMovement.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, sessionId: true, tableId: true },
  })
  if (replay) {
    if (replay.sessionId !== sessionId || replay.tableId !== tableId)
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, replayed: true }
  }
  const amount = dec(input.amount)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSessionInTx(tx, sessionId, "registrar rake")
      const { cycle, table, count } = await lockCycleInTx(
        tx,
        sessionId,
        tableId,
        input.cycleId
      )
      if (table.rakeMode !== "MANUAL")
        throw new BusinessRuleError(
          `${table.name} usa conteo final: el rake se registra al contar el recipiente.`
        )
      if (count)
        throw new BusinessRuleError(
          "El recipiente de ese ciclo ya se contó: registra una corrección con motivo."
        )
      const now = new Date()
      const effective = input.effectiveAt ? new Date(input.effectiveAt) : now
      if (effective.getTime() > now.getTime() + 60_000)
        throw new BusinessRuleError("La hora efectiva no puede ser futura.")
      if (
        effective < cycle.openedAt ||
        (cycle.closedAt && effective > cycle.closedAt)
      )
        throw new BusinessRuleError(
          "La hora efectiva debe estar dentro del ciclo de la mesa."
        )
      const id = newId("rkm")
      const operationId = await nominalEffectInTx(
        tx,
        actor,
        {
          amount,
          referenceType: "RakeMovement",
          referenceId: id,
          sessionId,
          tableId,
          idempotencyKey: `rake_${input.idempotencyKey}`,
        },
        ctx
      )
      await tx.rakeMovement.create({
        data: {
          id,
          sessionId,
          tableId,
          cycleId: cycle.id,
          kind: "MANUAL_ENTRY",
          amount,
          modeSnapshot: "MANUAL",
          effectiveAt: effective,
          recordedById: actor.id,
          notes: input.notes ?? null,
          chipOperationId: operationId,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.RAKE_MOVEMENT_CREATED,
          entityType: "RakeMovement",
          entityId: id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          tableCycleId: cycle.id,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(amount),
          metadata: {
            tableId,
            effectiveAt: effective.toISOString(),
            late: input.effectiveAt !== undefined,
          },
        },
        tx
      )
      return { id, replayed: false }
    }, TX)
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await prisma.rakeMovement.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
    }
    throw e
  }
}

// ── Conteo del recipiente ─────────────────────────────────────────────

export async function confirmRakeCount(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: RakeCountInput,
  ctx: RequestContext = {}
) {
  const counted = dec(input.countedAmount)
  if (counted.isZero() && input.zeroConfirmed !== true)
    throw new BusinessRuleError(
      "El recipiente está vacío: confirma expresamente que no hubo rake."
    )
  const replay = await prisma.rakeCount.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, cycleId: true, countedAmount: true },
  })
  if (replay) {
    if (
      replay.cycleId !== input.cycleId ||
      !dec(replay.countedAmount).equals(counted)
    )
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, difference: null, replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSessionInTx(tx, sessionId, "contar el rake")
      const { cycle, table, count } = await lockCycleInTx(
        tx,
        sessionId,
        tableId,
        input.cycleId
      )
      if (cycle.status !== "CLOSED")
        throw new BusinessRuleError(
          "Cierra la mesa (su ciclo) antes de contar el recipiente de rake."
        )
      if (count)
        throw new ConflictError("El recipiente de ese ciclo ya se contó.")
      const entries = await tx.rakeMovement.aggregate({
        where: { cycleId: cycle.id },
        _sum: { amount: true },
      })
      const registered = dec(entries._sum.amount)
      const manualEntries = await tx.rakeMovement.count({
        where: { cycleId: cycle.id, kind: "MANUAL_ENTRY" },
      })
      // Un ciclo con registros manuales se COMPRUEBA (aunque la mesa haya
      // cambiado de modalidad después): nunca se cuenta dos veces.
      const mode: RakeModeValue = manualEntries > 0 ? "MANUAL" : table.rakeMode
      const id = newId("rkc")
      // FINAL_COUNT: el conteo ES el rake y sus fichas entran a custodia.
      // MANUAL: comprobación (cada registro ya entró); solo se compara.
      const operationId =
        mode === "FINAL_COUNT" && counted.greaterThan(0)
          ? await nominalEffectInTx(
              tx,
              actor,
              {
                amount: counted,
                referenceType: "RakeCount",
                referenceId: id,
                sessionId,
                tableId,
                idempotencyKey: `rake_${input.idempotencyKey}`,
              },
              ctx
            )
          : null
      await tx.rakeCount.create({
        data: {
          id,
          sessionId,
          tableId,
          cycleId: cycle.id,
          modeSnapshot: mode,
          registeredAmount: registered.lessThan(0) ? ZERO : registered,
          countedAmount: counted,
          zeroConfirmed: counted.isZero(),
          chipOperationId: operationId,
          notes: input.notes ?? null,
          countedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      const difference = mode === "MANUAL" ? counted.sub(registered) : ZERO
      await recordAudit(
        {
          action: AUDIT_ACTIONS.RAKE_FINAL_COUNT_CONFIRMED,
          entityType: "RakeCount",
          entityId: id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          tableCycleId: cycle.id,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(counted),
          metadata: {
            tableId,
            mode,
            registered: fmt(registered),
            difference: fmt(difference),
            chipOperationId: operationId,
          },
        },
        tx
      )
      return { id, difference: fmt(difference), replayed: false }
    }, TX)
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await prisma.rakeCount.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, difference: null, replayed: true }
      throw new ConflictError("El recipiente de ese ciclo ya se contó.")
    }
    throw e
  }
}

// ── Corrección auditable ──────────────────────────────────────────────

/**
 * Corrige un registro manual o un conteo final con un movimiento NUEVO
 * (±) y motivo obligatorio. Lo capturado originalmente se conserva; el
 * efecto en el inventario es el real (fichas que sí/no estaban en el
 * recipiente). El rake reconocido del ciclo nunca queda negativo.
 */
export async function recordRakeCorrection(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: RakeCorrectionInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  const replay = await prisma.rakeMovement.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, cycleId: true },
  })
  if (replay) {
    if (replay.cycleId !== input.cycleId)
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, replayed: true }
  }
  return prisma.$transaction(async (tx) => {
    await lockSessionInTx(tx, sessionId, "corregir el rake")
    const { cycle, count } = await lockCycleInTx(
      tx,
      sessionId,
      tableId,
      input.cycleId
    )
    const target = input.movementId
      ? await tx.rakeMovement.findFirst({
          where: {
            id: input.movementId,
            cycleId: cycle.id,
            kind: "MANUAL_ENTRY",
          },
          select: { id: true },
        })
      : null
    if (input.movementId && !target)
      throw new NotFoundError("Registro de rake no encontrado en ese ciclo")
    // Sin registro concreto, la corrección se hace contra el CONTEO del
    // recipiente: en conteo final corrige el rake contado; en captura
    // manual reconoce la diferencia que encontró la comprobación (p. ej.
    // rake contado que no se capturó durante la mesa).
    if (!target && !count)
      throw new BusinessRuleError(
        "Indica el registro a corregir o cuenta primero el recipiente."
      )
    const all = await tx.rakeMovement.aggregate({
      where: { cycleId: cycle.id },
      _sum: { amount: true },
    })
    const base =
      count?.modeSnapshot === "FINAL_COUNT" ? dec(count.countedAmount) : ZERO
    if (base.add(dec(all._sum.amount)).add(amount).lessThan(0))
      throw new BusinessRuleError(
        "La corrección dejaría el rake del ciclo en negativo."
      )
    const id = newId("rkm")
    const operationId = await nominalEffectInTx(
      tx,
      actor,
      {
        amount,
        referenceType: "RakeMovement",
        referenceId: id,
        sessionId,
        tableId,
        idempotencyKey: `rake_${input.idempotencyKey}`,
      },
      ctx
    )
    await tx.rakeMovement.create({
      data: {
        id,
        sessionId,
        tableId,
        cycleId: cycle.id,
        kind: "CORRECTION",
        amount,
        modeSnapshot: count?.modeSnapshot ?? "MANUAL",
        effectiveAt: new Date(),
        recordedById: actor.id,
        reason: input.reason,
        correctsMovementId: target?.id ?? null,
        correctsCountId: target ? null : count!.id,
        chipOperationId: operationId,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.RAKE_CORRECTED,
        entityType: "RakeMovement",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        sessionId,
        tableCycleId: cycle.id,
        idempotencyKey: input.idempotencyKey,
        amount: fmt(amount),
        reason: input.reason,
        metadata: {
          tableId,
          correctsMovementId: target?.id ?? null,
          correctsCountId: target ? null : count!.id,
        },
      },
      tx
    )
    return { id, replayed: false }
  }, TX)
}

// ── Configuración de la modalidad ─────────────────────────────────────

export async function setTableRakeMode(
  actor: SessionUser,
  tableId: string,
  input: RakeModeInput,
  ctx: RequestContext = {}
) {
  if (!roleHasPermission(actor.role, PERMISSIONS.RAKE_AUTHORIZE)) {
    await recordAudit({
      action: AUDIT_ACTIONS.RAKE_AUTHORIZATION_DENIED,
      entityType: "PokerTable",
      entityId: tableId,
      actorUserId: actor.id,
      actorRole: actor.role,
      result: "DENIED",
      requestId: ctx.requestId,
      reason: input.reason,
      metadata: { operation: "MODE_CHANGE", to: input.mode },
    })
    throw new ForbiddenError(
      "Cambiar la modalidad de rake requiere PARTNER o SUPERADMIN."
    )
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ rakeMode: string }[]>`
      SELECT "rakeMode"::text AS "rakeMode" FROM "poker_tables" WHERE "id" = ${tableId} FOR UPDATE`
    if (rows.length === 0) throw new NotFoundError("Mesa no encontrada")
    const from = rows[0].rakeMode
    if (from === input.mode) return { mode: from, changed: false }
    const openCycles = await tx.sessionTableCycle.count({
      where: { status: "OPEN", sessionTable: { tableId } },
    })
    const blocker = rakeModeChangeBlocker({ openCycles })
    if (blocker) throw new BusinessRuleError(blocker)
    await tx.pokerTable.update({
      where: { id: tableId },
      data: { rakeMode: input.mode, updatedById: actor.id },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.RAKE_MODE_CHANGED,
        entityType: "PokerTable",
        entityId: tableId,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.reason,
        metadata: { from, to: input.mode },
      },
      tx
    )
    return { mode: input.mode, changed: true }
  }, TX)
}
