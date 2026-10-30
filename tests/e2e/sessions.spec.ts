import { expect, test, type Page } from "@playwright/test"

import { loadE2EUsers, login, navigation, requireE2EUsers } from "./helpers"
import {
  ensureInventoryInitialized,
  resetActiveSessions,
} from "./session-fixtures"

/**
 * Módulo 06 — apertura con el ASISTENTE de 4 pasos y usuarios reales:
 * crear jornada → contar el inventario compartido (RESOLVER → arqueo →
 * «Volver a la apertura») → preparar mesas (opcional) → caja $0 y ABRIR
 * JORNADA. Cada proyecto (Chrome, iPhone) crea su propia sesión; antes se
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

const wizard = (step?: number) =>
  `/dashboard/sesiones/${sessionId}/apertura${step ? `?paso=${step}` : ""}`

test("el cajero crea la jornada desde la navegación y entra al asistente", async ({
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
  await expect(page).toHaveURL(/\/dashboard\/sesiones\/[A-Za-z0-9]+\/apertura$/)
  sessionId = page.url().split("/").at(-2)!
  await expect(
    page.getByRole("heading", { level: 1 }).filter({ visible: true })
  ).toContainText(/S-\d{4,}-\d{8}/)
  await expect(visible(page, "wizard-progress")).toHaveText(
    "Progreso: 0 de 4 pasos"
  )
  await expect(visible(page, "wizard-step-1")).toHaveAttribute(
    "data-status",
    "BLOCKED"
  )
  await noHorizontalScroll(page)
})

test("otro usuario solo consulta la apertura; SUPERADMIN sí puede continuarla", async ({
  browser,
}) => {
  const users = requireE2EUsers()
  const partner = await browser.newPage()
  await login(partner, users.partner)
  await partner.goto(wizard())
  await expect(visible(partner, "read-only-preparation")).toContainText(
    "pueden continuar esta preparación"
  )
  await expect(partner.getByTestId("opening-start")).toHaveCount(0)
  expect(
    (await partner.request.post(`/api/sessions/${sessionId}/prepare`)).status()
  ).toBe(403)
  expect(
    (
      await partner.request.patch(`/api/sessions/${sessionId}/opening/wizard`, {
        data: { currentStep: 2 },
      })
    ).status()
  ).toBe(403)
  await partner.close()

  const admin = await browser.newPage()
  await login(admin, users.superadmin)
  await admin.goto(wizard())
  await expect(visible(admin, "opening-start")).toBeVisible()
  await expect(admin.getByTestId("read-only-preparation")).toHaveCount(0)
  await admin.close()
})

test("paso 1 guarda la jornada; sin conteo, ABRIR JORNADA está bloqueado con el pendiente", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(wizard())
  await page.waitForLoadState("networkidle")
  await visible(page, "opening-notes").fill("Jornada de prueba E2E")
  await visible(page, "opening-start").click()
  await expect(page).toHaveURL(/apertura\?paso=2$/)
  await expect(visible(page, "wizard-step-1")).toHaveAttribute(
    "data-status",
    "COMPLETED"
  )
  await expect(
    visible(page, "wizard-task").filter({ hasText: "Falta contar" })
  ).toHaveAttribute("data-code", "CHIP_COUNT_MISSING")
  await page.goto(wizard(4))
  await expect(visible(page, "wizard-open")).toBeDisabled()
  await expect(visible(page, "opening-blockers")).toContainText(
    "Falta contar el inventario"
  )
})

test("RESOLVER lleva al arqueo; cuenta, concilia la diferencia y vuelve a la apertura", async ({
  page,
}) => {
  // Flujo largo (RESOLVER, conteo, conciliación y regreso): más tiempo en móvil.
  test.slow()
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(wizard(2))
  await page.waitForLoadState("networkidle")
  await visible(page, "wizard-resolve").click()
  await expect(page).toHaveURL(
    new RegExp(`/sesiones/${sessionId}/arqueo-fichas$`)
  )
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

  await expect(visible(page, "closure-return")).toContainText(
    "Volver a la apertura"
  )
  await visible(page, "closure-return").click()
  await expect(page).toHaveURL(/apertura\?paso=2$/)
  await expect(visible(page, "wizard-step-2")).toHaveAttribute(
    "data-status",
    "COMPLETED"
  )
  await expect(visible(page, "opening-count-status")).toHaveText(
    "Confirmado y conciliado"
  )
})

test("paso 3: agrega y quita mesas sin mover fichas; el progreso se conserva al recargar", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(wizard(3))
  await page.waitForLoadState("networkidle")
  await expect(
    visible(page, "wizard-task").filter({ hasText: "No has agregado mesas" })
  ).toBeVisible()
  await visible(page, "opening-add-table")
    .and(page.locator('[data-table="TABLE_10_10"]'))
    .click()
  await expect(
    visible(page, "opening-planned-table").and(
      page.locator('[data-table="TABLE_10_10"]')
    )
  ).toBeVisible()
  await visible(page, "opening-add-table")
    .and(page.locator('[data-table="TABLE_25_25"]'))
    .click()
  await expect(visible(page, "opening-planned-table")).toHaveCount(2)
  await visible(page, "opening-planned-table")
    .and(page.locator('[data-table="TABLE_10_10"]'))
    .getByTestId("opening-remove-table")
    .click()
  await expect(visible(page, "opening-planned-table")).toHaveCount(1)
  await expect(visible(page, "wizard-step-3")).toHaveAttribute(
    "data-status",
    "COMPLETED"
  )
  // Recargar sin ?paso: vuelve al paso guardado con las mesas preparadas.
  await page.goto(wizard())
  await expect(visible(page, "wizard-panel-tables")).toBeVisible()
  await expect(visible(page, "opening-planned-table")).toHaveAttribute(
    "data-table",
    "TABLE_25_25"
  )
  await noHorizontalScroll(page)
})

test("paso 4: confirma la caja en $0.00 y el resumen queda listo (3 de 4)", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(wizard(4))
  await page.waitForLoadState("networkidle")
  await visible(page, "cash-verified").check()
  await visible(page, "confirm-opening-cash").click()
  await expect(visible(page, "cash-zero-done")).toContainText(
    "Caja confirmada en $0.00"
  )
  await expect(visible(page, "opening-summary-cash")).toHaveText("$0.00")
  await expect(visible(page, "opening-summary-tables")).toContainText("1:")
  await expect(visible(page, "wizard-progress")).toHaveText(
    "Progreso: 3 de 4 pasos"
  )
  await expect(visible(page, "wizard-open")).toBeEnabled()
  await noHorizontalScroll(page)
})

test("ABRIR JORNADA abre la sesión con su mesa y la hora la asigna el servidor", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(wizard(4))
  await page.waitForLoadState("networkidle")
  await visible(page, "wizard-open").click()
  await visible(page, "wizard-open-final").click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/sesiones/${sessionId}$`))
  await expect(visible(page, "session-status")).toHaveText("Abierta")
  await expect(visible(page, "session-opened-at")).toHaveText(
    /\d{1,2}\/\d{1,2}\/\d{2,4}, \d{1,2}:\d{2}/
  )
  await expect(visible(page, "go-tables")).toBeVisible()
  await noHorizontalScroll(page)
  // La mesa preparada quedó abierta; la otra no.
  const tables = await (
    await page.request.get(`/api/sessions/${sessionId}/tables`)
  ).json()
  const byCode = (code: string) =>
    (tables.data as { code: string; status: string }[]).find(
      (t) => t.code === code
    )?.status
  expect(byCode("TABLE_25_25")).toBe("OPEN")
  expect(byCode("TABLE_10_10")).toBe("PENDING")
  // La apertura de una jornada abierta ya no se edita.
  await page.goto(wizard())
  await expect(page).toHaveURL(new RegExp(`/dashboard/sesiones/${sessionId}$`))
  // Ya hay una sesión vigente: no se puede crear otra.
  const second = await page.request.post("/api/sessions", {
    data: { idempotencyKey: `e2e-${Date.now()}-x` },
  })
  expect(second.status()).toBe(409)
})
