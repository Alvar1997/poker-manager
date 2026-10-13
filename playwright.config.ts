import { defineConfig, devices } from "@playwright/test"

const PORT = 3100
const baseURL = `http://localhost:${PORT}`

// Base desechable para los E2E con sesión real (login, administración de
// usuarios, denegación). Sin ella solo corren los smoke tests sin base.
const testDatabaseUrl = process.env.TEST_DATABASE_URL

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  // `prisma dev` (PGlite) atiende una sola sesión real y mezcla mensajes
  // de conexiones concurrentes (error 08P01). Con esa base, en serie.
  workers: testDatabaseUrl ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 14"] },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // Con TEST_DATABASE_URL el servidor usa esa base local desechable
      // (ver tests/e2e/global-setup.ts). Sin ella, valores dummy que solo
      // satisfacen src/lib/env.ts. NUNCA se usa la DATABASE_URL real.
      DATABASE_URL:
        testDatabaseUrl ?? "postgresql://test:test@localhost:5432/test",
      DIRECT_URL:
        testDatabaseUrl ?? "postgresql://test:test@localhost:5432/test",
      AUTH_SECRET:
        process.env.AUTH_SECRET ??
        "e2e-test-secret-at-least-32-characters-long",
      AUTH_URL: baseURL,
      LOG_LEVEL: "warn",
    },
  },
})
