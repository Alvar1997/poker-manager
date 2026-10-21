import "server-only"

import { canonicalHash } from "@/lib/canonical-json"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { Tx } from "@/modules/cash/ledger"
import {
  discardStagedFile,
  promoteStoredFileInTx,
  readEvidence,
  stagePrivateFile,
} from "@/modules/signatures/evidence-storage"
import { renderDocumentPng } from "@/modules/signatures/receipt-image"
import {
  assertMeaningfulSignature,
  renderSignaturePng,
  type Strokes,
} from "@/modules/signatures/signature.strokes"

import { SPECIAL_DECLARATION_VERSION } from "./special.math"

/**
 * Evidencia firmada y comprobantes complementarios del Módulo 16.
 *
 * - El navegador envía TRAZOS; el servidor genera el PNG y lo guarda en el
 *   almacenamiento privado (Módulo 09). El contenido aceptado es un JSON
 *   canónico preparado por el SERVIDOR con su huella SHA-256.
 * - Los comprobantes son snapshots inmutables (PNG generado desde el
 *   snapshot; sin PDF; compartición manual). Nunca se envía WhatsApp.
 */

export type ReceiptLine = { label: string; value: string; strong?: boolean }

/** Paso previo (fuera de la transacción): valida trazos y sube el PNG. */
export async function stageSpecialSignature(
  actor: SessionUser,
  strokes: Strokes
) {
  try {
    assertMeaningfulSignature(strokes)
  } catch (e) {
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "La firma no es válida"
    )
  }
  const png = renderSignaturePng(strokes)
  const file = await stagePrivateFile({
    bytes: png,
    mimeType: "image/png",
    purpose: "SPECIAL_OPERATION_SIGNATURE",
    createdById: actor.id,
  })
  return file.id
}

export async function discardSpecialSignature(fileId: string | null) {
  if (fileId) await discardStagedFile(fileId, "special-operation-failed")
}

/** Dentro de la transacción del negocio: evidencia definitiva e inmutable. */
export async function recordSpecialEvidenceInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    fileId: string
    sourceType: "LateChipRedemption" | "SettlementCorrection"
    sourceId: string
    content: Record<string, unknown>
    declarationText: string
    signerName: string
    playerId: string | null
  },
  ctx: RequestContext = {}
) {
  await promoteStoredFileInTx(tx, input.fileId, { standalone: true })
  const content = {
    ...input.content,
    declaration: input.declarationText,
    declarationVersion: SPECIAL_DECLARATION_VERSION,
  }
  const contentHash = canonicalHash(content)
  const ev = await tx.specialOperationEvidence.create({
    data: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      content: content as object,
      contentHash,
      declarationText: input.declarationText,
      signerName: input.signerName,
      playerId: input.playerId,
      fileId: input.fileId,
      capturedById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SPECIAL_EVIDENCE_CAPTURED,
      entityType: input.sourceType,
      entityId: input.sourceId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      playerId: input.playerId,
      evidenceRef: ev.id,
      metadata: { evidenceId: ev.id, contentDigest: contentHash },
    },
    tx
  )
  return ev.id
}

/** Comprobante complementario: snapshot inmutable (una vez por origen). */
export async function createSpecialReceiptInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    kind:
      | "REDEMPTION_RECEIPT"
      | "SPECIAL_PAYOUT"
      | "PURCHASE_REVERSAL"
      | "SETTLEMENT_CORRECTION"
      | "UNAPPLIED_REFUND"
    sourceKey: string
    kicker: string
    title: string
    lines: ReceiptLine[]
    footer: string
    evidenceFileId?: string | null
  }
) {
  const content = {
    kicker: input.kicker,
    title: input.title,
    date: new Date().toISOString(),
    lines: input.lines,
    footer: input.footer,
    evidenceFileId: input.evidenceFileId ?? null,
  }
  return tx.specialOperationReceipt.create({
    data: {
      kind: input.kind,
      sourceKey: input.sourceKey,
      title: input.title,
      content,
      contentHash: canonicalHash(content),
      createdById: actor.id,
    },
    select: { id: true },
  })
}

const dateFmt = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Monterrey",
  dateStyle: "medium",
  timeStyle: "short",
})

/** PNG del comprobante, siempre desde su snapshot (no cambia después). */
export async function renderSpecialReceiptPng(receiptId: string) {
  const r = await prisma.specialOperationReceipt.findUnique({
    where: { id: receiptId },
  })
  if (!r) throw new NotFoundError("Comprobante no encontrado")
  const c = r.content as {
    kicker: string
    title: string
    date: string
    lines: ReceiptLine[]
    footer: string
    evidenceFileId: string | null
  }
  const signature = c.evidenceFileId
    ? await readEvidence(c.evidenceFileId)
    : null
  const png = await renderDocumentPng({
    kicker: c.kicker,
    title: c.title,
    date: dateFmt.format(new Date(c.date)),
    voided: false,
    okLabel: "REGISTRADO",
    lines: c.lines,
    signaturePng: signature?.bytes ?? null,
    signatureLabel: "Firma de aceptación",
    footer: c.footer,
  })
  return {
    png,
    filename: `${r.kind.toLowerCase()}-${r.id}.png`,
    receipt: r,
  }
}

export function receiptView(r: {
  id: string
  kind: string
  title: string
  content: unknown
  createdAt: Date
}) {
  const c = r.content as { lines: ReceiptLine[]; footer: string; date: string }
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    lines: c.lines,
    footer: c.footer,
    date: c.date,
    createdAt: r.createdAt.toISOString(),
  }
}
