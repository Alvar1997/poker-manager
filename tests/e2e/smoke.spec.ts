import { expect, test } from "@playwright/test"

/**
 * Smoke test de navegación — Módulo 00 (los flujos con sesión real del
 * Módulo 01 viven en auth-and-users.spec.ts).
 *
 * Corre contra un servidor de producción (`next build && next start`)
 * con variables de entorno dummy (ver playwright.config.ts): no hay una
 * base Neon real detrás. Por eso estos tests cubren únicamente rutas que
 * no requieren una conexión exitosa a la base de datos:
 *   - que la app arranca y responde,
 *   - el redirect raíz → /login,
 *   - la protección de /dashboard sin sesión,
 *   - que el formulario de login maneja un intento fallido sin tronar.
 *
 * Un login EXITOSO de punta a punta (con un usuario real) requiere
 * credenciales de Neon reales y queda pendiente — ver docs/SETUP.md y el
 * reporte final del Módulo 00.
 */

test("la aplicación responde y redirige la raíz a /login sin sesión", async ({
  page,
}) => {
  const response = await page.goto("/")
  expect(response?.status()).toBeLessThan(400)
  await expect(page).toHaveURL(/\/login/)
  await expect(
    page.getByRole("heading", { name: "Iniciar sesión" })
  ).toBeVisible()
})

test("/dashboard sin sesión redirige a /login (protección de middleware)", async ({
  page,
}) => {
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fdashboard/)
})

test("el formulario de login muestra validación de campos vacíos", async ({
  page,
}) => {
  await page.goto("/login")
  // Esperar la hidratación antes de interactuar (WebKit).
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Entrar" }).click()

  await expect(page.getByText("El correo es requerido")).toBeVisible()
  await expect(page.getByText("La contraseña es requerida")).toBeVisible()
})

test("un intento de login fallido no rompe la página y muestra un error", async ({
  page,
}) => {
  await page.goto("/login")
  // Esperar la hidratación antes de interactuar (WebKit).
  await page.waitForLoadState("networkidle")

  await page.getByLabel("Correo").fill("nadie@example.com")
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("contraseña-incorrecta")
  await page.getByRole("button", { name: "Entrar" }).click()

  await expect(
    page.getByRole("alert").filter({ hasText: /incorrectos|conectar/ })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})
