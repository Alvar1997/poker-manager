import { config as loadEnv } from "dotenv"
import { defineConfig } from "prisma/config"

// Sigue la convención de Next.js: .env.local tiene prioridad (no se versiona),
// con fallback a .env para entornos de CI que inyectan variables por otro medio.
// quiet:true suprime el banner promocional que dotenv imprime por defecto.
loadEnv({ path: ".env.local", quiet: true })
loadEnv({ quiet: true })

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Nota: el bootstrap del SUPERADMIN (prisma/seed.ts) deliberadamente
  // NO está conectado aquí como `migrations.seed` — eso haría que
  // `prisma migrate dev` lo ejecute automáticamente en cada migración.
  // Se ejecuta a mano, una vez, vía `npm run db:seed` (ver prisma/seed.ts).
  // Usado solo por el motor de migraciones (migrate/db push/studio).
  // DIRECT_URL = conexión sin pooling, requerida por Neon para DDL.
  // El runtime de la app usa DATABASE_URL (pooled) vía adapter — ver
  // src/lib/prisma.ts — y es independiente de esta configuración.
  datasource: {
    url: process.env["DIRECT_URL"],
  },
})
