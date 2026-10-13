import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"

import { authConfig } from "@/lib/auth.config"
import { AUDIT_ACTIONS, recordAuditSafe } from "@/modules/audit/audit.service"
import { LOGIN_RATE_LIMITED_CODE } from "@/modules/auth/auth.schemas"
import { authenticateWithCredentials } from "@/modules/auth/auth.service"
import { clientIpFrom } from "@/modules/auth/login-throttle"

/**
 * Auth.js v5 — configuración completa (Node runtime).
 *
 * - Estrategia JWT (Credentials no es compatible con el adaptador de
 *   base de datos de Auth.js): por eso no existen modelos
 *   Account/Session/VerificationToken.
 * - Login/logout los resuelven las rutas de Auth.js
 *   (/api/auth/callback/credentials, /api/auth/signout) — con su propia
 *   protección CSRF (token doble envío). No hay endpoints duplicados.
 * - `authorize` delega en authenticateWithCredentials: validación Zod,
 *   usuario activo, bcrypt, limitador de intentos y auditoría.
 * - Revocación: cada request autenticada vuelve a leer el usuario en la
 *   base y compara sessionVersion (ver src/config/permissions.ts). Al
 *   desactivar, cambiar rol o cambiar/restablecer contraseña, los JWT
 *   previos dejan de valer de inmediato en el servidor.
 * - No hay registro público.
 */

class RateLimitedSignin extends CredentialsSignin {
  code = LOGIN_RATE_LIMITED_CODE
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Correo", type: "email" },
        password: { label: "Contraseña", type: "password" },
      },
      async authorize(rawCredentials, request) {
        const result = await authenticateWithCredentials(rawCredentials, {
          ip: clientIpFrom(request?.headers),
          requestId: request?.headers?.get("x-request-id") ?? undefined,
        })

        if (!result.ok) {
          if (result.reason === "rate_limited") throw new RateLimitedSignin()
          // Mismo resultado para cuenta inexistente, inactiva o contraseña
          // incorrecta: no se revela cuál fue.
          return null
        }

        return result.user
      },
    }),
  ],
  events: {
    async signOut(message) {
      const userId = "token" in message ? message.token?.id : undefined
      if (!userId) return
      await recordAuditSafe({
        action: AUDIT_ACTIONS.LOGOUT,
        entityType: "User",
        entityId: userId,
        actorUserId: userId,
      })
    },
  },
})
