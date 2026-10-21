import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import {
  createE2EPlayer,
  openSessionViaApi,
  resetActiveSessions,
} from "./session-fixtures"

/**
 * Módulo 10 — créditos, abonos FIFO, transferencias, abonos administrativos y
 * custodia. Las deudas se crean con el flujo REAL (compra + socio + firma por
 * trazos + entrega) en la base de pruebas; los abonos se registran desde la UI.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let playerId = ""
let playerName = ""

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const STROKES = [
  Array.from({ length: 40 }, (_, i) => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i) => [150 + i * 50, 360]),
]

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
) {
  const res =
    method === "get"
      ? await page.request.get(url)
      : await page.request.post(url, { data })
  const body = await res.json()
  expect(res.ok(), JSON.stringify(body)).toBeTruthy()
  return body.data as T
}

/** Deuda real: compra a crédito con socio, firma y entrega confirmada. */
async function createDebt(page: Page, participationId: string, amount: string) {
  const purchase = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId,
    nominalAmount: amount,
    idempotencyKey: randomUUID(),
  })
  const partners = await api<{ id: string; name: string }[]>(
    page,
    "get",
    "/api/purchases/authorizers"
  )
  const partner = partners.find((p) => p.name === "Socio E2E")!
  await api(
    page,
    "post",
    `/api/purchases/${purchase.id}/credit-authorization`,
    {
      partnerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: randomUUID(),
    }
  )
  const prepared = await api<{
    summary: { snapshotId: string; payloadHash: string }
  }>(page, "post", `/api/purchases/${purchase.id}/signature-summary`)
  await api(page, "post", `/api/purchases/${purchase.id}/signatures`, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/purchases/${purchase.id}`
  )
  await api(page, "post", `/api/purchases/${purchase.id}/confirm-delivery`, {
    expectedVersion: view.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: randomUUID(),
  })
}

async function outstanding(page: Page) {
  return (
    await api<{ outstanding: string }>(
      page,
      "get",
      `/api/credits/players/${playerId}`
    )
  ).outstanding
}

async function payFromUi(
  page: Page,
  amount: string,
  method: "CASH" | "BANK_TRANSFER",
  origin?: "ADMINISTRATIVE"
) {
  await page.goto(`/dashboard/creditos/abonos/nuevo?playerId=${playerId}`)
  await page.waitForLoadState("networkidle")
  const form = visible(page, "credit-payment-form")
  await form.getByLabel("Importe del abono").fill(amount)
  if (origin) await form.getByLabel("Dónde se recibe").selectOption(origin)
  await form.getByLabel("Método").selectOption(method)
  if (method === "CASH") await form.getByTestId("credit-cash-received").check()
  else
    await form
      .getByLabel("Referencia (opcional)")
      .fill(`SPEI-${randomUUID().slice(0, 8)}`)
  await expect(visible(page, "fifo-preview")).toContainText("resta")
  await visible(page, "submit-credit-payment").click()
  await expect(page).toHaveURL(/\/dashboard\/creditos\/abonos\/[A-Za-z0-9_-]+$/)
  await page.waitForLoadState("networkidle")
  return page.url().split("/").pop()!
}

test("prepara dos deudas reales (compra + firma + entrega) de un jugador", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request, { minNominal: 10_000 })).id
  playerName = `Jugador Crédito ${testInfo.project.name} ${Date.now() % 100000}`
  playerId = (await createE2EPlayer(page.request, playerName)).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${sessionId}/tables`
  )
  const t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await api(page, "post", `/api/sessions/${sessionId}/tables/${t25}/open`, {
    idempotencyKey: randomUUID(),
  })
  const p = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${sessionId}/tables/${t25}/players`,
    {
      playerId,
      idempotencyKey: randomUUID(),
    }
  )
  await createDebt(page, p.id, "1000")
  await createDebt(page, p.id, "2000")
  expect(await outstanding(page)).toBe("3000.00")
})

test("jugadores con deuda, estado de cuenta y abono parcial en efectivo con vista previa FIFO y comprobante PNG", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/dashboard/creditos/jugadores")
  await page.waitForLoadState("networkidle")
  await visible(page, "debtor-row").filter({ hasText: playerName }).click()
  await expect(page).toHaveURL(new RegExp(`/creditos/jugadores/${playerId}$`))
  await expect(visible(page, "player-outstanding")).toContainText("3,000.00")
  await expect(visible(page, "receivable-row")).toHaveCount(2)
  await expect(visible(page, "statement")).toContainText("Crédito por compra")
  await noHorizontalScroll(page)

  const id = await payFromUi(page, "1500", "CASH")
  await expect(visible(page, "credit-receipt-status")).toHaveText(
    "Abono confirmado"
  )
  await expect(visible(page, "credit-receipt")).toContainText("1. CMP-")
  await expect(visible(page, "credit-receipt")).toContainText("2. CMP-")
  await expect(visible(page, "credit-receipt")).toContainText("1,500.00")
  expect(await outstanding(page)).toBe("1500.00")
  const download = page.waitForEvent("download")
  await visible(page, "receipt-download").click()
  expect((await download).suggestedFilename()).toMatch(/^abono-.*\.png$/)
  await expect(page.getByRole("button", { name: /pdf/i })).toHaveCount(0)
  const payment = await api<{ origin: string; session: { id: string } | null }>(
    page,
    "get",
    `/api/credits/payments/${id}`
  )
  expect(payment).toMatchObject({
    origin: "SESSION",
    session: { id: sessionId },
  })
  await noHorizontalScroll(page)
})

test("transferencia pendiente no cambia la deuda; verificada se aplica", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await payFromUi(page, "500", "BANK_TRANSFER")
  await expect(visible(page, "pending-note")).toBeVisible()
  expect(await outstanding(page)).toBe("1500.00")
  await visible(page, "verified-in-bank").check()
  await visible(page, "verify-transfer").click()
  await expect(visible(page, "credit-receipt-status")).toHaveText(
    "Abono confirmado"
  )
  expect(await outstanding(page)).toBe("1000.00")
  await page.goto(`/dashboard/creditos/jugadores/${playerId}`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "credit-payment-row")).toHaveCount(2)
})

test("con la sesión cerrada: abono administrativo en efectivo a custodia, sin tocar la caja cerrada, y depósito sin doble ingreso", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const movementsBefore = (
    await api<{ total: number }>(
      page,
      "get",
      `/api/cash-box/movements?sessionId=${sessionId}`
    )
  ).total
  await resetActiveSessions() // cierre de PRUEBA (el Módulo 12 aún no existe)
  const custodyBefore = (
    await api<{ total: string }>(
      page,
      "get",
      "/api/credits/administrative/custody"
    )
  ).total
  await page.goto(`/dashboard/creditos/abonos/nuevo?playerId=${playerId}`)
  await page.waitForLoadState("networkidle")
  // Sin sesión abierta solo existe el origen administrativo.
  await expect(page.locator("#origin option")).toHaveCount(1)
  const id = await payFromUi(page, "400", "CASH")
  const payment = await api<{ origin: string; session: unknown }>(
    page,
    "get",
    `/api/credits/payments/${id}`
  )
  expect(payment).toMatchObject({ origin: "ADMINISTRATIVE", session: null })
  expect(
    (
      await api<{ total: number }>(
        page,
        "get",
        `/api/cash-box/movements?sessionId=${sessionId}`
      )
    ).total
  ).toBe(movementsBefore)
  expect(await outstanding(page)).toBe("600.00")

  await page.goto("/dashboard/creditos/custodia")
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "custody-total")).toContainText(
    new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
    }).format(Number(custodyBefore) + 400)
  )
  const bankBefore = (
    await api<{ bankKnownNet: string }>(page, "get", "/api/cash-box/balances")
  ).bankKnownNet
  const form = visible(page, "custody-deposit-form")
  await form.getByLabel("Custodio").selectOption({ index: 0 })
  await form.getByLabel("Importe depositado").fill("400")
  await form.getByText("Verifiqué el depósito en la cuenta bancaria").click()
  await form.getByTestId("custody-deposit").click()
  await expect(page.getByText("Depósito registrado").first()).toBeVisible()
  const bankAfter = (
    await api<{ bankKnownNet: string }>(page, "get", "/api/cash-box/balances")
  ).bankKnownNet
  expect(Number(bankAfter) - Number(bankBefore)).toBe(400)
  // El depósito no es otro abono: la deuda sigue igual.
  expect(await outstanding(page)).toBe("600.00")
  await noHorizontalScroll(page)
})

test("un abono mayor a la deuda se rechaza (sin saldo a favor)", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/creditos/abonos/nuevo?playerId=${playerId}`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Importe del abono").fill("700")
  await expect(visible(page, "fifo-error")).toHaveText(
    "El importe supera la deuda pendiente de $600.00."
  )
  await expect(visible(page, "submit-credit-payment")).toBeDisabled()
  const res = await page.request.post("/api/credits/payments", {
    data: {
      playerId,
      amount: "700",
      origin: "ADMINISTRATIVE",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: randomUUID(),
    },
  })
  expect(res.status()).toBe(422)
  expect(await outstanding(page)).toBe("600.00")
  await noHorizontalScroll(page)
})

test("sin sesión no hay acceso a créditos", async ({ playwright }) => {
  requireE2EUsers()
  const anonymous = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  })
  for (const url of [
    "/api/credits",
    "/api/credits/summary",
    "/api/credits/payments",
    "/api/credits/administrative/custody",
  ])
    expect((await anonymous.get(url)).status()).toBe(401)
  await anonymous.dispose()
})
