import "server-only"

import { randomUUID } from "node:crypto"

import type { Prisma } from "@/generated/prisma/client"
import { sha256Hex } from "@/lib/canonical-json"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"

/**
 * Almacenamiento PRIVADO de evidencias (firmas de compras y de liquidaciones).
 *
 * El repositorio no tenía infraestructura de archivos ni credenciales de un
 * almacenamiento de objetos. Para no depender del disco temporal de una
 * instancia serverless ni de una carpeta pública, el driver por defecto
 * guarda el binario en PostgreSQL (`evidence_blobs`, tabla aparte; nunca en
 * `chip_purchases` ni como Base64). Solo el servidor lo lee, tras autorizar.
 * Otro driver (p. ej. S3/R2 privado) puede implementar la misma interfaz;
 * no se incluye porque no hay credenciales que lo configuren y no se simula.
 *
 * Consistencia (el almacenamiento externo no participa en la transacción
 * de PostgreSQL):
 *   1. `stagePrivateFile`: StoredFile PENDING + contenido (fuera de la tx).
 *   2. La transacción del negocio valida y llama a `promoteStoredFileInTx`
 *      (PENDING → ACTIVE, ligado a la compra).
 *   3. Si la transacción falla, `discardStagedFile` lo marca ORPHANED y
 *      borra el contenido; `cleanupOrphanedFiles` recupera fallos parciales
 *      (PENDING antiguos). Una evidencia ACTIVE nunca se borra (trigger).
 */

export interface EvidenceStorageDriver {
  readonly name: string
  put(key: string, bytes: Buffer): Promise<void>
  get(key: string): Promise<Buffer | null>
  remove(key: string): Promise<void>
}

export const postgresEvidenceDriver: EvidenceStorageDriver = {
  name: "postgres",
  async put(key, bytes) {
    await prisma.evidenceBlob.create({
      data: { storageKey: key, bytes: new Uint8Array(bytes) },
    })
  },
  async get(key) {
    const row = await prisma.evidenceBlob.findUnique({
      where: { storageKey: key },
      select: { bytes: true },
    })
    return row ? Buffer.from(row.bytes) : null
  },
  async remove(key) {
    await prisma.evidenceBlob.deleteMany({ where: { storageKey: key } })
  },
}

let driver: EvidenceStorageDriver = postgresEvidenceDriver

/** Permite registrar otro driver (configuración de despliegue o pruebas). */
export function registerEvidenceStorageDriver(d: EvidenceStorageDriver) {
  driver = d
}

export function evidenceStorage(): EvidenceStorageDriver {
  return driver
}

export const ALLOWED_MIME = "image/png"
export const MAX_EVIDENCE_BYTES = 200 * 1024

/** Paso 1: sube el contenido con estado PENDING (clave aleatoria, no enumerable). */
export async function stagePrivateFile(input: {
  bytes: Buffer
  mimeType: string
  purpose:
    | "PURCHASE_SIGNATURE"
    | "SETTLEMENT_SIGNATURE"
    | "SPECIAL_OPERATION_SIGNATURE"
  createdById: string
}) {
  if (input.mimeType !== ALLOWED_MIME)
    throw new Error("Tipo de archivo no permitido")
  if (input.bytes.length === 0 || input.bytes.length > MAX_EVIDENCE_BYTES)
    throw new Error("Tamaño de archivo no permitido")
  const storageKey = `evidence/${randomUUID()}`
  const file = await prisma.storedFile.create({
    data: {
      driver: driver.name,
      storageKey,
      purpose: input.purpose,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      sha256: sha256Hex(input.bytes),
      createdById: input.createdById,
    },
    select: { id: true, storageKey: true, sha256: true },
  })
  try {
    await driver.put(storageKey, input.bytes)
  } catch (error) {
    await discardStagedFile(file.id, "upload-failed")
    throw error
  }
  return file
}

/**
 * Paso 2 (dentro de la transacción del negocio): evidencia definitiva,
 * ligada a su compra (Módulo 09) o a su liquidación (Módulo 11).
 */
export async function promoteStoredFileInTx(
  tx: Prisma.TransactionClient,
  fileId: string,
  owner: string | { settlementId: string } | { standalone: true }
) {
  // Módulo 16: la evidencia de una operación especial se liga desde
  // `special_operation_evidence.fileId` (sin compra ni liquidación).
  const link =
    typeof owner === "string"
      ? { purchaseId: owner }
      : "settlementId" in owner
        ? { settlementId: owner.settlementId }
        : {}
  const { count } = await tx.storedFile.updateMany({
    where: { id: fileId, status: "PENDING" },
    data: { status: "ACTIVE", ...link, promotedAt: new Date() },
  })
  if (count !== 1)
    throw new Error("El archivo de evidencia ya no está pendiente")
}

/** Paso 3 (si la transacción falló): nunca fue evidencia → huérfano. */
export async function discardStagedFile(fileId: string, reason: string) {
  try {
    const file = await prisma.storedFile.findUnique({
      where: { id: fileId },
      select: { status: true, storageKey: true },
    })
    if (!file || file.status !== "PENDING") return
    await prisma.storedFile.update({
      where: { id: fileId },
      data: { status: "ORPHANED", orphanedAt: new Date() },
    })
    await driver.remove(file.storageKey)
    await recordAudit({
      action: AUDIT_ACTIONS.EVIDENCE_FILE_ORPHANED,
      entityType: "StoredFile",
      entityId: fileId,
      metadata: { reason },
    })
  } catch (error) {
    // Queda PENDING: `cleanupOrphanedFiles` lo recupera después.
    logger.warn({ fileId, error: String(error) }, "evidence-discard-failed")
  }
}

/** Recuperación de fallos parciales: PENDING con más de `olderThanMs`. */
export async function cleanupOrphanedFiles(olderThanMs = 15 * 60 * 1000) {
  const stale = await prisma.storedFile.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: new Date(Date.now() - olderThanMs) },
    },
    select: { id: true },
  })
  for (const f of stale) await discardStagedFile(f.id, "stale-pending")
  return stale.length
}

/** Lee una evidencia ACTIVE y verifica su integridad (hash). */
export async function readEvidence(fileId: string) {
  const file = await prisma.storedFile.findUnique({
    where: { id: fileId },
    select: { status: true, storageKey: true, sha256: true, mimeType: true },
  })
  if (!file || file.status !== "ACTIVE") return null
  const bytes = await driver.get(file.storageKey)
  if (!bytes) return null
  if (sha256Hex(bytes) !== file.sha256)
    throw new Error("La evidencia no coincide con su huella registrada")
  return { bytes, mimeType: file.mimeType, sha256: file.sha256 }
}
