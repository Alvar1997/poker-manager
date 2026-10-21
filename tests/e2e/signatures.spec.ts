import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 09 — firma REAL dibujada en el canvas del dispositivo del cajero,
 * confirmación de entrega por el cajero después de firmar y comprobante
 * digital descargable en PNG. Sesión real abierta por API (solo base de
 * pruebas). No se simula ninguna firma.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let t25 = ""
let playerName = ""

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
) {
  const res =
    method === "get"
      ? await page.request.get(url)
      : await page.request.post(url, { data })
  const body = await res.json()
  expect(res.ok(), JSON.stringify(body)).toBeTruthy()
  return body.data as T
}

/** Dibuja una firma (onda + rúbrica) con el puntero sobre el canvas. */
async function drawSignature(page: Page) {
  const canvas = visible(page, "signature-canvas")
  await canvas.scrollIntoViewIfNeeded()
  const box = (await canvas.boundingBox())!
  const at = (fx: number, fy: number) =>
    [box.x + box.width * fx, box.y + box.height * fy] as const
  await page.mouse.move(...at(0.1, 0.5))
  await page.mouse.down()
  for (let i = 1; i <= 30; i++)
    await page.mouse.move(...at(0.1 + i * 0.026, 0.5 + 0.3 * Math.sin(i / 3)))
  await page.mouse.up()
  await page.mouse.move(...at(0.15, 0.88))
  await page.mouse.down()
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(...at(0.15 + i * 0.06, 0.88))
  await page.mouse.up()
}

/**
 * Firma con eventos de puntero TÁCTILES (pointerType "touch"), como un dedo
 * en el teléfono. Verifica además que la página no se desplace al firmar.
 */
async function drawSignatureTouch(page: Page) {
  const canvas = visible(page, "signature-canvas")
  await canvas.scrollIntoViewIfNeeded()
  const before = await page.evaluate(() => window.scrollY)
  await canvas.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const fire = (type: string, fx: number, fy: number) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: r.left + r.width * fx,
          clientY: r.top + r.height * fy,
        })
      )
    fire("pointerdown", 0.1, 0.5)
    for (let i = 1; i <= 30; i++)
      fire("pointermove", 0.1 + i * 0.026, 0.5 + 0.3 * Math.sin(i / 3))
    fire("pointerup", 0.88, 0.5)
    fire("pointerdown", 0.15, 0.88)
    for (let i = 1; i <= 12; i++) fire("pointermove", 0.15 + i * 0.06, 0.88)
    fire("pointerup", 0.87, 0.88)
  })
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
}

/** Compra desde la mesa: importe, efectivo opcional y socio VERBAL. */
async function creditPurchase(page: Page, amount: string, cash: string | null) {
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: playerName })
    .getByTestId("new-purchase-for-player")
    .click()
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Importe solicitado").fill(amount)
  await visible(page, "create-purchase").click()
  await expect(page).toHaveURL(/\/dashboard\/compras\/[A-Za-z0-9_-]+$/)
  await page.waitForLoadState("networkidle")
  if (cash) {
    const form = visible(page, "add-payment-form")
    await form.getByLabel("Importe de este pago").fill(cash)
    await form.getByTestId("cash-received").check()
    await form.getByTestId("add-payment").click()
    await expect(page.getByText("Pago registrado").first()).toBeVisible()
    await page.waitForLoadState("networkidle")
  }
  const auth = visible(page, "credit-auth-form")
  await auth
    .getByLabel("Socio que autorizó")
    .selectOption({ label: "Socio E2E" })
  await auth.getByLabel("Verbal").check()
  await auth.getByTestId("save-credit-auth").click()
  await expect(visible(page, "credit-authorizer")).toContainText("Socio E2E")
  return page.url().split("/").pop()!
}

test("prepara sesión, mesa 25/25 y un jugador", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request, { minNominal: 20_000 })).id
  playerName = `Jugador Firma ${testInfo.project.name} ${Date.now() % 100000}`
  const player = await createE2EPlayer(page.request, playerName)
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${sessionId}/tables`
  )
  t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await api(page, "post", `/api/sessions/${sessionId}/tables/${t25}/open`, {
    idempotencyKey: randomUUID(),
  })
  await api(page, "post", `/api/sessions/${sessionId}/tables/${t25}/players`, {
    playerId: player.id,
    idempotencyKey: randomUUID(),
  })
})

test("compra a crédito: resumen del servidor, firma con el dedo, entrega por el cajero y comprobante PNG", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const id = await creditPurchase(page, "5000", "1000")
  await expect(visible(page, "signature-required")).toBeVisible()
  await expect(visible(page, "confirm-delivery")).toBeDisabled()
  await visible(page, "go-sign").click()
  await expect(page).toHaveURL(new RegExp(`/compras/${id}/firma$`))
  await page.waitForLoadState("networkidle")

  // Resumen preparado por el servidor (sin denominaciones).
  await expect(visible(page, "summary-player")).toHaveText(playerName)
  await expect(visible(page, "summary-amount")).toContainText("5,000.00")
  await expect(visible(page, "summary-credit")).toContainText("4,000.00")
  await expect(visible(page, "summary-partner")).toContainText("Socio E2E")
  await expect(visible(page, "summary-kind")).toHaveText("Compra inicial")
  await expect(visible(page, "declaration")).toContainText(
    "Reconozco haber solicitado"
  )
  await expect(page.getByText(/denominaci/i)).toHaveCount(0)
  await noHorizontalScroll(page)

  // Sin revisar el resumen no se puede confirmar; Borrar limpia el trazo.
  await expect(visible(page, "signature-confirm")).toBeDisabled()
  await visible(page, "summary-reviewed").check()
  await drawSignature(page)
  await visible(page, "signature-clear").click()
  await expect(visible(page, "signature-confirm")).toBeDisabled()
  await drawSignature(page)
  await visible(page, "signature-confirm").click()
  await expect(visible(page, "signature-registered")).toBeVisible()

  // Firmar NO entregó nada todavía.
  const draft = await api<{ status: string; signature: { present: boolean } }>(
    page,
    "get",
    `/api/purchases/${id}`
  )
  expect(draft.status).toBe("DRAFT")
  expect(draft.signature.present).toBe(true)
  expect(
    (await page.request.get(`/api/purchases/${id}/receipt`)).status()
  ).toBe(422)

  // El cajero confirma la entrega DESPUÉS.
  await visible(page, "physical-delivery").check()
  await visible(page, "confirm-delivery").click()
  await expect(visible(page, "signature-delivered")).toBeVisible()
  const confirmed = await api<{ status: string; purchaseType: string }>(
    page,
    "get",
    `/api/purchases/${id}`
  )
  expect(confirmed).toMatchObject({
    status: "CONFIRMED",
    purchaseType: "INITIAL_PURCHASE",
  })

  // Comprobante digital: datos, firma y descarga PNG (sin PDF).
  await visible(page, "go-receipt").click()
  await expect(page).toHaveURL(new RegExp(`/compras/${id}/comprobante$`))
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "receipt-status")).toHaveText("Entregado")
  await expect(visible(page, "receipt")).toContainText("Crédito inicial")
  await expect(visible(page, "receipt")).toContainText("4,000.00")
  await expect(visible(page, "receipt-signature")).toBeVisible()
  await expect(page.getByRole("button", { name: /pdf/i })).toHaveCount(0)
  const download = page.waitForEvent("download")
  await visible(page, "receipt-download").click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^comprobante-.*\.png$/)
  const res = await page.request.get(`/api/purchases/${id}/receipt/image`)
  expect(res.headers()["content-type"]).toBe("image/png")
  expect((await res.body()).subarray(1, 4).toString()).toBe("PNG")
  await noHorizontalScroll(page)
})

test("una recompra con crédito exige su propia firma; cambiar el importe después de firmar la invalida", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const id = await creditPurchase(page, "2000", null)
  // No hereda la firma de la compra anterior.
  await expect(visible(page, "signature-required")).toBeVisible()
  await expect(visible(page, "delivery-blockers")).toContainText(/firma/i)
  await visible(page, "go-sign").click()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "summary-kind")).toHaveText("Recompra 1")
  await visible(page, "summary-reviewed").check()
  await drawSignatureTouch(page)
  await visible(page, "signature-confirm").click()
  await expect(visible(page, "signature-registered")).toBeVisible()

  // Cambio de importe antes de entregar: la firma queda invalidada.
  await page.goto(`/dashboard/compras/${id}`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "signature-present")).toBeVisible()
  await visible(page, "edit-amount").click()
  await page.getByLabel("Nuevo importe").fill("2500")
  await page
    .getByRole("button", { name: "Guardar" })
    .filter({ visible: true })
    .click()
  await expect(page.getByText("Importe actualizado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "signature-history")).toContainText("Invalidada")
  await expect(visible(page, "signature-present")).toHaveCount(0)
  const status = await api<{ history: { status: string }[] }>(
    page,
    "get",
    `/api/purchases/${id}/signatures/status`
  )
  expect(status.history.map((h) => h.status)).toEqual(["INVALIDATED"])
  await noHorizontalScroll(page)
})

test("una compra totalmente pagada se entrega sin firma y tiene comprobante", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: playerName })
    .getByTestId("new-purchase-for-player")
    .click()
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Importe solicitado").fill("1000")
  await visible(page, "create-purchase").click()
  await expect(page).toHaveURL(/\/dashboard\/compras\/[A-Za-z0-9_-]+$/)
  await page.waitForLoadState("networkidle")
  const form = visible(page, "add-payment-form")
  await form.getByLabel("Importe de este pago").fill("1000")
  await form.getByTestId("cash-received").check()
  await form.getByTestId("add-payment").click()
  await expect(page.getByText("Pago registrado").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "signature-step")).toHaveCount(0)
  await visible(page, "physical-delivery").check()
  await visible(page, "confirm-delivery").click()
  await expect(visible(page, "purchase-status")).toHaveText("Entregada")
  await visible(page, "go-receipt").click()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "receipt")).toContainText("No requerida (pagada)")
  await expect(visible(page, "receipt-signature")).toHaveCount(0)
})

test("sin sesión no hay acceso a firmas ni comprobantes", async ({
  playwright,
}) => {
  requireE2EUsers()
  const anonymous = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  })
  for (const url of [
    "/api/purchases/x/signature-evidence",
    "/api/purchases/x/receipt",
    "/api/purchases/x/receipt/image",
    "/api/purchases/x/signature-summary",
  ])
    expect((await anonymous.get(url)).status()).toBe(401)
  await anonymous.dispose()
})
