import { z } from "zod"

import { AUDIT_MODULES } from "@/modules/audit/audit-taxonomy"

/**
 * Filtros de la consulta de auditoría (Módulo 15). Validados en el
 * servidor; viajan como URL search params para persistir al navegar.
 */

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const ID = /^[A-Za-z0-9_:.-]{1,100}$/
const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v
const opt = <T extends z.ZodType>(s: T) => z.preprocess(blank, s)

export const auditFiltersSchema = z
  .object({
    from: opt(z.string().regex(DAY, "Fecha inválida").optional()),
    to: opt(z.string().regex(DAY, "Fecha inválida").optional()),
    actorUserId: opt(z.string().regex(ID).optional()),
    actorRole: opt(z.enum(["SUPERADMIN", "PARTNER", "CASHIER"]).optional()),
    module: opt(z.enum(AUDIT_MODULES).optional()),
    action: opt(
      z
        .string()
        .regex(/^[A-Z_]{3,60}$/, "Evento inválido")
        .optional()
    ),
    sessionId: opt(z.string().regex(ID).optional()),
    playerId: opt(z.string().regex(ID).optional()),
    result: opt(z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional()),
    /** Identificador de operación: id de entidad, requestId o idempotencia. */
    operationId: opt(z.string().regex(ID, "Identificador inválido").optional()),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(10).max(100).default(50),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, {
    path: ["to"],
    message: "La fecha final es anterior a la inicial",
  })

export type AuditFilters = z.output<typeof auditFiltersSchema>

export function parseAuditFilters(
  raw: Record<string, string | string[] | undefined>
) {
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  )
  const r = auditFiltersSchema.safeParse(flat)
  return r.success
    ? { ok: true as const, filters: r.data }
    : {
        ok: false as const,
        issues: r.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      }
}

export function auditFiltersToQuery(
  f: Partial<AuditFilters>,
  over: Record<string, string | number | undefined> = {}
) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...f, ...over })) {
    if (v === undefined || v === null || v === "") continue
    if (k === "page" && Number(v) === 1) continue
    if (k === "pageSize" && Number(v) === 50) continue
    p.set(k, String(v))
  }
  const q = p.toString()
  return q ? `?${q}` : ""
}
