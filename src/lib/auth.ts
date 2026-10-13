import bcrypt from "bcryptjs"
import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { z } from "zod"

import { authConfig } from "@/lib/auth.config"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"

/**
 * Auth.js v5 — configuración completa (Node runtime).
 *
 * Decisiones de diseño (Módulo 00):
 *
 * - Estrategia de sesión: JWT, no "database" (definida en
 *   auth.config.ts). El `Credentials` provider de Auth.js no es
 *   compatible con el adaptador de base de datos — Auth.js requiere que
 *   la verificación de credenciales sea responsabilidad de `authorize`,
 *   y solo soporta sesiones JWT en ese caso. Por eso NO se crean los
 *   modelos Account/Session/VerificationToken — no hacen falta.
 * - El JWT embebe únicamente id, role e isActive (lo mínimo para
 *   autorizar). El resto de datos del usuario se consulta a la DB
 *   cuando se necesita, no se cachea en la sesión del cliente.
 * - Si se desactiva un usuario, pierde acceso en su próximo inicio de
 *   sesión o cuando el JWT expire (maxAge en auth.config.ts) — no es
 *   instantáneo. Revocación inmediata queda fuera de alcance del
 *   Módulo 00; se documenta como pendiente en docs/ARCHITECTURE.md.
 * - No hay registro público: los usuarios solo se crean vía
 *   `npm run db:seed` (bootstrap del primer SUPERADMIN) o, en el
 *   Módulo 01, por un SUPERADMIN autenticado.
 * - Este archivo importa Prisma y bcryptjs (Node-only) — por eso NO se
 *   usa directamente en src/proxy.ts (Edge Runtime). Ver auth.config.ts.
 */

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Correo", type: "email" },
        password: { label: "Contraseña", type: "password" },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials)
        if (!parsed.success) return null

        const { email, password } = parsed.data

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
        })

        if (!user || !user.isActive) {
          // Mismo resultado (null) tanto si no existe como si está
          // desactivado o la contraseña es incorrecta — no revelar cuál.
          return null
        }

        const passwordMatches = await bcrypt.compare(
          password,
          user.passwordHash
        )
        if (!passwordMatches) return null

        await prisma.user
          .update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          })
          .catch((error: unknown) => {
            // No bloquear el login por un fallo al actualizar lastLoginAt.
            logger.warn({ event: "login_last_login_update_failed", error })
          })

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
        }
      },
    }),
  ],
})
