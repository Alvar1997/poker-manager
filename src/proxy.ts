import NextAuth from "next-auth"
import { NextResponse } from "next/server"

import { authConfig } from "@/lib/auth.config"

/**
 * Next.js 16 renombró la convención "middleware" a "proxy" (el archivo
 * debe llamarse proxy.ts y exportar una función `proxy`). En Next 16 el
 * proxy corre en Node.js, pero se mantiene deliberadamente ligero: usa
 * `authConfig` (sin el provider de Credentials, sin Prisma) y solo
 * decodifica el JWT.
 *
 * Protege /dashboard/*: sin cookie de sesión, redirige a /login. Es una
 * capa de conveniencia (UX). La validación real — usuario activo,
 * sessionVersion vigente y permisos por capacidad — ocurre en el servidor
 * en cada página (layout + requirePagePermission) y en cada endpoint
 * (requireUser/requirePermission), que además responden 401/403 en la API.
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
