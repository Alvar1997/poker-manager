import "server-only"

import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

import type { CreateStaffInput, UpdateStaffInput } from "./tips.schemas"

/**
 * Catálogo de staff (Módulo 18): dealers, meseros y otros puestos. Sin
 * usuario, contraseña ni rol; nunca se borra (se desactiva).
 */

export async function listPositions() {
  return prisma.staffPosition.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, code: true, name: true, isActive: true },
  })
}

export async function createPosition(
  actor: SessionUser,
  input: { code: string; name: string },
  ctx: RequestContext = {}
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const max = await tx.staffPosition.aggregate({
        _max: { sortOrder: true },
      })
      const p = await tx.staffPosition.create({
        data: {
          code: input.code,
          name: input.name,
          sortOrder: (max._max.sortOrder ?? 0) + 1,
        },
        select: { id: true, code: true, name: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.STAFF_MEMBER_UPDATED,
          entityType: "StaffPosition",
          entityId: p.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          metadata: { operation: "POSITION_CREATED", code: p.code },
        },
        tx
      )
      return p
    })
  } catch (e) {
    if (isUniqueViolation(e))
      throw new ConflictError("Ya existe un puesto con ese código")
    throw e
  }
}

const staffSelect = {
  id: true,
  name: true,
  phone: true,
  isActive: true,
  notes: true,
  createdAt: true,
  position: { select: { id: true, code: true, name: true } },
  dealer: { select: { id: true, name: true } },
} as const

export async function listStaff(q: { active?: boolean } = {}) {
  const rows = await prisma.staffMember.findMany({
    where: q.active === undefined ? {} : { isActive: q.active },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { ...staffSelect, _count: { select: { sessions: true } } },
  })
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    sessions: r._count.sessions,
  }))
}
export type StaffListItem = Awaited<ReturnType<typeof listStaff>>[number]

export async function createStaff(
  actor: SessionUser,
  input: CreateStaffInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const position = await tx.staffPosition.findUnique({
      where: { id: input.positionId },
      select: { isActive: true, code: true },
    })
    if (!position || !position.isActive)
      throw new BusinessRuleError("Elige un puesto activo")
    if (input.dealerId) {
      const d = await tx.dealer.findUnique({
        where: { id: input.dealerId },
        select: { id: true, staffMember: { select: { id: true } } },
      })
      if (!d) throw new NotFoundError("Dealer no encontrado")
      if (d.staffMember)
        throw new ConflictError("Ese dealer ya está ligado a otro empleado")
    }
    const m = await tx.staffMember.create({
      data: {
        name: input.name,
        positionId: input.positionId,
        phone: input.phone || null,
        dealerId: input.dealerId ?? null,
        notes: input.notes ?? null,
        createdById: actor.id,
      },
      select: staffSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STAFF_MEMBER_CREATED,
        entityType: "StaffMember",
        entityId: m.id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { name: m.name, position: position.code },
      },
      tx
    )
    return m
  })
}

export async function updateStaff(
  actor: SessionUser,
  id: string,
  input: UpdateStaffInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.staffMember.findUnique({
      where: { id },
      select: {
        name: true,
        positionId: true,
        phone: true,
        isActive: true,
        notes: true,
      },
    })
    if (!before) throw new NotFoundError("Empleado no encontrado")
    if (input.positionId) {
      const p = await tx.staffPosition.findUnique({
        where: { id: input.positionId },
        select: { isActive: true },
      })
      if (!p?.isActive) throw new BusinessRuleError("Elige un puesto activo")
    }
    const changes = diffChanges(before, input)
    if (!changes)
      return tx.staffMember.findUniqueOrThrow({
        where: { id },
        select: staffSelect,
      })
    const m = await tx.staffMember.update({
      where: { id },
      data: { ...input, updatedById: actor.id },
      select: staffSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STAFF_MEMBER_UPDATED,
        entityType: "StaffMember",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { changes },
      },
      tx
    )
    return m
  })
}
