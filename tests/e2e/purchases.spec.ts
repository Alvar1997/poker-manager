import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 08 — compras y recompras por IMPORTE con una sesión REAL abierta
 * por API (flujo del Módulo 06, solo en la base de pruebas). Cada proyecto
 * abre su propia sesión y su jugador. Aquí se verifica que sin firma la
 * entrega con crédito queda BLOQUEADA; el flujo con firma real dibujada en
 * el canvas está en `signatures.spec.ts` (Módulo 09).
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let playerName = ""
let t25 = ""
let t10 = ""
let participationId = ""
let cardRef = ""

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

async function api<T>(
  page: Page,
  method: "get" | "post",
  url: string,
  data?: unknown
): Promise<T> {
  const res =
    method === "get"
      ? await page.request.get(url)
      : await page.request.post(url, { data })
  const body = await res.json()
  expect(res.ok(), JSON.stringify(body)).toBeTruthy()
  return body.data as T
}

async function balances(page: Page) {
  return api<{ cashOnHand: string | null; cardPendingSettlement: string }>(
    page,
    "get",
    "/api/cash-box/balances"
  )
}

/** Inicia una compra desde la mesa (botón "Nueva compra" del jugador). */
async function startPurchaseFromTable(
  page: Page,
  tableId: string,
  amount: string
) {
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${tableId}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: playerName })
    .getByTestId("new-purchase-for-player")
    .click()
  await expect(page).toHaveURL(/\/dashboard\/compras\/nueva\?participationId=/)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "context-player")).toContainText(playerName)
  await page.getByLabel("Importe solicitado").fill(amount)
  await visible(page, "create-purchase").click()
  await expect(page).toHaveURL(/\/dashboard\/compras\/[A-Za-z0-9_-]+$/)
  await page.waitForLoadState("networkidle")
}

async function addCash(page: Page, amount: string) {
  const form = visible(page, "add-payment-form")
  await form.getByLabel("Método").selectOption("CASH")
  await form.getByLabel("Importe de este pago").fill(amount)
  await form.getByTestId("cash-received").check()
  await form.getByTestId("add-payment").click()
  await expect(page.getByText("Pago registrado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
}

async function confirmDelivery(page: Page) {
  await visible(page, "physical-delivery").check()
  await visible(page, "confirm-delivery").click()
  await expect(visible(page, "purchase-status")).toHaveText("Entregada")
}

test("prepara sesión, mesas 25/25 y 10/10 y un jugador sentado", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request, { minNominal: 20_000 })).id
  playerName = `Jugador Compra ${testInfo.project.name} ${Date.now() % 100000}`
  cardRef = `AUT-${testInfo.project.name.slice(0, 3)}-${Date.now() % 100000}`
  const player = await createE2EPlayer(page.request, playerName)
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${sessionId}/tables`
  )
  t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  t10 = tables.find((t) => t.name === "Mesa 10/10")!.tableId
  for (const t of [t25, t10])
    await api(page, "post", `/api/sessions/${sessionId}/tables/${t}/open`, {
      idempotencyKey: randomUUID(),
    })
  const p = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${sessionId}/tables/${t25}/players`,
    { playerId: player.id, idempotencyKey: randomUUID() }
  )
  participationId = p.id
})

test("compra de $5,000 SOLO por importe, pagada en efectivo y entregada sin firma", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const before = await balances(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: playerName })
    .getByTestId("new-purchase-for-player")
    .click()
  await page.waitForLoadState("networkidle")
  // Paso 2: un único campo (importe). Ninguna denominación ni cantidad de fichas.
  await expect(page.locator("main input:visible")).toHaveCount(1)
  await expect(page.getByLabel(/cantidad|denominaci/i)).toHaveCount(0)
  await expect(visible(page, "create-purchase")).toBeDisabled()
  await page.getByLabel("Importe solicitado").fill("0")
  await expect(visible(page, "create-purchase")).toBeDisabled()
  await page.getByLabel("Importe solicitado").fill("5000")
  await visible(page, "create-purchase").click()
  await expect(page).toHaveURL(/\/dashboard\/compras\/[A-Za-z0-9_-]+$/)
  await page.waitForLoadState("networkidle")

  await expect(visible(page, "purchase-amount")).toContainText("5,000.00")
  await expect(page.getByLabel(/denominaci/i)).toHaveCount(0)
  await addCash(page, "5000")
  await expect(visible(page, "outstanding")).toContainText("0.00")
  // Pagada por completo: sin socio, sin firma, sin bloqueos.
  await expect(visible(page, "credit-step")).toHaveCount(0)
  await expect(visible(page, "signature-step")).toHaveCount(0)
  await expect(visible(page, "delivery-blockers")).toHaveCount(0)
  await confirmDelivery(page)
  await expect(visible(page, "purchase-kind")).toHaveText("Compra inicial")
  const after = await balances(page)
  expect(Number(after.cashOnHand)).toBe(Number(before.cashOnHand ?? 0) + 5000)
  await noHorizontalScroll(page)
})

test("recompra parcialmente a crédito: socio VERBAL, firma obligatoria y entrega bloqueada sin firma auténtica", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await startPurchaseFromTable(page, t25, "3000")
  await addCash(page, "1000")
  await expect(visible(page, "outstanding")).toContainText("2,000.00")
  await expect(visible(page, "credit-step")).toBeVisible()
  const form = visible(page, "credit-auth-form")
  await form
    .getByLabel("Socio que autorizó")
    .selectOption({ label: "Socio E2E" })
  await form.getByLabel("Verbal").check()
  await form.getByTestId("save-credit-auth").click()
  await expect(visible(page, "credit-authorizer")).toContainText("Socio E2E")
  await expect(visible(page, "credit-authorizer")).toContainText("verbal")
  // La firma es obligatoria con crédito y el Módulo 09 aún no existe.
  await expect(visible(page, "signature-required")).toBeVisible()
  await expect(visible(page, "delivery-blockers")).toContainText(/firma/i)
  await expect(visible(page, "confirm-delivery")).toBeDisabled()
  // El servidor también la rechaza aunque se intente directamente.
  const id = page.url().split("/").pop()!
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/purchases/${id}`
  )
  const res = await page.request.post(`/api/purchases/${id}/confirm-delivery`, {
    data: {
      expectedVersion: view.version,
      physicalDeliveryConfirmed: true,
      idempotencyKey: randomUUID(),
    },
  })
  expect(res.status()).toBe(422)
  expect((await res.json()).error.message).toMatch(/firma/i)
  await noHorizontalScroll(page)

  // Se libera: devolver el efectivo y cancelar el borrador.
  await visible(page, "return-cash").click()
  await page.getByLabel("Motivo").fill("Se devolvió en mano")
  await page.getByText("Devolví el efectivo al jugador").click()
  await page.getByTestId("return-cash-confirm").click()
  await expect(page.getByText("Pago retirado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await visible(page, "cancel-purchase").click()
  await page.getByLabel("Motivo").fill("Sin firma disponible todavía")
  await page.getByTestId("cancel-purchase-confirm").click()
  await expect(visible(page, "purchase-status")).toHaveText("Cancelada")
})

test("cambio de mesa: la recompra continúa la numeración y la tarjeta aprobada no aumenta el efectivo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await api(page, "post", `/api/sessions/${sessionId}/table-transfers`, {
    sourceParticipationId: participationId,
    destinationTableId: t10,
    idempotencyKey: randomUUID(),
  })
  const before = await balances(page)
  await startPurchaseFromTable(page, t10, "2000")
  const form = visible(page, "add-payment-form")
  await form.getByLabel("Método").selectOption("CARD_DEBIT")
  await form.getByLabel("Importe de este pago").fill("2000")
  await form.getByLabel("Resultado en la terminal").selectOption("APPROVED")
  await form.getByLabel(/Folio o autorización/).fill(cardRef)
  await form.getByTestId("card-approved").check()
  await form.getByTestId("add-payment").click()
  await expect(page.getByText("Pago registrado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "outstanding")).toContainText("0.00")
  await confirmDelivery(page)
  // Numeración por sesión y jugador: la primera compra fue en 25/25.
  await expect(visible(page, "purchase-kind")).toHaveText("Recompra 1")
  await expect(visible(page, "purchase-table")).toHaveText("Mesa 10/10")
  const after = await balances(page)
  expect(after.cashOnHand).toBe(before.cashOnHand)
  expect(Number(after.cardPendingSettlement)).toBe(
    Number(before.cardPendingSettlement) + 2000
  )
  // La compra inicial conserva su mesa original.
  const list = await api<{
    items: { purchaseType: string; table: { name: string } }[]
  }>(page, "get", `/api/sessions/${sessionId}/purchases?status=CONFIRMED`)
  expect(
    list.items.find((i) => i.purchaseType === "INITIAL_PURCHASE")?.table.name
  ).toBe("Mesa 25/25")
})

test("depósito de la terminal: liquida el cobro sin reconocer la venta otra vez", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const before = await balances(page)
  await page.goto("/dashboard/caja/terminal")
  await page.waitForLoadState("networkidle")
  await page.getByText(cardRef).click()
  await expect(visible(page, "settlement-gross")).toContainText("2,000.00")
  await page.getByLabel("Importe depositado en el banco").fill("2000")
  await page.getByText("Verifiqué el depósito en la cuenta bancaria").click()
  await page.getByRole("button", { name: "Registrar depósito" }).click()
  await expect(page.getByText("Depósito registrado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(cardRef)).toHaveCount(0)
  const after = await balances(page)
  expect(Number(after.cardPendingSettlement)).toBe(
    Number(before.cardPendingSettlement) - 2000
  )
  expect(after.cashOnHand).toBe(before.cashOnHand)
  await noHorizontalScroll(page)
})

test("transferencia pendiente: no cuenta como cobro y queda como importe por cobrar", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await startPurchaseFromTable(page, t10, "1000")
  const form = visible(page, "add-payment-form")
  await form.getByLabel("Método").selectOption("BANK_TRANSFER")
  await form.getByLabel("Importe de este pago").fill("1000")
  await form.getByLabel("Referencia (opcional)").fill("SPEI-E2E")
  await form.getByTestId("add-payment").click()
  await expect(page.getByText("Pago registrado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "confirmed-payments")).toContainText("0.00")
  await expect(visible(page, "pending-transfers")).toContainText("1,000.00")
  await expect(visible(page, "outstanding")).toContainText("1,000.00")
  await expect(visible(page, "payment-status")).toHaveText(
    "Pendiente de verificación"
  )
  await expect(visible(page, "credit-step")).toBeVisible()
  await noHorizontalScroll(page)
})

test("historial de compras con filtros y diseño móvil", async ({ page }) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/compras?sessionId=${sessionId}`)
  await page.waitForLoadState("networkidle")
  const rows = visible(page, "purchase-row").filter({ hasText: playerName })
  await expect(rows).toHaveCount(4)
  await expect(rows.filter({ hasText: "Compra inicial" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Recompra 1" })).toHaveCount(1)
  await page.goto(
    `/dashboard/compras?sessionId=${sessionId}&status=CONFIRMED&method=CARD_DEBIT`
  )
  await page.waitForLoadState("networkidle")
  await expect(
    visible(page, "purchase-row").filter({ hasText: playerName })
  ).toHaveCount(1)
  await noHorizontalScroll(page)
  // Compras de la mesa 25/25: solo la compra inicial (y la cancelada).
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/compras`)
  await page.waitForLoadState("networkidle")
  await expect(
    visible(page, "purchase-row").filter({ hasText: "Entregada" })
  ).toHaveCount(1)
  await noHorizontalScroll(page)
})

test("errores y permisos: sin sesión 401, sin denominaciones ni datos de tarjeta (400)", async ({
  page,
  playwright,
}) => {
  const users = requireE2EUsers()
  const anonymous = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  })
  const anon = await anonymous.post("/api/purchases", {
    data: {
      participationId,
      nominalAmount: "1000",
      idempotencyKey: randomUUID(),
    },
  })
  expect(anon.status()).toBe(401)
  await anonymous.dispose()

  await login(page, users.partner)
  const withChips = await page.request.post("/api/purchases", {
    data: {
      participationId,
      nominalAmount: "1000",
      denominations: [{ value: "100", quantity: 10 }],
      idempotencyKey: randomUUID(),
    },
  })
  expect(withChips.status()).toBe(400)
  // El socio también opera compras (los tres roles).
  const list = await page.request.get(`/api/sessions/${sessionId}/purchases`)
  expect(list.status()).toBe(200)
})
