import "server-only"

import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { UpdatePaymentMethodInput } from "@/modules/settings/settings.schemas"

/**
 * Métodos por los que entra dinero real: CASH, BANK_TRANSFER y, desde el
 * Módulo 08, CARD_DEBIT y CARD_CREDIT cobrados en terminal física (PAY-04:
 * se contabilizan por separado). Catálogo cerrado: no hay alta ni borrado
 * (PAY-02), solo nombre, orden y activación (PAY-03).
 *
 * No existe "MIXED": un pago mixto será una operación con componentes de
 * efectivo y transferencia. No existe "CREDIT": el crédito es una cuenta
 * por cobrar, no dinero (PAY-06/07). Este módulo no registra operaciones
 * (PAY-05).
 */

export type PaymentMethodView = {
  id: string
  code: "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT"
  name: string
  isActive: boolean
  sortOrder: number
  updatedAt: string
}

const select = {
  id: true,
  code: true,
  name: true,
  isActive: true,
  sortOrder: true,
  updatedAt: true,
} as const

export async function listPaymentMethods(options: {
  includeInactive: boolean
}): Promise<PaymentMethodView[]> {
  const methods = await prisma.paymentMethod.findMany({
    where: options.includeInactive ? undefined : { isActive: true },
    select,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  })
  return methods.map((m) => ({ ...m, updatedAt: m.updatedAt.toISOString() }))
}

export async function updatePaymentMethod(
  actor: SessionUser,
  id: string,
  input: UpdatePaymentMethodInput,
  ctx: RequestContext = {}
): Promise<PaymentMethodView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.paymentMethod.findUnique({ where: { id }, select })
    if (!before) throw new NotFoundError("Método de pago no encontrado")

    if (input.isActive === false && before.isActive) {
      const othersActive = await tx.paymentMethod.count({
        where: { isActive: true, id: { not: id } },
      })
      if (othersActive === 0) {
        throw new BusinessRuleError(
          "Debe quedar al menos un método de pago activo"
        )
      }
    }

    const updated = await tx.paymentMethod.update({
      where: { id },
      data: { ...input, updatedById: actor.id },
      select,
    })

    const changes = diffChanges(before, input)
    if (changes) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PAYMENT_METHOD_UPDATED,
          entityType: "PaymentMethod",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { code: before.code, changes },
        },
        tx
      )
    }
    return { ...updated, updatedAt: updated.updatedAt.toISOString() }
  })
}
