import { z } from "zod"

import {
  DEFAULT_PHONE_COUNTRY,
  isSupportedCountry,
  normalizePhone,
} from "@/lib/phone"
import { ValidationError } from "@/lib/errors"
import { WHATSAPP_CONSENT_NOTICE_VERSION } from "@/modules/players/consent-notice"

/**
 * Schemas de jugadores (cliente y servidor; manda el servidor).
 *
 * - `strictObject`: campos no previstos (id, isActive en la edición,
 *   deudas, saldos, límites de crédito, fechas…) → 400.
 * - El teléfono SIEMPRE se normaliza a E.164 aquí; el resto del sistema
 *   solo ve el valor normalizado.
 * - Notas: texto plano. Se eliminan caracteres de control y se muestran
 *   escapadas (React); nunca se interpretan como HTML.
 */

export const PLAYER_NAME_MAX = 120
export const PLAYER_NICKNAME_MAX = 60
export const PLAYER_NOTES_MAX = 1000

// Caracteres de control salvo salto de línea y tabulador.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export const playerNameSchema = z
  .string({ message: "El nombre es obligatorio" })
  .transform((v) => v.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(2, "El nombre es obligatorio (mínimo 2 caracteres)")
      .max(PLAYER_NAME_MAX, `Máximo ${PLAYER_NAME_MAX} caracteres`)
  )

const optionalText = (max: number, singleLine: boolean) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => {
      const clean = v.replace(CONTROL_CHARS, "")
      return (singleLine ? clean.replace(/\s+/g, " ") : clean).trim()
    })
    .pipe(z.string().max(max, `Máximo ${max} caracteres`))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()

export const playerNicknameSchema = optionalText(PLAYER_NICKNAME_MAX, true)
export const playerNotesSchema = optionalText(PLAYER_NOTES_MAX, false)

export const phoneCountrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isSupportedCountry, "País no válido")
  .default(DEFAULT_PHONE_COUNTRY)

const PHONE_REQUIRED = "El teléfono es obligatorio"
const PHONE_INVALID =
  "Teléfono inválido para el país seleccionado. Si es de otro país, elige el país o escribe el número con +código."

/** Agrega `phone` (E.164) y `countryCode` a partir de phone + phoneCountry. */
function withNormalizedPhone<
  T extends { phone?: string; phoneCountry?: string },
>(data: T, ctx: z.RefinementCtx) {
  if (data.phone === undefined) return { ...data, countryCode: undefined }
  if (data.phone.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["phone"], message: PHONE_REQUIRED })
    return z.NEVER
  }
  const normalized = normalizePhone(
    data.phone,
    (data.phoneCountry as Parameters<typeof normalizePhone>[1]) ??
      DEFAULT_PHONE_COUNTRY
  )
  if (!normalized) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: PHONE_INVALID })
    return z.NEVER
  }
  return { ...data, phone: normalized.e164, countryCode: normalized.country }
}

export const CONSENT_SOURCES = ["IN_PERSON", "ADMIN_ENTRY"] as const
export const CONSENT_SOURCE_LABEL: Record<
  (typeof CONSENT_SOURCES)[number],
  string
> = {
  IN_PERSON: "En persona (en caja)",
  ADMIN_ENTRY: "Captura administrativa de una aceptación previa",
}

const evidenceSchema = optionalText(200, true)
const consentNotesSchema = optionalText(500, false)

/** WA-02/05/12: otorgar exige confirmar que el JUGADOR aceptó la versión vigente. */
export const grantConsentSchema = z.strictObject({
  action: z.literal("GRANTED"),
  noticeVersion: z.literal(WHATSAPP_CONSENT_NOTICE_VERSION, {
    message:
      "La versión del aviso cambió: vuelve a mostrar el aviso vigente al jugador",
  }),
  source: z.enum(CONSENT_SOURCES),
  confirmedByPlayer: z.literal(true, {
    message: "Confirma que el jugador aceptó expresamente el aviso",
  }),
  evidenceReference: evidenceSchema,
  notes: consentNotesSchema,
})

export const revokeConsentSchema = z.strictObject({
  action: z.literal("REVOKED"),
  source: z.enum(CONSENT_SOURCES),
  evidenceReference: evidenceSchema,
  notes: consentNotesSchema,
})

export const consentActionSchema = z.discriminatedUnion("action", [
  grantConsentSchema,
  revokeConsentSchema,
])

export type ConsentActionInput = z.infer<typeof consentActionSchema>

/** Consentimiento opcional al crear: ausente = sin consentimiento (WA-03/04). */
const initialConsentSchema = grantConsentSchema.omit({ action: true })

export const createPlayerSchema = z
  .strictObject({
    name: playerNameSchema,
    nickname: playerNicknameSchema,
    phone: z.string({ message: PHONE_REQUIRED }).max(40),
    phoneCountry: phoneCountrySchema,
    notes: playerNotesSchema,
    whatsappConsent: initialConsentSchema.optional(),
  })
  .transform(withNormalizedPhone)

export type CreatePlayerInput = z.output<typeof createPlayerSchema> & {
  phone: string
  countryCode: string
}

export const updatePlayerSchema = z
  .strictObject({
    name: playerNameSchema.optional(),
    nickname: playerNicknameSchema,
    phone: z.string().max(40).optional(),
    phoneCountry: phoneCountrySchema.optional(),
    phoneChangeReason: optionalText(200, true),
    notes: playerNotesSchema,
  })
  .refine(
    (d) =>
      Object.entries(d).some(
        ([k, v]) => k !== "phoneCountry" && v !== undefined
      ),
    "Indica al menos un campo a modificar"
  )
  .transform(withNormalizedPhone)

export type UpdatePlayerInput = z.output<typeof updatePlayerSchema>

export const playerStatusSchema = z.strictObject({
  isActive: z.boolean({ message: "isActive debe ser true o false" }),
  reason: optionalText(200, true),
})

export const PLAYER_SORTS = ["name", "createdAt", "updatedAt"] as const
export const PLAYER_STATUS_FILTERS = ["all", "active", "inactive"] as const

export const listPlayersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PLAYER_STATUS_FILTERS).default("all"),
  sort: z.enum(PLAYER_SORTS).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export type ListPlayersQuery = z.infer<typeof listPlayersQuerySchema>

export const playerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export async function parsePlayerIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = playerIdSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
