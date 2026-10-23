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
import { formatSessionFolio } from "@/modules/sessions/session-folio"

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
    // Sesiones: S-0001-AAAAMMDD (la fecha operativa se agrega al crearla).
    preview:
      f.documentType === "SESSION"
        ? `${formatFolio("S", f.nextNumber, 4)}-AAAAMMDD`
        : formatFolio(f.prefix, f.nextNumber, f.padding),
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
    // El folio de sesión tiene formato FIJO (S-0001-AAAAMMDD): solo se
    // puede ajustar el número inicial antes de emitir el primero.
    if (
      before.documentType === "SESSION" &&
      (input.prefix !== undefined || input.padding !== undefined)
    ) {
      throw new BusinessRuleError(
        "El folio de sesión tiene formato fijo (S-0001-AAAAMMDD): solo puede ajustarse el número inicial."
      )
    }

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

/**
 * Folio de SESIÓN (S-0001-YYYYMMDD): consecutivo GLOBAL del tipo SESSION
 * emitido con el mismo `UPDATE … RETURNING` atómico (la fila queda
 * bloqueada hasta el fin de la transacción: dos creaciones simultáneas
 * nunca obtienen el mismo número) + fecha operativa. Nunca MAX()+1. Si la
 * transacción falla, el número no se consume.
 */
export async function issueSessionFolio(
  db: Prisma.TransactionClient,
  businessDate: string
): Promise<{ sequenceNumber: number; folio: string }> {
  const rows = await db.$queryRaw<{ issued: number }[]>`
    UPDATE "folio_sequences"
    SET "nextNumber" = "nextNumber" + 1,
        "lastIssuedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "documentType" = 'SESSION'::"FolioDocumentType"
      AND "isActive" = true
    RETURNING "nextNumber" - 1 AS "issued"
  `
  const row = rows[0]
  if (!row)
    throw new BusinessRuleError(
      `No hay un consecutivo activo para ${FOLIO_DOCUMENT_LABEL.SESSION}`
    )
  const sequenceNumber = Number(row.issued)
  return {
    sequenceNumber,
    folio: formatSessionFolio(sequenceNumber, businessDate),
  }
}

/**
 * Vista previa PROVISIONAL del siguiente folio de sesión (no reserva el
 * número: el definitivo lo asigna el servidor al crear).
 */
export async function previewSessionFolio(businessDate: string) {
  const row = await prisma.folioSequence.findFirst({
    where: { documentType: "SESSION", isActive: true },
    select: { nextNumber: true },
  })
  if (!row)
    throw new BusinessRuleError(
      `No hay un consecutivo activo para ${FOLIO_DOCUMENT_LABEL.SESSION}`
    )
  return {
    provisional: true as const,
    nextSequenceNumber: row.nextNumber,
    folio: formatSessionFolio(row.nextNumber, businessDate),
  }
}
