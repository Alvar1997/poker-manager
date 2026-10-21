import { z } from "zod"

import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import { strokesSchema } from "@/modules/signatures/signature.strokes"

/**
 * Schemas del Módulo 09. La firma llega como TRAZOS (no como imagen). El
 * cliente nunca envía importes, estados, fechas ni "firmado = true".
 */
export const captureSignatureSchema = z.strictObject({
  snapshotId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Huella del resumen que el jugador revisó (el servidor la compara). */
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/, "Resumen inválido"),
  strokes: strokesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type CaptureSignatureInput = z.infer<typeof captureSignatureSchema>

export const receiptShareSchema = z.strictObject({
  channel: z.enum(["NATIVE_SHARE", "DOWNLOAD", "COPY_TEXT"]),
})
