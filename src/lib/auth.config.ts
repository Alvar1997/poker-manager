import type { NextAuthConfig } from "next-auth"

/** Duración máxima de una sesión (JWT): 8 horas, una jornada de operación. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

/**
 * Parte de la configuración de Auth.js sin dependencias de Prisma/bcrypt.
 *
 * `src/proxy.ts` solo necesita decodificar el JWT de sesión para decidir
 * si redirige a /login — no necesita el provider de Credentials (que
 * importa Prisma + bcryptjs). Por eso este archivo NO incluye
 * `providers`; la configuración completa vive en src/lib/auth.ts, usado
 * en Route Handlers / Server Components.
 *
 * El JWT lleva solo id, role, isActive y sessionVersion. Es una pista
 * para la UI y para el proxy: la autorización real SIEMPRE vuelve a
 * leer el usuario en la base (src/config/permissions.ts → getCurrentUser)
 * y rechaza el token si sessionVersion ya no coincide.
 *
 * Cookies: Auth.js las emite httpOnly + SameSite=Lax, y con prefijo
 * `__Secure-` + flag Secure cuando AUTH_URL es https (producción).
 */
export const authConfig = {
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role
        token.isActive = user.isActive
        token.sessionVersion = user.sessionVersion
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id
        session.user.role = token.role
        session.user.isActive = token.isActive
        session.user.sessionVersion = token.sessionVersion
      }
      return session
    },
  },
} satisfies NextAuthConfig
