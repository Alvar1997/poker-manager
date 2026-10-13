import NextAuth from "next-auth"
import { NextResponse } from "next/server"

import { authConfig } from "@/lib/auth.config"

/**
 * Next.js 16 renombró la convención "middleware" a "proxy" (el archivo
 * debe llamarse proxy.ts y exportar una función `proxy`). Corre en Edge
 * Runtime: por eso usa `authConfig` (sin el provider de Credentials,
 * que depende de Prisma/bcryptjs — incompatibles con Edge) en vez de
 * importar src/lib/auth.ts completo.
 *
 * Protege /dashboard: sin sesión, redirige a /login. Esta es una capa de
 * conveniencia (UX) — la autorización real por rol para cada acción vive
 * en el servidor (Route Handlers / Server Components vía
 * src/config/permissions.ts), no aquí.
 */
const { auth } = NextAuth(authConfig)

export const proxy = auth((req) => {
  const isDashboardRoute = req.nextUrl.pathname.startsWith("/dashboard")

  if (isDashboardRoute && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin)
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
})

export const config = {
  matcher: ["/dashboard/:path*"],
}
