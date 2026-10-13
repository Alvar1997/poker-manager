import { z } from "zod"

import { isValidClabe } from "@/lib/clabe"
import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"

/**
 * Schemas de entrada del Módulo 02 (configuración). Compartidos entre
 * formularios y Route Handlers; manda la validación del servidor.
 *
 * - `strictObject`: campos internos (id, code en ediciones, timestamps,
 *   currency, timezone, saldos…) se rechazan con 400.
 * - Montos como STRING decimal (nunca number) — ver src/lib/money.ts.
 * - Los códigos internos son inmutables: solo se fijan al crear.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo ${max} caracteres`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()

export const catalogCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9_]{1,39}$/,
    "Usa 2–40 caracteres: letras, números y guion bajo (p. ej. TABLE_50_50)"
  )

const nameSchema = z
  .string()
  .trim()
  .min(2, "Mínimo 2 caracteres")
  .max(80, "Máximo 80 caracteres")

const sortOrderSchema = z.number().int().min(0).max(9999)

export const entityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+$/i, "Identificador inválido")

/** Valida el segmento `[id]` de una ruta dinámica. */
export async function parseIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = entityIdSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

export const statusSchema = z.strictObject({
  isActive: z.boolean({ message: "isActive debe ser true o false" }),
})

const atLeastOne = <T extends Record<string, unknown>>(data: T) =>
  Object.values(data).some((value) => value !== undefined)

// ── Configuración general ─────────────────────────────────────────────

export const DATE_FORMATS = ["DD_MM_YYYY", "YYYY_MM_DD"] as const
export const TIME_FORMATS = ["H12", "H24"] as const

export const DATE_FORMAT_LABEL: Record<(typeof DATE_FORMATS)[number], string> =
  {
    DD_MM_YYYY: "dd/MM/yyyy",
    YYYY_MM_DD: "yyyy-MM-dd",
  }
export const TIME_FORMAT_LABEL: Record<(typeof TIME_FORMATS)[number], string> =
  {
    H12: "12 horas",
    H24: "24 horas",
  }

export const updateBusinessSettingsSchema = z
  .strictObject({
    businessName: nameSchema.optional(),
    displayName: optionalText(80),
    logoUrl: z
      .string()
      .trim()
      .max(500)
      .refine(
        (value) =>
          value === "" || /^https:\/\//.test(value) || value.startsWith("/"),
        "Usa una URL https:// o una ruta del sitio (/logo.png)"
      )
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    dateFormat: z.enum(DATE_FORMATS).optional(),
    timeFormat: z.enum(TIME_FORMATS).optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateBusinessSettingsInput = z.infer<
  typeof updateBusinessSettingsSchema
>

// ── Caja central ──────────────────────────────────────────────────────

export const updateCashBoxSchema = z.strictObject({
  name: nameSchema,
})

export type UpdateCashBoxInput = z.infer<typeof updateCashBoxSchema>

// ── Mesas ─────────────────────────────────────────────────────────────

export const createTableSchema = z.strictObject({
  code: catalogCodeSchema,
  name: nameSchema,
  smallBlind: positiveMoneySchema,
  bigBlind: positiveMoneySchema,
  defaultChipSetId: entityIdSchema,
  sortOrder: sortOrderSchema.optional(),
})

export type CreateTableInput = z.infer<typeof createTableSchema>

export const updateTableSchema = z
  .strictObject({
    name: nameSchema.optional(),
    smallBlind: positiveMoneySchema.optional(),
    bigBlind: positiveMoneySchema.optional(),
    defaultChipSetId: entityIdSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateTableInput = z.infer<typeof updateTableSchema>

// ── Juegos de fichas ──────────────────────────────────────────────────

export const createChipSetSchema = z.strictObject({
  code: catalogCodeSchema,
  name: nameSchema,
  description: optionalText(300),
})

export type CreateChipSetInput = z.infer<typeof createChipSetSchema>

export const updateChipSetSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: optionalText(300),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateChipSetInput = z.infer<typeof updateChipSetSchema>

// ── Denominaciones ────────────────────────────────────────────────────

export const createDenominationSchema = z.strictObject({
  value: positiveMoneySchema,
  name: optionalText(40),
  color: optionalText(40),
  sortOrder: sortOrderSchema.optional(),
})

export type CreateDenominationInput = z.infer<typeof createDenominationSchema>

export const updateDenominationSchema = z
  .strictObject({
    value: positiveMoneySchema.optional(),
    name: optionalText(40),
    color: optionalText(40),
    sortOrder: sortOrderSchema.optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateDenominationInput = z.infer<typeof updateDenominationSchema>

// ── Métodos de pago ───────────────────────────────────────────────────

export const updatePaymentMethodSchema = z
  .strictObject({
    name: nameSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>

// ── Cuenta bancaria ───────────────────────────────────────────────────

const digits = (value: string) => value.replace(/[\s-]/g, "")

export const updateBankAccountSchema = z
  .strictObject({
    name: nameSchema.optional(),
    bankName: optionalText(80),
    accountHolder: optionalText(120),
    accountNumber: z
      .string()
      .transform(digits)
      .refine(
        (v) => /^\d{6,20}$/.test(v),
        "El número de cuenta debe tener 6–20 dígitos"
      )
      .optional(),
    clabe: z
      .string()
      .transform(digits)
      .refine(
        isValidClabe,
        "CLABE inválida (18 dígitos con dígito de control correcto)"
      )
      .optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>

// ── Folios ────────────────────────────────────────────────────────────

export const updateFolioSequenceSchema = z
  .strictObject({
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{1,6}$/, "Prefijo de 1 a 6 letras")
      .optional(),
    padding: z.number().int().min(1).max(12).optional(),
    nextNumber: z.number().int().min(1).max(999_999_999).optional(),
  })
  .refine(atLeastOne, "Indica al menos un campo a modificar")

export type UpdateFolioSequenceInput = z.infer<typeof updateFolioSequenceSchema>

/** Formato visible de un folio: PREFIJO-000001. */
export function formatFolio(prefix: string, number: number, padding: number) {
  return `${prefix}-${String(number).padStart(padding, "0")}`
}
