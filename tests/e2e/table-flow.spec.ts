import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Flujo de mesa (Chrome + iPhone), base de PRUEBAS: compra a CRÉDITO TOTAL
 * sin campos de efectivo → OUT (perdió todo) con firma y SIN pantalla de
 * «fichas recibidas» → la deuda sigue → en la otra mesa su primera compra es
 * COMPRA INICIAL → cashout con abono máximo a la deuda.
 */
test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)

const ctx = { sessionId: "", t25: "", t10: "", playerId: "", name: "" }
const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const mxn = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n
  )

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

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function gotoTable(page: Page, tableId: string) {
  const url = `/dashboard/sesiones/${ctx.sessionId}/mesas/${tableId}`
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url)
      break
    } catch (e) {
      if (attempt >= 3 || !String(e).includes("interrupted")) throw e
      await page.waitForLoadState("networkidle")
    }
  }
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("poker-table")).toBeVisible()
}

async function drawSignature(page: Page) {
  const canvas = visible(page, "signature-canvas")
  await canvas.scrollIntoViewIfNeeded()
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
}

async function seat(page: Page, tableId: string, seatNumber: number) {
  const r = await api<{ participationId: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${tableId}/seats/${seatNumber}/assign`,
    { playerId: ctx.playerId, idempotencyKey: randomUUID() }
  )
  return r.participationId
}

/** Compra a crédito total desde el asiento: socio, firma y entrega. */
async function creditBuy(page: Page, seatNumber: number, amount: string) {
  await page.getByTestId(`seat-${seatNumber}`).click()
  await visible(page, "seat-action-sheet").getByTestId("seat-buy").click()
  const sheet = visible(page, "quick-purchase-sheet")
  await sheet.getByTestId("quick-amount-custom").fill(amount)
  // Cambiar de método limpia lo incompatible; CRÉDITO no muestra efectivo.
  await sheet.getByTestId("quick-method-CASH").check()
  await sheet.getByTestId("quick-cash-received").check()
  await sheet.getByTestId("quick-method-CREDIT").check()
  await expect(sheet.getByTestId("quick-cash-received")).toHaveCount(0)
  await sheet.getByTestId("quick-purchase-continue").click()
  await expect(sheet.getByTestId("progress-mode")).toHaveText("Crédito total")
  await expect(sheet.getByTestId("toggle-add-payment")).toHaveCount(0)
  const auth = sheet.getByTestId("credit-auth-form")
  await auth.locator("#partnerId").selectOption({ label: "Socio E2E" })
  await auth.getByText("Verbal").click()
  await auth.getByTestId("save-credit-auth").click()
  await sheet.getByTestId("summary-reviewed").check()
  await drawSignature(page)
  await sheet.getByTestId("signature-confirm").click()
  await sheet.getByTestId("physical-delivery").check()
  await sheet.getByTestId("confirm-delivery").click()
  await expect(sheet.getByTestId("quick-purchase-done")).toBeVisible()
  await sheet.getByTestId("quick-purchase-close").click()
}

test("crédito total sin campos de efectivo y OUT con firma, sin «fichas recibidas»; la deuda sigue", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 20_000 })
  ).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/tables`
  )
  ctx.t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  ctx.t10 = tables.find((t) => t.name === "Mesa 10/10")!.tableId
  for (const t of [ctx.t25, ctx.t10])
    await api(page, "post", `/api/sessions/${ctx.sessionId}/tables/${t}/open`, {
      idempotencyKey: randomUUID(),
    })
  const p = await createE2EPlayer(
    page.request,
    `Juan Flujo ${randomUUID().slice(0, 5)}`
  )
  ctx.playerId = p.id
  ctx.name = p.name
  await seat(page, ctx.t25, 4)
  await gotoTable(page, ctx.t25)
  await creditBuy(page, 4, "2000")
  await expect(page.getByTestId("seat-4")).toHaveAttribute(
    "data-seat-state",
    "PLAYING"
  )

  // OUT
  await page.getByTestId("seat-4").click()
  await visible(page, "seat-action-sheet").getByTestId("seat-out").click()
  const out = visible(page, "out-sheet")
  await expect(out.getByTestId("out-debt")).toHaveText(mxn(2000))
  await expect(out.getByTestId("out-result")).toHaveText(mxn(-2000))
  await expect(out.getByTestId("out-continue")).toBeDisabled()
  await out.getByTestId("out-no-chips").check()
  await out.getByTestId("out-continue").click()
  await out.getByTestId("summary-reviewed").check()
  await drawSignature(page)
  await out.getByTestId("signature-confirm").click()
  await expect(out.getByTestId("out-confirm-step")).toBeVisible()
  await expect(out.getByTestId("chips-received")).toHaveCount(0)
  await noHorizontalScroll(page)
  await out.getByTestId("out-confirm").click()
  await expect(out.getByTestId("quick-settlement-done")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("seat-4")).toHaveAttribute(
    "data-seat-state",
    "FREE"
  )
  const credit = await api<{ outstanding: string }>(
    page,
    "get",
    `/api/credits/players/${ctx.playerId}`
  )
  expect(credit.outstanding).toBe("2000.00")
})

test("en la OTRA mesa su primera compra es COMPRA INICIAL; cashout con abono máximo a la deuda", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const pid = await seat(page, ctx.t10, 2)
  await gotoTable(page, ctx.t10)
  await page.getByTestId("seat-2").click()
  await expect(
    visible(page, "seat-action-sheet").getByTestId("seat-buy")
  ).toHaveText(/Compra inicial/)
  await page.keyboard.press("Escape")
  await creditBuy(page, 2, "1000")
  // Devuelve 1,600 con deuda total 3,000: abono máximo 1,600 → pago $0.
  await page.goto(`/dashboard/liquidaciones/nueva?participationId=${pid}`)
  await page.waitForLoadState("networkidle")
  await visible(page, "returned-amount").fill("1600")
  await visible(page, "offset-MAXIMUM").check()
  await visible(page, "settlement-submit").click()
  await expect(page).toHaveURL(/\/firma$/)
  await expect(visible(page, "summary-offset")).toHaveText(mxn(1600))
  await expect(visible(page, "summary-net")).toHaveText(mxn(0))
  await noHorizontalScroll(page)
  const credit = await api<{ outstanding: string }>(
    page,
    "get",
    `/api/credits/players/${ctx.playerId}`
  )
  // Hasta confirmar la recepción la deuda no cambia.
  expect(credit.outstanding).toBe("3000.00")
})
