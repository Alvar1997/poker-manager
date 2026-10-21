import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  formatFolio,
  type UpdateFolioSequenceInput,
} from "@/modules/settings/settings.schemas"

/**
 * Folios visibles por tipo de documento (SES-000001, CMP-000001…).
 *
 * - Únicos por tipo y sin duplicados por concurrencia (FOL-01/02/03):
 *   `issueFolio` incrementa con un solo `UPDATE … RETURNING`, atómico en
 *   PostgreSQL, y debe llamarse DENTRO de la transacción del documento que
 *   lo usa (si esa transacción falla, el número no se consume).
 * - Un folio emitido nunca se reutiliza (FOL-05): cancelar un documento
 *   será un cambio de estado del documento, no una devolución del número.
 * - El formato (prefijo, relleno, siguiente número) solo se edita ANTES
 *   del primer folio emitido (FOL-04/07).
 * - El folio es independiente del id interno (FOL-06).
 *
 * En el Módulo 02 ningún endpoint emite folios: no hay documentos reales.
 */

export type FolioDocumentType =
  | "SESSION"
  | "PURCHASE"
  | "DEBT_PAYMENT"
  | "SETTLEMENT"
  | "CASH_MOVEMENT"
  | "CHIP_MOVEMENT"
  | "CASH_CLOSING"
  | "CORRECTION"
  | "INCIDENT"
  | "REDEMPTION"
  | "PURCHASE_REVERSAL"
  | "SETTLEMENT_CORRECTION"
  | "SPECIAL_PAYOUT"

export const FOLIO_DOCUMENT_LABEL: Record<FolioDocumentType, string> = {
  SESSION: "Sesiones",
  PURCHASE: "Compras y recompras",
  DEBT_PAYMENT: "Abonos a deuda",
  SETTLEMENT: "Liquidaciones",
  CASH_MOVEMENT: "Movimientos de caja",
  CHIP_MOVEMENT: "Movimientos de fichas",
  CASH_CLOSING: "Cierres de caja",
  CORRECTION: "Solicitudes de corrección",
  INCIDENT: "Incidencias",
  REDEMPTION: "Canjes posteriores de fichas",
  PURCHASE_REVERSAL: "Reversos de compras",
  SETTLEMENT_CORRECTION: "Correcciones de liquidaciones",
  SPECIAL_PAYOUT: "Pagos de operaciones especiales",
}

export type FolioSequenceView = {
  id: string
  documentType: FolioDocumentType
  label: string
  prefix: string
  nextNumber: number
  padding: number
  isActive: boolean
  lastIssuedAt: string | null
  /** true tras el primer folio emitido: el formato ya no es editable. */
  locked: boolean
  preview: string
}

const select = {
  id: true,
  documentType: true,
  prefix: true,
  nextNumber: true,
  padding: true,
  isActive: true,
  lastIssuedAt: true,
} as const

type FolioRecord = Prisma.FolioSequenceGetPayload<{ select: typeof select }>

function toView(f: FolioRecord): FolioSequenceView {
  return {
    ...f,
    label: FOLIO_DOCUMENT_LABEL[f.documentType],
    lastIssuedAt: f.lastIssuedAt?.toISOString() ?? null,
    locked: f.lastIssuedAt !== null,
    preview: formatFolio(f.prefix, f.nextNumber, f.padding),
  }
}

const ORDER: FolioDocumentType[] = [
  "SESSION",
  "PURCHASE",
  "DEBT_PAYMENT",
  "SETTLEMENT",
  "CASH_MOVEMENT",
  "CHIP_MOVEMENT",
  "CASH_CLOSING",
]

export async function listFolioSequences(): Promise<FolioSequenceView[]> {
  const sequences = await prisma.folioSequence.findMany({ select })
  return sequences
    .map(toView)
    .sort(
      (a, b) => ORDER.indexOf(a.documentType) - ORDER.indexOf(b.documentType)
    )
}

export async function updateFolioSequence(
  actor: SessionUser,
  id: string,
  input: UpdateFolioSequenceInput,
  ctx: RequestContext = {}
): Promise<FolioSequenceView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.folioSequence.findUnique({ where: { id }, select })
    if (!before) throw new NotFoundError("Consecutivo no encontrado")

    // Actualización condicionada: si entre la lectura y la escritura se
    // emitió un folio, no se aplica (evita carrera con issueFolio).
    const { count } = await tx.folioSequence.updateMany({
      where: { id, lastIssuedAt: null },
      data: { ...input, updatedById: actor.id },
    })
    if (count === 0) {
      throw new BusinessRuleError(
        "Este consecutivo ya emitió folios: su formato y numeración no pueden cambiarse"
      )
    }

    const changes = diffChanges(before, input)
    if (changes) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.FOLIO_SEQUENCE_UPDATED,
          entityType: "FolioSequence",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { documentType: before.documentType, changes },
        },
        tx
      )
    }

    const updated = await tx.folioSequence.findUniqueOrThrow({
      where: { id },
      select,
    })
    return toView(updated)
  })
}

/**
 * Emite el siguiente folio de forma atómica. Uso futuro (sesiones,
 * compras…), siempre con el cliente de la transacción del documento.
 */
export async function issueFolio(
  db: Prisma.TransactionClient | typeof prisma,
  documentType: FolioDocumentType
): Promise<string> {
  const rows = await db.$queryRaw<
    { prefix: string; issued: number; padding: number }[]
  >`
    UPDATE "folio_sequences"
    SET "nextNumber" = "nextNumber" + 1,
        "lastIssuedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "documentType" = ${documentType}::"FolioDocumentType"
      AND "isActive" = true
    RETURNING "prefix", "nextNumber" - 1 AS "issued", "padding"
  `
  const row = rows[0]
  if (!row) {
    throw new BusinessRuleError(
      `No hay un consecutivo activo para ${FOLIO_DOCUMENT_LABEL[documentType]}`
    )
  }
  return formatFolio(row.prefix, Number(row.issued), row.padding)
}
