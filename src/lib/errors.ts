/**
 * Categorías de error de negocio/infraestructura usadas en toda la API.
 * Cada Route Handler debe lanzar (o devolver) una AppError en vez de un
 * Error genérico, para que api-handler.ts pueda mapearla a un código HTTP
 * y a un formato de respuesta consistente.
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUSINESS_RULE_ERROR"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_RULE_ERROR: 422,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** Detalles adicionales seguros para el cliente (nunca stack traces ni secretos). */
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "AppError"
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(message = "Datos inválidos", details?: unknown) {
    super("VALIDATION_ERROR", message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "No autenticado") {
    super("UNAUTHORIZED", message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "No autorizado para esta acción") {
    super("FORBIDDEN", message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Recurso no encontrado") {
    super("NOT_FOUND", message)
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicto con el estado actual del recurso") {
    super("CONFLICT", message)
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super("BUSINESS_RULE_ERROR", message, details)
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Demasiados intentos. Espera unos minutos.") {
    super("RATE_LIMITED", message)
  }
}

/** Convierte cualquier error desconocido en un AppError INTERNAL_ERROR, sin filtrar detalles internos. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error

  return new AppError(
    "INTERNAL_ERROR",
    "Ocurrió un error inesperado. Intenta de nuevo más tarde."
  )
}

/** Modo mantenimiento (Módulo 15): la API rechaza escrituras de negocio. */
export class MaintenanceError extends AppError {
  constructor(
    message = "El sistema está en mantenimiento (recuperación en curso). Las operaciones están suspendidas temporalmente."
  ) {
    super("SERVICE_UNAVAILABLE", message)
    this.name = "MaintenanceError"
  }
}
