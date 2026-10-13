import "server-only"

import { Prisma } from "@/generated/prisma/client"
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
import { assertActiveChipSet } from "@/modules/chips/chip-set.service"
import type {
  CreateTableInput,
  UpdateTableInput,
} from "@/modules/settings/settings.schemas"

/**
 * Catálogo de mesas (solo configuración: no abre ni cierra mesas).
 *
 * - Código único e inmutable (TABLE-01). Sin borrado: activar/desactivar
 *   (TABLE-02/03/04).
 * - Cada mesa activa tiene un juego de fichas existente y activo
 *   (TABLE-05), y un juego físico no puede ser el asignado de dos mesas
 *   activas a la vez: las fichas de un juego no se mezclan (CHIP-02/03).
 * - 0 < ciega chica ≤ ciega grande (también CHECK en BD).
 * - Cambiar ciegas o juego no altera sesiones pasadas: las sesiones
 *   (módulo posterior) guardarán su propia fotografía (TABLE-06/07, CHIP-09).
 * - Crear una mesa NO crea una caja: la caja central es única (TABLE-08).
 */

export type TableView = {
  id: string
  code: string
  name: string
  smallBlind: string
  bigBlind: string
  isActive: boolean
  sortOrder: number
  chipSet: {
    id: string
    code: string
    name: string
    isActive: boolean
    activeDenominations: number
  }
  /** Lista para usarse en una sesión: activa, juego activo y con denominaciones. */
  readyForSession: boolean
  pendingRequirements: string[]
  createdAt: string
  updatedAt: string
}

const tableSelect = {
  id: true,
  code: true,
  name: true,
  smallBlind: true,
  bigBlind: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  defaultChipSet: {
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      denominations: { where: { isActive: true }, select: { id: true } },
    },
  },
} satisfies Prisma.PokerTableSelect

type TableRecord = Prisma.PokerTableGetPayload<{ select: typeof tableSelect }>

function toTableView(table: TableRecord): TableView {
  const set = table.defaultChipSet
  const pending: string[] = []
  if (!table.isActive) pending.push("La mesa está inactiva")
  if (!set.isActive) pending.push("El juego de fichas asignado está inactivo")
  if (set.denominations.length === 0) {
    pending.push("El juego de fichas no tiene denominaciones activas")
  }

  return {
    id: table.id,
    code: table.code,
    name: table.name,
    smallBlind: moneyToString(table.smallBlind),
    bigBlind: moneyToString(table.bigBlind),
    isActive: table.isActive,
    sortOrder: table.sortOrder,
    chipSet: {
      id: set.id,
      code: set.code,
      name: set.name,
      isActive: set.isActive,
      activeDenominations: set.denominations.length,
    },
    readyForSession: pending.length === 0,
    pendingRequirements: pending,
    createdAt: table.createdAt.toISOString(),
    updatedAt: table.updatedAt.toISOString(),
  }
}

export async function listTables(options: {
  includeInactive: boolean
}): Promise<TableView[]> {
  const tables = await prisma.pokerTable.findMany({
    where: options.includeInactive ? undefined : { isActive: true },
    select: tableSelect,
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { code: "asc" }],
  })
  return tables.map(toTableView)
}

export async function getTable(id: string): Promise<TableView> {
  const table = await prisma.pokerTable.findUnique({
    where: { id },
    select: tableSelect,
  })
  if (!table) throw new NotFoundError("Mesa no encontrada")
  return toTableView(table)
}

function assertBlinds(
  smallBlind: string | Prisma.Decimal,
  bigBlind: string | Prisma.Decimal
) {
  if (new Prisma.Decimal(bigBlind).lessThan(new Prisma.Decimal(smallBlind))) {
    throw new BusinessRuleError(
      "La ciega grande no puede ser menor que la ciega chica"
    )
  }
}

async function assertChipSetFreeForTable(
  db: DbClient,
  chipSetId: string,
  exceptTableId?: string
) {
  const other = await db.pokerTable.findFirst({
    where: {
      defaultChipSetId: chipSetId,
      isActive: true,
      ...(exceptTableId ? { id: { not: exceptTableId } } : {}),
    },
    select: { name: true },
  })
  if (other) {
    throw new BusinessRuleError(
      `Ese juego físico de fichas ya está asignado a la mesa activa "${other.name}". Las fichas de un juego no se comparten entre mesas.`
    )
  }
}

export async function createTable(
  actor: SessionUser,
  input: CreateTableInput,
  ctx: RequestContext = {}
): Promise<TableView> {
  assertBlinds(input.smallBlind, input.bigBlind)

  try {
    return await prisma.$transaction(async (tx) => {
      const set = await assertActiveChipSet(tx, input.defaultChipSetId)
      await assertChipSetFreeForTable(tx, input.defaultChipSetId)

      const created = await tx.pokerTable.create({
        data: {
          code: input.code,
          name: input.name,
          smallBlind: input.smallBlind,
          bigBlind: input.bigBlind,
          defaultChipSetId: input.defaultChipSetId,
          sortOrder: input.sortOrder ?? 0,
          createdById: actor.id,
          updatedById: actor.id,
        },
        select: tableSelect,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.TABLE_CREATED,
          entityType: "PokerTable",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            code: created.code,
            name: created.name,
            smallBlind: moneyToString(created.smallBlind),
            bigBlind: moneyToString(created.bigBlind),
            chipSetCode: set.code,
          },
        },
        tx
      )
      return toTableView(created)
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("Ya existe una mesa con ese código")
    }
    throw error
  }
}

export async function updateTable(
  actor: SessionUser,
  id: string,
  input: UpdateTableInput,
  ctx: RequestContext = {}
): Promise<TableView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.pokerTable.findUnique({
      where: { id },
      select: {
        name: true,
        smallBlind: true,
        bigBlind: true,
        defaultChipSetId: true,
        sortOrder: true,
        isActive: true,
      },
    })
    if (!before) throw new NotFoundError("Mesa no encontrada")

    assertBlinds(
      input.smallBlind ?? before.smallBlind,
      input.bigBlind ?? before.bigBlind
    )

    if (
      input.defaultChipSetId !== undefined &&
      input.defaultChipSetId !== before.defaultChipSetId
    ) {
      await assertActiveChipSet(tx, input.defaultChipSetId)
      if (before.isActive) {
        await assertChipSetFreeForTable(tx, input.defaultChipSetId, id)
      }
    }

    const updated = await tx.pokerTable.update({
      where: { id },
      data: { ...input, updatedById: actor.id },
      select: tableSelect,
    })

    const changes = diffChanges(
      {
        ...before,
        smallBlind: moneyToString(before.smallBlind),
        bigBlind: moneyToString(before.bigBlind),
      },
      {
        ...input,
        smallBlind:
          input.smallBlind !== undefined
            ? moneyToString(updated.smallBlind)
            : undefined,
        bigBlind:
          input.bigBlind !== undefined
            ? moneyToString(updated.bigBlind)
            : undefined,
      }
    )
    if (changes) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.TABLE_UPDATED,
          entityType: "PokerTable",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { changes },
        },
        tx
      )
    }
    return toTableView(updated)
  })
}

/** Activar exige un juego activo y libre; desactivar conserva todo el historial. */
export async function setTableStatus(
  actor: SessionUser,
  id: string,
  isActive: boolean,
  ctx: RequestContext = {}
): Promise<TableView> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.pokerTable.findUnique({
      where: { id },
      select: { isActive: true, defaultChipSetId: true },
    })
    if (!current) throw new NotFoundError("Mesa no encontrada")

    if (current.isActive !== isActive) {
      if (isActive) {
        await assertActiveChipSet(tx, current.defaultChipSetId)
        await assertChipSetFreeForTable(tx, current.defaultChipSetId, id)
      }
      await tx.pokerTable.update({
        where: { id },
        data: { isActive, updatedById: actor.id },
      })
      await recordAudit(
        {
          action: isActive
            ? AUDIT_ACTIONS.TABLE_ACTIVATED
            : AUDIT_ACTIONS.TABLE_DEACTIVATED,
          entityType: "PokerTable",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
        },
        tx
      )
    }

    const table = await tx.pokerTable.findUniqueOrThrow({
      where: { id },
      select: tableSelect,
    })
    return toTableView(table)
  })
}
