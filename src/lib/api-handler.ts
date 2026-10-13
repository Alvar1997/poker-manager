import { randomUUID } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { fail } from "@/lib/api-response"
import { toAppError } from "@/lib/errors"
import { createRequestLogger } from "@/lib/logger"

export type RouteContext<TParams = Record<string, string>> = {
  params: Promise<TParams>
}

type Handler<TParams> = (
  req: NextRequest,
  ctx: RouteContext<TParams> & { requestId: string }
) => Promise<NextResponse>

/**
 * Envuelve un Route Handler aplicando el patrón consistente del proyecto:
 *
 *   Route Handler → Validación → Autorización → Servicio → Prisma
 *
 * - Genera un requestId para correlacionar logs y respuestas.
 * - Captura cualquier error (AppError o desconocido) y lo traduce al
 *   formato de respuesta estándar, sin filtrar detalles internos.
 * - Loguea la request con su resultado y duración.
 *
 * El handler NO debe contener lógica de negocio: valida con Zod, verifica
 * autorización, y delega en un servicio de `src/modules/*`.
 */
export function withApiHandler<TParams = Record<string, string>>(
  handler: Handler<TParams>
) {
  return async (
    req: NextRequest,
    ctx: RouteContext<TParams>
  ): Promise<NextResponse> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID()
    const log = createRequestLogger(requestId)
    const startedAt = performance.now()

    try {
      const response = await handler(req, { ...ctx, requestId })
      log.info({
        event: "api_request",
        method: req.method,
        path: req.nextUrl.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      })
      response.headers.set("x-request-id", requestId)
      return response
    } catch (error) {
      const appError = toAppError(error)

      log.error({
        event: "api_request_error",
        method: req.method,
        path: req.nextUrl.pathname,
        code: appError.code,
        status: appError.status,
        durationMs: Math.round(performance.now() - startedAt),
        // El stack solo va al log del servidor, nunca a la respuesta HTTP.
        err: appError,
      })

      const response = fail(appError, requestId)
      response.headers.set("x-request-id", requestId)
      return response
    }
  }
}
