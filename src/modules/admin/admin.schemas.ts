import { z } from "zod"

/** Schemas del Módulo 15 (incidencias, recuperación, mantenimiento). */

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")
const key = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de operación inválida")
const severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
const status = z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"])
const blank = (v: unknown) => (v === "" ? undefined : v)

export const createIncidentSchema = z.strictObject({
  title: z.string().trim().min(5, "Título demasiado corto").max(200),
  description: z
    .string()
    .trim()
    .min(10, "Describe la incidencia (mínimo 10)")
    .max(2000),
  severity,
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(64).optional(),
})

export const updateIncidentSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  status: status.optional(),
  assignedToId: id.nullable().optional(),
  comment: z.string().trim().min(3).max(1000).optional(),
  evidence: z.string().trim().min(3).max(1000).optional(),
  resolution: z.string().trim().min(5).max(2000).optional(),
})

export const incidentsQuerySchema = z.object({
  status: z.preprocess(blank, status.optional()),
  severity: z.preprocess(blank, severity.optional()),
  source: z.preprocess(
    blank,
    z.enum(["MANUAL", "INTEGRITY", "BACKUP", "RESTORE", "SECURITY"]).optional()
  ),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
})

const password = z.string().min(1, "Confirma tu contraseña").max(200)

export const requestRecoverySchema = z.strictObject({
  backupId: id,
  reason: z
    .string()
    .trim()
    .min(20, "Explica el motivo (mínimo 20 caracteres)")
    .max(2000),
  password,
  idempotencyKey: key,
})

export const approveRecoverySchema = z.strictObject({
  password,
  confirmation: z.string(),
  expectedVersion: z.number().int().min(1),
})

export const cancelRecoverySchema = z.strictObject({
  notes: z.string().trim().min(5).max(1000),
})

export const linkValidationSchema = z.strictObject({ validationId: id })

export const maintenanceSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().trim().min(10, "Explica el motivo (mínimo 10)").max(500),
  password,
})

export async function parseIdParam<K extends string>(
  params: Promise<Record<K, string>>,
  name: K
) {
  const p = await params
  const r = id.safeParse(p[name])
  if (!r.success) {
    const { ValidationError } = await import("@/lib/errors")
    throw new ValidationError("Identificador inválido")
  }
  return r.data
}
