import { randomUUID } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { fail } from "@/lib/api-response"
import { ForbiddenError, MaintenanceError, toAppError } from "@/lib/errors"
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
 * - En métodos que modifican estado (POST/PUT/PATCH/DELETE) rechaza con
 *   403 las solicitudes de otro origen (defensa CSRF; ver
 *   assertSameOrigin).
 *
 * El handler NO debe contener lógica de negocio: autentica/autoriza,
 * valida con Zod y delega en un servicio de `src/modules/*`.
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
      assertSameOrigin(req)
      await assertNotInMaintenance(req)
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Defensa CSRF para la API propia (la sesión viaja en cookie):
 * 1. La cookie de Auth.js es SameSite=Lax → el navegador no la envía en
 *    POST/PATCH iniciados desde otro sitio.
 * 2. Además, aquí se rechaza cualquier solicitud mutante cuyo
 *    `Sec-Fetch-Site` indique otro sitio o cuyo `Origin` no coincida con
 *    el host. Los navegadores modernos siempre envían ambos en fetch.
 * Clientes sin navegador (sin Origin) no portan la cookie de otro
 * usuario, así que no representan un vector CSRF.
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return

  const fetchSite = req.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ForbiddenError("Origen de la solicitud no permitido")
  }

  const origin = req.headers.get("origin")
  if (!origin) return

  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    req.headers.get("host")
  let originHost: string | null = null
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = null
  }
  if (!host || originHost !== host) {
    throw new ForbiddenError("Origen de la solicitud no permitido")
  }
}

/** Rutas que siguen operando en mantenimiento (identidad y la propia recuperación). */
const MAINTENANCE_EXEMPT = [
  "/api/auth/",
  "/api/admin/recovery",
  "/api/admin/maintenance",
]

/**
 * Modo mantenimiento (Módulo 15): durante una recuperación se rechazan las
 * escrituras de negocio con 503. Las lecturas siguen disponibles.
 */
async function assertNotInMaintenance(req: NextRequest): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return
  const path = req.nextUrl.pathname
  if (MAINTENANCE_EXEMPT.some((p) => path.startsWith(p))) return
  const { isMaintenanceEnabled } =
    await import("@/modules/backups/recovery.service")
  if (await isMaintenanceEnabled()) throw new MaintenanceError()
}
