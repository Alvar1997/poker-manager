import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { loadE2EUsers, login, navigation, requireE2EUsers } from "./helpers"
import { resetActiveSessions } from "./session-fixtures"

/**
 * Módulo 05 — Caja central con sesión real. No existe sesión operativa
 * (Módulo 06): la caja debe mostrarlo y bloquear el efectivo. Las
 * transferencias pendientes son fixtures de global-setup (una para
 * confirmar y otra para rechazar por proyecto).
 */
test.describe.configure({ mode: "serial" })

// La caja debe verse SIN sesión: se cierran las sesiones vigentes que hayan
// dejado otras specs en la base de pruebas.
test.beforeAll(async () => {
  if (loadE2EUsers()) await resetActiveSessions()
})

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const sender = (t: TestInfo, action: "confirmar" | "rechazar") =>
  `E2E ${t.project.name} ${action}`

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test("sin sesión: /caja muestra el aviso, bloquea el efectivo y no ofrece gastos", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const nav = await navigation(page)
  await expect(nav.getByRole("link", { name: "Caja" })).toBeVisible()

  await page.goto("/caja")
  await expect(page).toHaveURL(/\/dashboard\/caja$/)
  await expect(visible(page, "no-session")).toContainText(
    "No hay una sesión operativa abierta."
  )
  await expect(visible(page, "cash-on-hand")).toHaveText("Sin sesión")
  await expect(page.getByRole("link", { name: /gasto/i })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /gasto/i })).toHaveCount(0)
  await noHorizontalScroll(page)

  await page.goto("/dashboard/caja/salida")
  await expect(visible(page, "no-session")).toBeVisible()
  await expect(visible(page, "no-expenses")).toContainText("no registra gastos")
  await expect(page.getByRole("textbox")).toHaveCount(0)

  const accounts = await page.request.get("/api/cash-box/accounts")
  expect(accounts.status()).toBe(200)
  const kinds = ((await accounts.json()).data as { kind: string }[]).map(
    (a) => a.kind
  )
  expect(kinds).toEqual(
    expect.arrayContaining(["CASH_ON_HAND", "BANK", "CASH_IN_TRANSIT"])
  )
  expect(kinds.some((k) => /EXPENSE/.test(k))).toBe(false)

  const contribution = await page.request.post("/api/cash-box/contributions", {
    data: {
      sessionId: "SES-1",
      amount: "100",
      contributorName: "Socio",
      reason: "Aportación",
      idempotencyKey: "e2e-key-00000001",
    },
  })
  expect(contribution.status()).toBe(422)
  expect((await contribution.json()).error.message).toContain(
    "No hay una sesión operativa abierta"
  )

  const expense = await page.request.post("/api/cash-box/withdrawals", {
    data: {
      sessionId: "SES-1",
      amount: "100",
      destination: "EXPENSE",
      recipientName: "Tienda",
      reason: "Comida",
      idempotencyKey: "e2e-key-00000002",
    },
  })
  expect(expense.status()).toBe(400)
})

test("el cajero confirma manualmente una transferencia verificada", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/dashboard/caja/transferencias")
  await page.waitForLoadState("networkidle")
  const row = visible(page, "transfer-row").filter({
    hasText: sender(testInfo, "confirmar"),
  })
  await expect(row).toContainText("Pendiente de verificación")
  await row.getByTestId("transfer-confirm").click()

  const submit = page.getByTestId("transfer-submit")
  await expect(submit).toBeDisabled() // sin declarar la verificación no se puede
  await page.getByTestId("transfer-verified").check()
  await submit.click()
  await expect(row).toHaveCount(0)

  await page.goto("/dashboard/caja/transferencias?status=CONFIRMED")
  const confirmed = visible(page, "transfer-row").filter({
    hasText: sender(testInfo, "confirmar"),
  })
  await expect(confirmed).toContainText("Verificó Cajero E2E")
  await noHorizontalScroll(page)
})

test("rechazar exige motivo y no registra entrada", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto("/dashboard/caja/transferencias")
  await page.waitForLoadState("networkidle")
  const row = visible(page, "transfer-row").filter({
    hasText: sender(testInfo, "rechazar"),
  })
  await row.getByTestId("transfer-reject").click()
  const submit = page.getByTestId("transfer-submit")
  await expect(submit).toBeDisabled()
  await page
    .getByTestId("reject-reason")
    .fill("No aparece en el estado de cuenta")
  await submit.click()
  await expect(row).toHaveCount(0)

  await page.goto("/dashboard/caja/transferencias?status=REJECTED")
  await expect(
    visible(page, "transfer-row").filter({
      hasText: sender(testInfo, "rechazar"),
    })
  ).toContainText("No aparece en el estado de cuenta")
})

test("el movimiento confirmado aparece en el historial y se revierte una sola vez", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  await page.goto(
    "/dashboard/caja/movimientos?type=BANK_TRANSFER_RECEIPT&status=ACTIVE"
  )
  const amount =
    testInfo.project.name === "chromium" ? /1,500\.00/ : /1,200\.00/
  const row = visible(page, "cash-movement-row")
    .filter({ hasText: amount })
    .first()
  await row.click()
  await expect(visible(page, "movement-folio")).toBeVisible()
  await page.waitForLoadState("networkidle")

  await page.getByTestId("reverse-open").filter({ visible: true }).click()
  await page.getByLabel("Motivo").fill("Prueba E2E de reverso")
  await page
    .getByRole("button", { name: "Revertir" })
    .filter({ visible: true })
    .last()
    .click()
  await expect(
    page.getByText("Revertido por").filter({ visible: true })
  ).toBeVisible()
  await expect(
    page.getByTestId("reverse-open").filter({ visible: true })
  ).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("sin sesión de usuario la API de caja responde 401", async ({
  request,
}) => {
  requireE2EUsers()
  expect((await request.get("/api/cash-box")).status()).toBe(401)
})
