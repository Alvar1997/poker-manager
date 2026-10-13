import { NextResponse } from "next/server"

import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/logger"

export const dynamic = "force-dynamic"

/**
 * Readiness check: además de que el proceso esté vivo, verifica que se
 * pueda consultar PostgreSQL (Neon) con una query trivial.
 *
 * Si Neon no está configurado o no responde, debe devolver 503 con
 * status "unhealthy" — nunca fingir éxito. No expone la cadena de
 * conexión ni ningún detalle interno del error.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`

    return NextResponse.json(
      { status: "healthy", checks: { database: "up" } },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    logger.error({ event: "readiness_check_failed", error })

    return NextResponse.json(
      { status: "unhealthy", checks: { database: "down" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
