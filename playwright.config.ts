import { defineConfig, devices } from "@playwright/test"

const PORT = 3100
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
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
      // El smoke test E2E solo ejercita rutas que no tocan la base de
      // datos (home → redirect a /login, formulario de login). Estas
      // variables son dummies que solo satisfacen la validación de
      // src/lib/env.ts — NO apuntan a una base real. Para probar un
      // login exitoso de verdad se necesitará una base Neon real (ver
      // docs/SETUP.md) — ese caso queda pendiente hasta tener
      // credenciales, como se documenta en el reporte final.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://test:test@localhost:5432/test",
      DIRECT_URL:
        process.env.DIRECT_URL ?? "postgresql://test:test@localhost:5432/test",
      AUTH_SECRET:
        process.env.AUTH_SECRET ??
        "e2e-test-secret-at-least-32-characters-long",
      AUTH_URL: baseURL,
    },
  },
})
