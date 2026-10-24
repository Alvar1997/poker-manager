import { z } from "zod"

import { ValidationError } from "@/lib/errors"

/**
 * Schemas del inventario de fichas (Módulo 04). Compartidos por
 * formularios y Route Handlers (manda el servidor).
 *
 * - Cantidades: SIEMPRE enteros (sin fracciones), nunca negativas.
 * - Toda operación que mueve inventario exige `idempotencyKey`: el
 *   cliente la genera una vez por intento lógico; reintentar con la misma
 *   clave no vuelve a mover fichas.
 * - Entradas, bajas y ajustes exigen motivo.
 * - `strictObject`: campos no previstos (saldos, versiones, ids
 *   internos…) → 400.
 */

export const MAX_CHIP_QUANTITY = 1_000_000

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const idempotencyKeySchema = z
  .string({ message: "Falta la clave de idempotencia" })
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de idempotencia inválida")

const intQuantity = (min: 0 | 1) =>
  z
    .number({ message: "La cantidad debe ser un número entero" })
    .int("Las fichas son unidades enteras: no se aceptan fracciones")
    .min(
      min,
      min === 0
        ? "La cantidad no puede ser negativa"
        : "La cantidad debe ser mayor que cero"
    )
    .max(MAX_CHIP_QUANTITY, "Cantidad demasiado grande")

export const nonNegativeQuantitySchema = intQuantity(0)
export const positiveQuantitySchema = intQuantity(1)

const reasonSchema = z
  .string({ message: "El motivo es obligatorio" })
  .trim()
  .min(3, "El motivo es obligatorio (mínimo 3 caracteres)")
  .max(300, "Máximo 300 caracteres")

const notesSchema = z
  .string()
  .trim()
  .max(500, "Máximo 500 caracteres")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

const uniqueDenominations = (lines: { denominationId: string }[]) =>
  new Set(lines.map((l) => l.denominationId)).size === lines.length

const linesSchema = <Q extends z.ZodNumber>(quantity: Q) =>
  z
    .array(z.strictObject({ denominationId: idSchema, quantity }))
    .min(1, "Captura al menos una denominación")
    .max(50)
    .refine(uniqueDenominations, "Cada denominación debe aparecer una sola vez")

export const initialStockSchema = z.strictObject({
  chipSetId: idSchema,
  lines: linesSchema(nonNegativeQuantitySchema),
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type InitialStockInput = z.infer<typeof initialStockSchema>

export const stockEntrySchema = z.strictObject({
  chipSetId: idSchema,
  lines: linesSchema(positiveQuantitySchema),
  reason: reasonSchema,
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type StockEntryInput = z.infer<typeof stockEntrySchema>

export const WITHDRAWAL_CATEGORIES = [
  "DAMAGE",
  "CONFIRMED_LOSS",
  "PERMANENT_RETIREMENT",
  "OTHER",
] as const
export const WITHDRAWAL_CATEGORY_LABEL: Record<
  (typeof WITHDRAWAL_CATEGORIES)[number],
  string
> = {
  DAMAGE: "Daño",
  CONFIRMED_LOSS: "Pérdida confirmada",
  PERMANENT_RETIREMENT: "Retiro definitivo",
  OTHER: "Otra causa",
}

export const stockWithdrawalSchema = z.strictObject({
  chipSetId: idSchema,
  category: z.enum(WITHDRAWAL_CATEGORIES, {
    message: "Selecciona la causa de la baja",
  }),
  lines: linesSchema(positiveQuantitySchema),
  reason: reasonSchema,
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type StockWithdrawalInput = z.infer<typeof stockWithdrawalSchema>

export const ADJUSTMENT_KINDS = ["SHORTAGE", "SURPLUS", "CORRECTION"] as const
export const ADJUSTMENT_KIND_LABEL: Record<
  (typeof ADJUSTMENT_KINDS)[number],
  string
> = {
  SHORTAGE: "Faltante",
  SURPLUS: "Sobrante",
  CORRECTION: "Corrección",
}

export const adjustmentSchema = z
  .strictObject({
    chipSetId: idSchema,
    denominationId: idSchema,
    kind: z.enum(ADJUSTMENT_KINDS, { message: "Selecciona el tipo de ajuste" }),
    /** Solo para CORRECTION: si aumenta o disminuye la custodia. */
    direction: z.enum(["INCREASE", "DECREASE"]).optional(),
    quantity: positiveQuantitySchema,
    reason: reasonSchema,
    notes: notesSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((d) => d.kind !== "CORRECTION" || d.direction !== undefined, {
    path: ["direction"],
    message: "Indica si la corrección aumenta o disminuye la existencia",
  })
  .refine((d) => d.kind === "CORRECTION" || d.direction === undefined, {
    path: ["direction"],
    message: "Solo las correcciones indican dirección",
  })
export type AdjustmentInput = z.infer<typeof adjustmentSchema>

/** OPENING/CLOSING los crea el módulo de sesiones con el mismo motor. */
export const createCountSchema = z.strictObject({
  chipSetId: idSchema,
  countType: z.enum(["CONTROL", "INITIAL"]).default("CONTROL"),
  notes: notesSchema,
})
export type CreateCountInput = z.infer<typeof createCountSchema>

export const updateCountSchema = z
  .strictObject({
    lines: z
      .array(
        z.strictObject({
          denominationId: idSchema,
          countedQuantity: nonNegativeQuantitySchema.nullable(),
        })
      )
      .max(50)
      .refine(
        uniqueDenominations,
        "Cada denominación debe aparecer una sola vez"
      )
      .optional(),
    notes: notesSchema,
    /** Recalcula el esperado con las existencias actuales (ARQ-17). */
    refreshExpected: z.boolean().optional(),
  })
  .refine(
    (d) => d.lines !== undefined || d.notes !== undefined || d.refreshExpected,
    "Indica qué actualizar"
  )
export type UpdateCountInput = z.infer<typeof updateCountSchema>

export const confirmCountSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
})

export const reconcileCountSchema = z.strictObject({
  reason: reasonSchema,
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type ReconcileCountInput = z.infer<typeof reconcileCountSchema>

export const MOVEMENT_TYPES = [
  "INITIAL_STOCK",
  "STOCK_ENTRY",
  "STOCK_WITHDRAWAL",
  "INVENTORY_ADJUSTMENT",
  "CHIP_DELIVERY",
  "CHIP_RETURN",
  "INTERNAL_TRANSFER",
  "REVERSAL",
] as const
// CHIP_CONVERSION existe en la base por historial pero ya no aplica: el
// inventario es compartido y un jugador que cambia de mesa conserva sus fichas.
export const MOVEMENT_TYPE_LABEL: Record<
  (typeof MOVEMENT_TYPES)[number],
  string
> = {
  INITIAL_STOCK: "Inventario inicial",
  STOCK_ENTRY: "Entrada",
  STOCK_WITHDRAWAL: "Baja",
  INVENTORY_ADJUSTMENT: "Ajuste",
  CHIP_DELIVERY: "Entrega a jugador",
  CHIP_RETURN: "Devolución de jugador",
  INTERNAL_TRANSFER: "Transferencia interna",
  REVERSAL: "Reverso",
}

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD")
  .optional()

export const movementsQuerySchema = z.object({
  chipSetId: idSchema.optional(),
  /** Solo filtra el historial: las existencias son comunes a todas las mesas. */
  tableId: idSchema.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  denominationId: idSchema.optional(),
  userId: idSchema.optional(),
  from: dateParam,
  to: dateParam,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})
export type MovementsQuery = z.infer<typeof movementsQuerySchema>

export const countsQuerySchema = z.object({
  chipSetId: idSchema.optional(),
  status: z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]).optional(),
  reconciliationStatus: z
    .enum([
      "NOT_REQUIRED",
      "PENDING",
      "RECONCILED",
      "SUPERSEDED",
      "ACCEPTED_WITH_DIFFERENCE",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export type CountsQuery = z.infer<typeof countsQuerySchema>

export async function parseInventoryIdParam(
  params: Promise<Record<string, string>>,
  key: string
): Promise<string> {
  const value = (await params)[key]
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
