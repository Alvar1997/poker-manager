import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Pruebas de integración: Route Handlers + servicios + Prisma contra un
 * PostgreSQL REAL y desechable (TEST_DATABASE_URL). Solo se simula la
 * decodificación del JWT de Auth.js (qué usuario dice ser la cookie);
 * todo lo demás — validación, autorización, reglas de negocio,
 * transacciones, auditoría — corre de verdad. Ver docs/SETUP.md.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.int.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    // Una sola base compartida: los archivos corren en serie.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
