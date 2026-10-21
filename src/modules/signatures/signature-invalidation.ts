import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"

/**
 * Invalida (o cancela) la firma VALID de una compra AÚN NO ENTREGADA, dentro
 * de la transacción que hace el cambio material. La firma anterior se
 * conserva como evidencia con motivo, responsable y fecha; nunca se borra
 * ni se sobrescribe. Después de entregar, la base impide invalidarla (un
 * abono posterior no afecta la firma original).
 *
 * No importa servicios de compras (evita ciclos): lo llaman los servicios
 * del Módulo 08 y la integración con transferencias.
 */
export async function invalidatePurchaseSignaturesInTx(
  tx: Prisma.TransactionClient,
  input: {
    purchaseId: string
    actorId: string
    reason: string
    /** CANCELLED cuando la compra se cancela; INVALIDATED en cambios materiales. */
    status?: "INVALIDATED" | "CANCELLED"
  },
  ctx: { requestId?: string | null } = {}
) {
  const status = input.status ?? "INVALIDATED"
  const valid = await tx.purchaseSignature.findMany({
    where: { purchaseId: input.purchaseId, status: "VALID" },
    select: {
      id: true,
      playerId: true,
      snapshot: { select: { payloadHash: true, sessionId: true } },
    },
  })
  for (const s of valid) {
    const { count } = await tx.purchaseSignature.updateMany({
      where: { id: s.id, status: "VALID" },
      data: {
        status,
        invalidatedAt: new Date(),
        invalidatedById: input.actorId,
        invalidationReason: input.reason,
      },
    })
    if (count !== 1) continue
    await recordAudit(
      {
        action:
          status === "CANCELLED"
            ? AUDIT_ACTIONS.SIGNATURE_CANCELLED
            : AUDIT_ACTIONS.SIGNATURE_INVALIDATED,
        entityType: "PurchaseSignature",
        entityId: s.id,
        actorUserId: input.actorId,
        requestId: ctx.requestId,
        metadata: {
          purchaseId: input.purchaseId,
          playerId: s.playerId,
          sessionId: s.snapshot.sessionId,
          snapshotDigest: s.snapshot.payloadHash,
          reason: input.reason,
        },
      },
      tx
    )
  }
  return valid.length
}
