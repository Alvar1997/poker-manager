import { z } from "zod"

import {
  CORRECTION_STATUSES,
  CORRECTION_TYPES,
} from "@/modules/corrections/correction.rules"

/** Schemas del Módulo 15 (correcciones). `strictObject`: campos extra → 400. */

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")
const idempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de operación inválida")
const text = (min: number, max: number, message: string) =>
  z.string({ message }).trim().min(min, message).max(max)

export const createCorrectionSchema = z.strictObject({
  type: z.enum(CORRECTION_TYPES),
  targetType: z.enum([
    "ReceivablePayment",
    "CashTransaction",
    "PlayerSettlement",
    "ChipPurchase",
    "UnappliedPlayerFunds",
    "Player",
  ]),
  targetId: id,
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido")
    .optional(),
  reason: text(10, 1000, "Explica el motivo (mínimo 10 caracteres)"),
  evidenceNote: z.string().trim().max(500).optional(),
  idempotencyKey,
})
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>

export const commentSchema = z.strictObject({
  notes: text(3, 1000, "Escribe la observación"),
})

export const decisionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  notes: text(5, 1000, "Explica la decisión (mínimo 5 caracteres)"),
})

export const linkExecutionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  referenceId: id,
  notes: z.string().trim().max(1000).optional(),
})

export const failExecutionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  notes: text(5, 1000, "Explica por qué no se pudo ejecutar"),
})

export const cancelSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  notes: text(5, 1000, "Explica por qué se cancela"),
})

export const correctionsQuerySchema = z.object({
  status: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(CORRECTION_STATUSES).optional()
  ),
  type: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(CORRECTION_TYPES).optional()
  ),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
})
export type CorrectionsQuery = z.infer<typeof correctionsQuerySchema>
