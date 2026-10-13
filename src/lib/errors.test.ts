import { describe, expect, it } from "vitest"

import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  toAppError,
} from "@/lib/errors"

describe("AppError y subclases", () => {
  it.each([
    [new ValidationError(), "VALIDATION_ERROR", 400],
    [new UnauthorizedError(), "UNAUTHORIZED", 401],
    [new ForbiddenError(), "FORBIDDEN", 403],
    [new NotFoundError(), "NOT_FOUND", 404],
    [new ConflictError(), "CONFLICT", 409],
    [
      new BusinessRuleError("regla de negocio violada"),
      "BUSINESS_RULE_ERROR",
      422,
    ],
    [new RateLimitError(), "RATE_LIMITED", 429],
  ] as const)(
    "%# mapea al código y status HTTP correctos",
    (error, code, status) => {
      expect(error).toBeInstanceOf(AppError)
      expect(error.code).toBe(code)
      expect(error.status).toBe(status)
    }
  )

  it("conserva los detalles adicionales", () => {
    const details = [{ path: "email", message: "inválido" }]
    const error = new ValidationError("Datos inválidos", details)
    expect(error.details).toEqual(details)
  })
})

describe("toAppError", () => {
  it("devuelve el mismo AppError si ya lo es", () => {
    const original = new NotFoundError("no encontrado")
    expect(toAppError(original)).toBe(original)
  })

  it("envuelve cualquier error desconocido como INTERNAL_ERROR sin filtrar detalles", () => {
    const wrapped = toAppError(new Error("boom: credenciales secretas xyz"))
    expect(wrapped.code).toBe("INTERNAL_ERROR")
    expect(wrapped.status).toBe(500)
    expect(wrapped.message).not.toContain("secretas")
  })

  it("envuelve valores que no son Error (string, undefined, etc.)", () => {
    expect(toAppError("algo raro").code).toBe("INTERNAL_ERROR")
    expect(toAppError(undefined).code).toBe("INTERNAL_ERROR")
  })
})
