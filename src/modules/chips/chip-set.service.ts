import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { moneyToString } from "@/lib/money"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
  type DbClient,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type {
  CreateChipSetInput,
  CreateDenominationInput,
  UpdateChipSetInput,
  UpdateDenominationInput,
} from "@/modules/settings/settings.schemas"

/**
 * Juegos FÍSICOS de fichas y sus denominaciones (solo catálogo).
 *
 * - Cada juego es una identidad de inventario propia (CHIP-05/CHIP-10): la
 *   existencia física se modelará por (juego, denominación) en el
 *   inventario, nunca por mesa.
 * - Sin cantidades ni saldos (DEN-12): aquí no se captura inventario.
 * - Sin borrado físico: solo activar/desactivar (CHIP-07/08, DEN-09/10).
 * - Valor duplicado en el mismo juego → 409 (DEN-05); el mismo valor en
 *   juegos distintos sí se permite (DEN-06).
 * - DEN-11 (no cambiar el valor de una denominación con movimientos): hoy
 *   no existen movimientos de fichas; el módulo de inventario deberá
 *   bloquear el cambio de `value` cuando los haya.
 */

export type DenominationView = {
  id: string
  chipSetId: string
  value: string
  name: string | null
  color: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ChipSetView = {
  id: string
  code: string
  name: string
  description: string | null
  isActive: boolean
  activeDenominations: number
  totalDenominations: number
  tables: { id: string; code: string; name: string; isActive: boolean }[]
  /** Requiere al menos una denominación activa antes de usarse en una sesión. */
  needsDenominations: boolean
  createdAt: string
  updatedAt: string
}

const denominationSelect = {
  id: true,
  chipSetId: true,
  value: true,
  name: true,
  color: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

type DenominationRecord = Prisma.ChipDenominationGetPayload<{
  select: typeof denominationSelect
}>

function toDenominationView(d: DenominationRecord): DenominationView {
  return {
    ...d,
    value: moneyToString(d.value),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }
}

const chipSetSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  denominations: { select: { isActive: true } },
  tables: {
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: { sortOrder: "asc" },
  },
} satisfies Prisma.ChipSetSelect

type ChipSetRecord = Prisma.ChipSetGetPayload<{ select: typeof chipSetSelect }>

function toChipSetView(set: ChipSetRecord): ChipSetView {
  const active = set.denominations.filter((d) => d.isActive).length
  return {
    id: set.id,
    code: set.code,
    name: set.name,
    description: set.description,
    isActive: set.isActive,
    activeDenominations: active,
    totalDenominations: set.denominations.length,
    tables: set.tables,
    needsDenominations: active === 0,
    createdAt: set.createdAt.toISOString(),
    updatedAt: set.updatedAt.toISOString(),
  }
}

export async function listChipSets(options: {
  includeInactive: boolean
}): Promise<ChipSetView[]> {
  const sets = await prisma.chipSet.findMany({
    where: options.includeInactive ? undefined : { isActive: true },
    select: chipSetSelect,
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  })
  return sets.map(toChipSetView)
}

export async function getChipSet(id: string): Promise<ChipSetView> {
  const set = await prisma.chipSet.findUnique({
    where: { id },
    select: chipSetSelect,
  })
  if (!set) throw new NotFoundError("Juego de fichas no encontrado")
  return toChipSetView(set)
}

export async function createChipSet(
  actor: SessionUser,
  input: CreateChipSetInput,
  ctx: RequestContext = {}
): Promise<ChipSetView> {
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.chipSet.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          createdById: actor.id,
          updatedById: actor.id,
        },
        select: chipSetSelect,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_SET_CREATED,
          entityType: "ChipSet",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { code: created.code, name: created.name },
        },
        tx
      )
      return toChipSetView(created)
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("Ya existe un juego de fichas con ese código")
    }
    throw error
  }
}

export async function updateChipSet(
  actor: SessionUser,
  id: string,
  input: UpdateChipSetInput,
  ctx: RequestContext = {}
): Promise<ChipSetView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.chipSet.findUnique({
      where: { id },
      select: { name: true, description: true },
    })
    if (!before) throw new NotFoundError("Juego de fichas no encontrado")

    const updated = await tx.chipSet.update({
      where: { id },
      data: { ...input, updatedById: actor.id },
      select: chipSetSelect,
    })

    const changes = diffChanges(before, input)
    if (changes) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_SET_UPDATED,
          entityType: "ChipSet",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { changes },
        },
        tx
      )
    }
    return toChipSetView(updated)
  })
}

/**
 * Desactivar un juego que es el juego asignado de una mesa ACTIVA dejaría
 * a esa mesa sin juego válido (TABLE-05): se exige reasignar o desactivar
 * la mesa primero.
 */
export async function setChipSetStatus(
  actor: SessionUser,
  id: string,
  isActive: boolean,
  ctx: RequestContext = {}
): Promise<ChipSetView> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.chipSet.findUnique({
      where: { id },
      select: { isActive: true },
    })
    if (!current) throw new NotFoundError("Juego de fichas no encontrado")

    if (current.isActive !== isActive) {
      if (!isActive) {
        const tables = await tx.pokerTable.findMany({
          where: { defaultChipSetId: id, isActive: true },
          select: { name: true },
        })
        if (tables.length > 0) {
          throw new BusinessRuleError(
            `Este juego está asignado a mesas activas (${tables
              .map((t) => t.name)
              .join(", ")}). Reasígnalas o desactívalas primero.`
          )
        }
      }

      await tx.chipSet.update({
        where: { id },
        data: { isActive, updatedById: actor.id },
      })
      await recordAudit(
        {
          action: isActive
            ? AUDIT_ACTIONS.CHIP_SET_ACTIVATED
            : AUDIT_ACTIONS.CHIP_SET_DEACTIVATED,
          entityType: "ChipSet",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
        },
        tx
      )
    }

    const set = await tx.chipSet.findUniqueOrThrow({
      where: { id },
      select: chipSetSelect,
    })
    return toChipSetView(set)
  })
}

// ── Denominaciones ────────────────────────────────────────────────────

export async function listDenominations(
  chipSetId: string,
  options: { includeInactive: boolean }
): Promise<DenominationView[]> {
  const set = await prisma.chipSet.findUnique({
    where: { id: chipSetId },
    select: { id: true },
  })
  if (!set) throw new NotFoundError("Juego de fichas no encontrado")

  const denominations = await prisma.chipDenomination.findMany({
    where: {
      chipSetId,
      ...(options.includeInactive ? {} : { isActive: true }),
    },
    select: denominationSelect,
    orderBy: [{ sortOrder: "asc" }, { value: "asc" }],
  })
  return denominations.map(toDenominationView)
}

const DUPLICATE_DENOMINATION =
  "Este juego ya tiene una denominación con ese valor"

export async function createDenomination(
  actor: SessionUser,
  chipSetId: string,
  input: CreateDenominationInput,
  ctx: RequestContext = {}
): Promise<DenominationView> {
  try {
    return await prisma.$transaction(async (tx) => {
      const set = await tx.chipSet.findUnique({
        where: { id: chipSetId },
        select: { id: true, code: true },
      })
      if (!set) throw new NotFoundError("Juego de fichas no encontrado")

      const created = await tx.chipDenomination.create({
        data: {
          chipSetId,
          value: input.value,
          name: input.name ?? null,
          color: input.color ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdById: actor.id,
          updatedById: actor.id,
        },
        select: denominationSelect,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.DENOMINATION_CREATED,
          entityType: "ChipDenomination",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            chipSetCode: set.code,
            value: moneyToString(created.value),
            name: created.name,
            color: created.color,
          },
        },
        tx
      )
      return toDenominationView(created)
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(DUPLICATE_DENOMINATION)
    throw error
  }
}

export async function updateDenomination(
  actor: SessionUser,
  id: string,
  input: UpdateDenominationInput,
  ctx: RequestContext = {}
): Promise<DenominationView> {
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.chipDenomination.findUnique({
        where: { id },
        select: denominationSelect,
      })
      if (!before) throw new NotFoundError("Denominación no encontrada")

      const updated = await tx.chipDenomination.update({
        where: { id },
        data: { ...input, updatedById: actor.id },
        select: denominationSelect,
      })

      const changes = diffChanges(
        { ...before, value: moneyToString(before.value) },
        input.value !== undefined
          ? { ...input, value: moneyToString(updated.value) }
          : input
      )
      if (changes) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.DENOMINATION_UPDATED,
            entityType: "ChipDenomination",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: { chipSetId: before.chipSetId, changes },
          },
          tx
        )
      }
      return toDenominationView(updated)
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(DUPLICATE_DENOMINATION)
    throw error
  }
}

export async function setDenominationStatus(
  actor: SessionUser,
  id: string,
  isActive: boolean,
  ctx: RequestContext = {}
): Promise<DenominationView> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.chipDenomination.findUnique({
      where: { id },
      select: denominationSelect,
    })
    if (!current) throw new NotFoundError("Denominación no encontrada")
    if (current.isActive === isActive) return toDenominationView(current)

    const updated = await tx.chipDenomination.update({
      where: { id },
      data: { isActive, updatedById: actor.id },
      select: denominationSelect,
    })
    await recordAudit(
      {
        action: isActive
          ? AUDIT_ACTIONS.DENOMINATION_ACTIVATED
          : AUDIT_ACTIONS.DENOMINATION_DEACTIVATED,
        entityType: "ChipDenomination",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          chipSetId: current.chipSetId,
          value: moneyToString(current.value),
        },
      },
      tx
    )
    return toDenominationView(updated)
  })
}

/** Juego existente y activo — usado al asignar el juego de una mesa. */
export async function assertActiveChipSet(db: DbClient, chipSetId: string) {
  const set = await db.chipSet.findUnique({
    where: { id: chipSetId },
    select: { id: true, isActive: true, code: true },
  })
  if (!set) throw new BusinessRuleError("El juego de fichas indicado no existe")
  if (!set.isActive) {
    throw new BusinessRuleError("El juego de fichas indicado está inactivo")
  }
  return set
}
