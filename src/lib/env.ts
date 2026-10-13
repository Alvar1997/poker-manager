import { z } from "zod"

/**
 * Validación centralizada de variables de entorno.
 *
 * Deliberadamente perezosa: `getEnv()` solo valida la primera vez que se
 * invoca (y memoiza el resultado), en vez de ejecutarse al importar este
 * módulo. Esto evita que `next build` falle por falta de credenciales de
 * Neon que todavía no existen — el error real aparece al primer uso real
 * (p. ej. una query de Prisma o el handler de /api/health/ready), que es
 * donde corresponde.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL es requerida (conexión pooled de Neon)")
    .refine(
      (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DATABASE_URL debe ser una cadena de conexión PostgreSQL"
    ),
  DIRECT_URL: z
    .string()
    .min(
      1,
      "DIRECT_URL es requerida (conexión directa de Neon para migraciones)"
    )
    .refine(
      (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DIRECT_URL debe ser una cadena de conexión PostgreSQL"
    ),

  AUTH_SECRET: z
    .string()
    .min(
      32,
      "AUTH_SECRET debe tener al menos 32 caracteres (usa `npx auth secret`)"
    ),
  AUTH_URL: z.string().url().default("http://localhost:3000"),

  /**
   * Clave AES-256 (32 bytes en base64) para cifrar datos bancarios.
   * Opcional para arrancar; obligatoria para capturar número de cuenta o
   * CLABE. Genérala con `openssl rand -base64 32`.
   */
  SETTINGS_ENCRYPTION_KEY: z
    .string()
    .refine(
      (key) => Buffer.from(key, "base64").length === 32,
      "SETTINGS_ENCRYPTION_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)"
    )
    .optional(),

  // WhatsApp Cloud API — PENDIENTE (Módulo 13). Sin valores todavía: el
  // número exclusivo de Poker Manager aún no está disponible.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  NEXT_PUBLIC_APP_NAME: z.string().default("Poker Manager"),
  APP_TIMEZONE: z.string().default("America/Monterrey"),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/** Valida (una sola vez) y devuelve las variables de entorno. Lanza un error legible si falta o es inválida alguna. */
export function getEnv(): Env {
  if (cached) return cached

  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n")

    throw new Error(
      `Variables de entorno inválidas o faltantes:\n${formatted}\n\n` +
        "Revisa .env.example y crea tu propio .env.local con credenciales reales (ver docs/SETUP.md)."
    )
  }

  cached = result.data
  return cached
}

/** Solo para pruebas: limpia la memoización entre casos. */
export function __resetEnvCacheForTests(): void {
  cached = undefined
}
