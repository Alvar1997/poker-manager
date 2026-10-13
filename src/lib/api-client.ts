import type { ApiResponse } from "@/lib/api-response"
import type { ErrorCode } from "@/lib/errors"

/**
 * Cliente mínimo para llamar a la API propia desde componentes cliente.
 * Usa la cookie de sesión httpOnly (same-origin): ningún token se guarda
 * en localStorage ni se maneja desde JavaScript.
 */

export type FieldIssue = { path: string; message: string }

export class ApiClientError extends Error {
  readonly code: ErrorCode | "NETWORK_ERROR"
  readonly status: number
  readonly fieldIssues: FieldIssue[]

  constructor(
    code: ApiClientError["code"],
    message: string,
    status: number,
    fieldIssues: FieldIssue[] = []
  ) {
    super(message)
    this.name = "ApiClientError"
    this.code = code
    this.status = status
    this.fieldIssues = fieldIssues
  }
}

export async function apiRequest<T>(
  url: string,
  options: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers:
        options.body !== undefined
          ? { "Content-Type": "application/json" }
          : undefined,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    })
  } catch {
    throw new ApiClientError(
      "NETWORK_ERROR",
      "No se pudo conectar con el servidor. Revisa tu conexión.",
      0
    )
  }

  const payload = (await response
    .json()
    .catch(() => null)) as ApiResponse<T> | null

  if (!payload) {
    throw new ApiClientError(
      "INTERNAL_ERROR",
      "Respuesta inesperada del servidor",
      response.status
    )
  }

  if (!payload.success) {
    const details = Array.isArray(payload.error.details)
      ? (payload.error.details as FieldIssue[])
      : []
    throw new ApiClientError(
      payload.error.code,
      payload.error.message,
      response.status,
      details
    )
  }

  return payload.data
}
