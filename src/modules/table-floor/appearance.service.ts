import "server-only"

import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { FeltColor } from "@/modules/table-floor/table-floor.math"

/**
 * Color del paño por mesa del catálogo. SOLO visual: no toca caja,
 * inventario, compras, deudas, liquidaciones, participaciones ni reportes.
 * Pertenece a la mesa (25/25 y 10/10 son independientes) y persiste entre
 * ciclos. Idempotente: el mismo color no genera evento.
 */
export async function setTableFeltColor(
  actor: SessionUser,
  tableId: string,
  feltColor: FeltColor,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "poker_tables" WHERE "id" = ${tableId} FOR UPDATE`
    const table = await tx.pokerTable.findUnique({
      where: { id: tableId },
      select: { id: true, name: true, feltColor: true },
    })
    if (!table) throw new NotFoundError("Mesa no encontrada")
    if (table.feltColor === feltColor)
      return { tableId, feltColor, changed: false }
    await tx.pokerTable.update({
      where: { id: tableId },
      data: { feltColor, updatedById: actor.id },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.TABLE_FELT_COLOR_CHANGED,
        entityType: "PokerTable",
        entityId: tableId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { table: table.name, from: table.feltColor, to: feltColor },
      },
      tx
    )
    return { tableId, feltColor, changed: true }
  })
}
