import { expect, test, type Page } from "@playwright/test"

import { loadE2EUsers, login, navigation, requireE2EUsers } from "./helpers"
import {
  ensureInventoryInitialized,
  resetActiveSessions,
} from "./session-fixtures"

/**
 * Módulo 06 — sesiones y apertura con usuarios reales. Flujo único válido:
 * crear → preparar → contar el inventario compartido → conciliar → caja $0
 * → abrir. Cada proyecto (Chrome, iPhone) crea su propia sesión; antes se
 * cierran las vigentes de la base de pruebas (solo una a la vez).
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""

test.beforeAll(async () => {
  if (loadE2EUsers()) await resetActiveSessions()
})

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test("el cajero crea la sesión desde la navegación y consulta su folio", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  // El arqueo de apertura exige inventario inicializado (fixture si falta).
  await ensureInventoryInitialized(page.request)
  const nav = await navigation(page)
  await nav.getByRole("link", { name: "Sesiones y mesas" }).click()
  await expect(page).toHaveURL(/\/dashboard\/sesiones$/)
  await visible(page, "new-session-link").click()
  await page.waitForLoadState("networkidle")
  await visible(page, "create-session").click()
  await expect(page).toHaveURL(
    /\/dashboard\/sesiones\/[A-Za-z0-9]+\/preparacion$/
  )
  sessionId = page.url().split("/").at(-2)!
  await expect(
    page.getByRole("heading", { level: 1 }).filter({ visible: true })
  ).toContainText(/SES-\d{6}/)
  await noHorizontalScroll(page)
})

test("otro usuario solo consulta la preparación; SUPERADMIN sí puede continuarla", async ({
  browser,
}) => {
  const users = requireE2EUsers()
  const partner = await browser.newPage()
  await login(partner, users.partner)
  await partner.goto(`/dashboard/sesiones/${sessionId}/preparacion`)
  await expect(visible(partner, "read-only-preparation")).toContainText(
    "No tienes permiso para modificar la preparación"
  )
  await expect(partner.getByTestId("start-preparation")).toHaveCount(0)
  expect(
    (await partner.request.post(`/api/sessions/${sessionId}/prepare`)).status()
  ).toBe(403)
  await partner.close()

  const admin = await browser.newPage()
  await login(admin, users.superadmin)
  await admin.goto(`/dashboard/sesiones/${sessionId}/preparacion`)
  await expect(visible(admin, "start-preparation")).toBeVisible()
  await expect(admin.getByTestId("read-only-preparation")).toHaveCount(0)
  await admin.close()
})

test("no se puede omitir el arqueo: sin conteo el botón Abrir está deshabilitado", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/preparacion`)
  await page.waitForLoadState("networkidle")
  await visible(page, "start-preparation").click()
  await expect(visible(page, "session-status")).toHaveText("En preparación")
  await page.goto(`/dashboard/sesiones/${sessionId}/apertura`)
  await expect(visible(page, "open-session")).toBeDisabled()
  await expect(visible(page, "opening-blockers")).toContainText(
    "Falta contar el inventario"
  )
})

test("cuenta el inventario compartido, ve la diferencia y la concilia", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/arqueo-fichas`)
  await page.waitForLoadState("networkidle")
  await visible(page, "start-opening-count").click()
  const lines = visible(page, "count-line")
  await expect(lines.first()).toBeVisible()
  const n = await lines.count()
  for (let i = 0; i < n; i++) {
    const text = await lines.nth(i).locator("p").innerText()
    const expected = Number(
      text.match(/(?:Esperado|Referencia) ([\d,]+)/)![1].replace(/,/g, "")
    )
    await lines
      .nth(i)
      .getByRole("textbox")
      .pressSequentially(String(i === 0 ? Math.max(expected - 1, 0) : expected))
  }
  await page
    .getByRole("button", { name: "Confirmar conteo" })
    .filter({ visible: true })
    .click()
  await visible(page, "confirm-submit").click()
  await expect(visible(page, "count-reconciliation")).toHaveText(
    "Diferencias pendientes"
  )
  await page
    .getByLabel("Motivo")
    .filter({ visible: true })
    .fill("Faltante confirmado al recontar (E2E)")
  await page
    .getByRole("button", { name: "Revisar ajuste de conciliación" })
    .filter({ visible: true })
    .click()
  await visible(page, "confirm-submit").click()
  await expect(visible(page, "count-reconciliation")).toHaveText("Conciliado")
  await noHorizontalScroll(page)
})

test("confirma la caja física en $0.00 y el checklist queda completo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/preparacion`)
  await page.waitForLoadState("networkidle")
  await visible(page, "cash-verified").check()
  await visible(page, "confirm-opening-cash").click()
  await expect(visible(page, "cash-zero-done")).toContainText(
    "Caja confirmada en $0.00"
  )
  await expect(visible(page, "checklist-progress")).toHaveText("10 de 10")
})

test("abre la sesión con 0 mesas y la hora la asigna el servidor", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/apertura`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "initial-open-tables")).toHaveText("0")
  await visible(page, "open-session").click()
  await visible(page, "confirm-open-session").click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/sesiones/${sessionId}$`))
  await expect(visible(page, "session-status")).toHaveText("Abierta")
  await expect(visible(page, "session-opened-at")).toHaveText(
    /\d{1,2}\/\d{1,2}\/\d{2,4}, \d{1,2}:\d{2}/
  )
  await expect(visible(page, "go-tables")).toBeVisible()
  await noHorizontalScroll(page)
  // Ya hay una sesión vigente: no se puede crear otra.
  const second = await page.request.post("/api/sessions", {
    data: { idempotencyKey: `e2e-${Date.now()}-x` },
  })
  expect(second.status()).toBe(409)
})
