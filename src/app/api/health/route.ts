import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"

export const dynamic = "force-dynamic"

/**
 * Liveness check: confirma que el proceso de la aplicación está corriendo.
 * No verifica dependencias externas (para eso existe /api/health/ready).
 * No debe cachearse.
 */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const response = ok(
    { status: "ok", uptimeSeconds: Math.round(process.uptime()) },
    { message: "poker-manager está en línea", requestId }
  )
  response.headers.set("Cache-Control", "no-store")
  return response
})

export function HEAD() {
  return new NextResponse(null, { status: 200 })
}
