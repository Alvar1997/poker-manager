import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { SESSION_STATUSES } from "@/modules/sessions/session.state"

/**
 * Schemas de sesiones. El cliente NUNCA envía folio, creador, estado ni
 * fechas reales: `z.strictObject` rechaza esos campos (400).
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const idempotencyKeySchema = z
  .string({ message: "Falta la clave de idempotencia" })
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de idempotencia inválida")

const notes = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)")

/** Hora local del negocio `HH:MM` (24 h). */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM)")

/** Fecha y hora locales del negocio (`AAAA-MM-DDTHH:MM`, sin zona). */
export const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/,
    "Fecha y hora inválidas"
  )

/**
 * Crear sesión. Normal: el servidor fija la fecha operativa (hoy, zona del
 * negocio). Histórica (`historical: true`, solo SUPERADMIN): la fecha
 * ORIGINAL anterior a hoy y la hora operativa de apertura (local). El
 * cliente nunca envía folio ni consecutivo.
 */
export const createSessionSchema = z
  .strictObject({
    idempotencyKey: idempotencyKeySchema,
    notes,
    historical: z.boolean().optional(),
    businessDate: businessDateSchema.optional(),
    /** Jornada histórica: hora operativa de apertura (HH:MM local). */
    openingTime: localTimeSchema.optional(),
  })
  .refine((v) => !v.openingTime || v.historical === true, {
    message: "La hora de apertura solo se elige en una jornada histórica",
    path: ["openingTime"],
  })
  .refine((v) => v.historical !== true || Boolean(v.openingTime), {
    message: "Indica la hora de apertura de la jornada",
    path: ["openingTime"],
  })
  .refine((v) => !v.businessDate || v.historical === true, {
    message:
      "La fecha operativa solo se elige al registrar una sesión histórica",
    path: ["businessDate"],
  })
  .refine((v) => v.historical !== true || Boolean(v.businessDate), {
    message: "Indica la fecha original de la sesión",
    path: ["businessDate"],
  })
export type CreateSessionInput = z.infer<typeof createSessionSchema>

export const openSessionSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  /** Huella del resumen revisado en el asistente (409 si cambió). */
  previewHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "Huella inválida")
    .optional(),
})

export const cancelSessionSchema = z.strictObject({
  reason: z
    .string({ message: "El motivo es obligatorio" })
    .trim()
    .min(5, "Explica el motivo de la cancelación (mínimo 5 caracteres)")
    .max(300),
})

/** Caja inicial: el usuario declara que contó físicamente el efectivo. */
export const openingCashSchema = z
  .strictObject({
    countedAmount: z
      .string({ message: "Captura el efectivo contado" })
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido (hasta 2 decimales)"),
    physicallyVerified: z.literal(true, {
      message: "Confirma que contaste físicamente el efectivo de la caja",
    }),
    explanation: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => Number(d.countedAmount) === 0 || (d.explanation ?? "").length >= 5,
    {
      path: ["explanation"],
      message:
        "Hay efectivo en la caja: explica su procedencia (se debe retirar antes de abrir)",
    }
  )
export type OpeningCashInput = z.infer<typeof openingCashSchema>

/** Vista previa provisional del folio (no reserva el consecutivo). */
export const folioPreviewQuerySchema = z.object({
  businessDate: businessDateSchema.optional(),
})

/** `from`/`to` filtran por FECHA OPERATIVA (businessDate), no por captura. */
export const sessionsQuerySchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  kind: z.enum(["historical", "regular"]).optional(),
  q: z.string().trim().max(30).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sort: z.enum(["desc", "asc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>

export async function parseSessionIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

/** Asistente de apertura: lo que el creador declara (nunca estados de pasos). */
export const openingWizardProgressSchema = z
  .strictObject({
    currentStep: z.number().int().min(1).max(4).optional(),
    notes,
    /** «Continuar sin mesas» (el paso de mesas es opcional). */
    noTables: z.boolean().optional(),
    /** Jornada histórica: corrige la hora operativa de apertura (HH:MM). */
    openingTime: localTimeSchema.optional(),
  })
  .refine(
    (v) =>
      v.currentStep !== undefined ||
      v.notes !== undefined ||
      v.noTables !== undefined ||
      v.openingTime !== undefined,
    { message: "No hay cambios que guardar" }
  )
export type OpeningWizardProgressInput = z.infer<
  typeof openingWizardProgressSchema
>

export const openingTableSchema = z.strictObject({ tableId: idSchema })
