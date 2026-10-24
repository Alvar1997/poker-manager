import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  confirmNominalChipDeliveryInTx,
  confirmNominalChipReturnInTx,
  reserveNominalAmountInTx,
} from "@/modules/inventory/reservation.service"

/**
 * Efecto nominal REAL de un registro de rake o propinas (Módulo 18), con el
 * motor único del inventario compartido:
 *  - positivo: las fichas pasan a custodia de la casa (recipiente de rake o
 *    fichas recibidas del staff) → `confirmNominalChipReturnInTx`;
 *  - negativo (corrección de un registro de más): esas fichas nunca
 *    estuvieron en custodia → vuelven a circulación con reserva + entrega
 *    (el mismo contraasiento que usa el reverso de liquidaciones).
 * Nunca inventa fichas: siempre es el importe del registro confirmado.
 */
export async function nominalEffectInTx(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  p: {
    amount: Prisma.Decimal
    referenceType: string
    referenceId: string
    sessionId: string
    tableId?: string | null
    idempotencyKey: string
  },
  ctx: RequestContext = {}
): Promise<string> {
  if (p.amount.greaterThan(0)) {
    const op = await confirmNominalChipReturnInTx(
      tx,
      actor,
      {
        amount: p.amount.toFixed(2),
        referenceType: p.referenceType,
        referenceId: p.referenceId,
        sessionId: p.sessionId,
        tableId: p.tableId ?? null,
        idempotencyKey: `${p.idempotencyKey}-in`,
      },
      ctx
    )
    return op.operationId
  }
  const reservation = await reserveNominalAmountInTx(
    tx,
    actor,
    {
      amount: p.amount.abs(),
      referenceType: p.referenceType,
      referenceId: p.referenceId,
      sessionId: p.sessionId,
      tableId: p.tableId ?? null,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      idempotencyKey: `${p.idempotencyKey}-reserve`,
    },
    ctx
  )
  const op = await confirmNominalChipDeliveryInTx(
    tx,
    actor,
    reservation.id,
    `${p.idempotencyKey}-out`,
    ctx
  )
  return op.operationId
}
