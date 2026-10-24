import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { login, logout, requireE2EUsers } from "./helpers"
import {
  createE2EPlayer,
  openSessionViaApi,
  simulatePhysicalCount,
} from "./session-fixtures"

/**
 * Conciliación GLOBAL de fichas (Chrome + iPhone), base de PRUEBAS. Nadie se
 * lleva fichas: Juan pierde 3,000 y Pedro los gana → sin alerta de fichas
 * pendientes; retorno cero explícito; y una diferencia REAL que bloquea el
 * cierre hasta que un socio la concilia.
 */
test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const mxn = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n
  )

const ctx = { sessionId: "", t25: "", t10: "" }

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

async function openNight(page: Page) {
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 30_000 })
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
}

async function player(page: Page, name: string, tableId = ctx.t25) {
  const p = await createE2EPlayer(
    page.request,
    `${name} ${randomUUID().slice(0, 5)}`
  )
  const part = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${tableId}/players`,
    {
      playerId: p.id,
      idempotencyKey: randomUUID(),
    }
  )
  return { id: p.id, name: p.name, participationId: part.id }
}

async function cashBuy(page: Page, participationId: string, amount: string) {
  const purchase = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId,
    nominalAmount: amount,
    idempotencyKey: randomUUID(),
  })
  await api(page, "post", `/api/purchases/${purchase.id}/payments`, {
    method: "CASH",
    amount,
    cashReceived: true,
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

async function signOnDevice(page: Page) {
  await visible(page, "summary-reviewed").check()
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
  await visible(page, "signature-confirm").click()
  await expect(visible(page, "settlement-signature-registered")).toBeVisible()
}

/** Liquidación en pantalla: devolución, resultado individual, firma y recepción. */
async function settleInUi(
  page: Page,
  participationId: string,
  returned: string,
  expectedResult: string
) {
  await page.goto(
    `/dashboard/liquidaciones/nueva?participationId=${participationId}`
  )
  await page.waitForLoadState("networkidle")
  await visible(page, "returned-amount").fill(returned)
  await expect(visible(page, "individual-result")).toContainText(expectedResult)
  await visible(page, "offset-NO_COMPENSATE").check()
  await visible(page, "settlement-submit").click()
  await expect(page).toHaveURL(/\/firma$/)
  await page.waitForLoadState("networkidle")
  await signOnDevice(page)
  if (Number(returned) === 0) {
    await expect(page.getByTestId("chips-received")).toHaveCount(0)
    await expect(visible(page, "confirm-return")).toBeDisabled()
    await visible(page, "zero-return-confirmed").check()
  } else await visible(page, "chips-received").check()
  await visible(page, "confirm-return").click()
  await expect(page).toHaveURL(/\/(comprobante|pagos)$/)
}

async function closeTablesAndStart(page: Page) {
  for (const t of [ctx.t25, ctx.t10])
    await api(
      page,
      "post",
      `/api/sessions/${ctx.sessionId}/tables/${t}/close`,
      { idempotencyKey: randomUUID() }
    )
}

async function countAtClose(page: Page, shortBy = 0) {
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/inventario`)
  await page.waitForLoadState("networkidle")
  const start = visible(page, "closure-count-start")
  if (await start.isVisible()) {
    await start.click()
    await expect(visible(page, "count-lines")).toBeVisible()
  }
  const inv = await api<{ count: { id: string } }>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/closure/inventory`
  )
  const count = await api<{
    expectedTotal: string
    details: {
      denominationId: string
      unitValue: string
      expectedQuantity: number
    }[]
  }>(page, "get", `/api/chip-inventory/counts/${inv.count.id}`)
  const lines = simulatePhysicalCount(
    count.details,
    Number(count.expectedTotal) - shortBy
  )
  await page.request.patch(`/api/chip-inventory/counts/${inv.count.id}`, {
    data: { lines },
  })
  await api(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/closure/inventory-count`,
    {
      action: "confirm",
      countId: inv.count.id,
      idempotencyKey: randomUUID(),
    }
  )
}

test("Juan pierde 3,000 y Pedro los gana; un tercero devuelve $0 explícito: fichas conciliadas, sin alerta falsa", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await openNight(page)
  const juan = await player(page, "Juan")
  const pedro = await player(page, "Pedro", ctx.t10)
  const ana = await player(page, "Ana")
  await cashBuy(page, juan.participationId, "5000")
  await cashBuy(page, pedro.participationId, "5000")
  await cashBuy(page, ana.participationId, "2000")
  await settleInUi(page, juan.participationId, "2000", mxn(-3000))
  await settleInUi(page, pedro.participationId, "10000", mxn(5000))
  await settleInUi(page, ana.participationId, "0", mxn(-2000))
  await closeTablesAndStart(page)
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/prevalidacion`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "finding-CHIPS_RECONCILED")).toHaveAttribute(
    "data-severity",
    "INFO"
  )
  await expect(
    page.getByTestId("finding-SESSION_NOMINAL_DIFFERENCE")
  ).toHaveCount(0)
  await expect(page.getByText("Fichas no retornadas en la sesión")).toHaveCount(
    0
  )
  await expect(visible(page, "finding-PAYABLES_PENDING")).toHaveAttribute(
    "data-severity",
    "WARNING"
  )
  await noHorizontalScroll(page)
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/pendientes`)
  await expect(visible(page, "pending-chips-session")).toHaveText(mxn(0))
  await expect(
    page.getByText("Resultado individual por jugador").filter({ visible: true })
  ).toBeVisible()
  await noHorizontalScroll(page)
})

test("diferencia REAL (todos terminaron y faltan 2,000): bloquea; el cajero no concilia; el socio documenta y autoriza", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await openNight(page)
  const solo = await player(page, "Solo")
  await cashBuy(page, solo.participationId, "5000")
  await settleInUi(page, solo.participationId, "3000", mxn(-2000))
  await closeTablesAndStart(page)
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/prevalidacion`)
  await expect(
    visible(page, "finding-SESSION_NOMINAL_DIFFERENCE")
  ).toHaveAttribute("data-severity", "WARNING")
  await api(page, "post", `/api/sessions/${ctx.sessionId}/closure/start`, {
    idempotencyKey: randomUUID(),
  })
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/prevalidacion`)
  await expect(
    visible(page, "finding-SESSION_NOMINAL_DIFFERENCE")
  ).toHaveAttribute("data-severity", "BLOCKING")
  await countAtClose(page)
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/diferencias`)
  await expect(visible(page, "nominal-reconciliation")).toHaveAttribute(
    "data-status",
    "UNEXPLAINED_DIFFERENCE"
  )
  await expect(visible(page, "nominal-difference")).toHaveText(mxn(2000))
  await expect(visible(page, "nominal-needs-partner")).toBeVisible()
  await expect(page.getByTestId("chip-reconciliation-form")).toHaveCount(0)
  const denied = await page.request.post(
    `/api/sessions/${ctx.sessionId}/closure/chip-reconciliation`,
    {
      data: {
        kind: "UNRECOVERED_AUTHORIZED",
        reason: "Intento de un cajero sin permiso",
        idempotencyKey: randomUUID(),
      },
    }
  )
  expect(denied.status()).toBe(403)
  await noHorizontalScroll(page)
  await logout(page)
  await login(page, users.partner)
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/diferencias`)
  await page.waitForLoadState("networkidle")
  // El arqueo no encontró fichas de más: no se puede «identificar» un retorno.
  await expect(visible(page, "chip-rec-identified")).toBeDisabled()
  await visible(page, "chip-rec-unrecovered").check()
  await visible(page, "chip-rec-reason").fill(
    "Fichas no localizadas tras revisar la mesa con el cajero"
  )
  await visible(page, "chip-rec-submit").click()
  await expect(visible(page, "nominal-reconciliation")).toHaveAttribute(
    "data-status",
    "RECONCILED"
  )
  await page.goto(`/dashboard/sesiones/${ctx.sessionId}/cierre/prevalidacion`)
  await expect(
    page.getByTestId("finding-SESSION_NOMINAL_DIFFERENCE")
  ).toHaveCount(0)
  await expect(visible(page, "finding-CHIPS_RECONCILED")).toBeVisible()
  await noHorizontalScroll(page)
})
