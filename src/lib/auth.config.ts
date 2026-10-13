import type { NextAuthConfig } from "next-auth"

/**
 * Parte de la configuración de Auth.js segura para Edge Runtime.
 *
 * `src/proxy.ts` corre en Edge Runtime y solo necesita decodificar el JWT
 * de sesión para decidir si redirige a /login — no necesita el provider
 * de Credentials (que importa Prisma + bcryptjs, ambos incompatibles con
 * Edge: usan APIs de Node como `node:path`). Por eso este archivo NO
 * incluye `providers`; la configuración completa (con Credentials) vive
 * en src/lib/auth.ts, usado solo en Route Handlers / Server Components
 * (Node runtime).
 */
export const authConfig = {
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,
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
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as "SUPERADMIN" | "PARTNER" | "CASHIER"
        session.user.isActive = token.isActive as boolean
      }
      return session
    },
  },
} satisfies NextAuthConfig
