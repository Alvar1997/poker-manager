import type { z } from "zod"

import { ValidationError } from "@/lib/errors"

/** Convierte los issues de Zod al formato de `details` que usa ValidationError. */
function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
}

/** Valida el body JSON de una Request contra un schema Zod. Lanza ValidationError si falla o si el JSON es inválido. */
export async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema
): Promise<z.output<TSchema>> {
  let raw: unknown

  try {
    raw = await request.json()
  } catch {
    throw new ValidationError("El cuerpo de la solicitud no es JSON válido")
  }

  const result = schema.safeParse(raw)

  if (!result.success) {
    throw new ValidationError("Datos inválidos", formatIssues(result.error))
  }

  return result.data
}

/** Valida los query params (URLSearchParams) contra un schema Zod. */
export function parseQueryParams<TSchema extends z.ZodType>(
  searchParams: URLSearchParams,
  schema: TSchema
): z.output<TSchema> {
  const raw = Object.fromEntries(searchParams.entries())
  const result = schema.safeParse(raw)

  if (!result.success) {
    throw new ValidationError(
      "Parámetros de consulta inválidos",
      formatIssues(result.error)
    )
  }

  return result.data
}

/** Entero no negativo — usado para cantidades de fichas en módulos futuros. */
export function nonNegativeInt(fieldName: string) {
  return (value: unknown) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new ValidationError(`${fieldName} debe ser un entero no negativo`)
    }
    return value
  }
}
