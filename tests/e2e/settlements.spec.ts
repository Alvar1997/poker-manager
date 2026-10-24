import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 11 — liquidaciones desde la UI (Chrome + iPhone), con fixtures en
 * la base de PRUEBAS: compras reales (efectivo y a crédito con socio, firma
 * y entrega) → liquidar desde la mesa → valor nominal → decisión explícita
 * de compensar → firma táctil → recepción → pagos parciales, transferencia
 * en trámite y ejecutada → comprobante PNG.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let t25 = ""
const players: Record<
  "a" | "b" | "c",
  { id: string; name: string; participationId: string }
> = {
  a: { id: "", name: "", participationId: "" },
  b: { id: "", name: "", participationId: "" },
  c: { id: "", name: "", participationId: "" },
}

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const mxn = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n
  )
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

async function cashPurchase(
  page: Page,
  participationId: string,
  amount: string
) {
  const p = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId,
    nominalAmount: amount,
    idempotencyKey: randomUUID(),
  })
  await api(page, "post", `/api/purchases/${p.id}/payments`, {
    method: "CASH",
    amount,
    cashReceived: true,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/purchases/${p.id}`
  )
  await api(page, "post", `/api/purchases/${p.id}/confirm-delivery`, {
    expectedVersion: view.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: randomUUID(),
  })
}

async function creditPurchase(
  page: Page,
  participationId: string,
  amount: string
) {
  const p = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId,
    nominalAmount: amount,
    idempotencyKey: randomUUID(),
  })
  const partners = await api<{ id: string; name: string }[]>(
    page,
    "get",
    "/api/purchases/authorizers"
  )
  await api(page, "post", `/api/purchases/${p.id}/credit-authorization`, {
    partnerId: partners.find((x) => x.name === "Socio E2E")!.id,
    channel: "VERBAL",
    idempotencyKey: randomUUID(),
  })
  const prepared = await api<{
    summary: { snapshotId: string; payloadHash: string }
  }>(page, "post", `/api/purchases/${p.id}/signature-summary`)
  await api(page, "post", `/api/purchases/${p.id}/signatures`, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/purchases/${p.id}`
  )
  await api(page, "post", `/api/purchases/${p.id}/confirm-delivery`, {
    expectedVersion: view.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: randomUUID(),
  })
}

const outstanding = async (page: Page, playerId: string) =>
  (
    await api<{ outstanding: string }>(
      page,
      "get",
      `/api/credits/players/${playerId}`
    )
  ).outstanding

/** Firma con eventos de puntero táctiles (como un dedo en el celular del cajero). */
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
          pointerId: 9,
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

/** Pasos 1–6 en la UI: desde «Liquidar jugador» de la mesa hasta la firma. */
async function startFromTable(
  page: Page,
  who: (typeof players)["a"],
  returned: string,
  decision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM",
  offset?: string
) {
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: who.name })
    .getByTestId("settle-player")
    .click()
  await expect(page).toHaveURL(
    /\/dashboard\/liquidaciones\/nueva\?participationId=/
  )
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "context-player")).toContainText(who.name)
  const form = visible(page, "settlement-form")
  await form.getByTestId("returned-amount").fill(returned)
  await form.getByTestId(`offset-${decision}`).check()
  if (offset) await form.getByTestId("offset-amount").fill(offset)
  await expect(visible(page, "preview-net")).toBeVisible()
  await noHorizontalScroll(page)
  await visible(page, "settlement-submit").click()
  await expect(page).toHaveURL(
    /\/dashboard\/liquidaciones\/[A-Za-z0-9_-]+\/firma$/
  )
  await page.waitForLoadState("networkidle")
  return page.url().split("/").at(-2)!
}

async function signOnDevice(page: Page) {
  await expect(visible(page, "declaration")).toContainText(
    "corresponde al valor nominal de fichas indicado"
  )
  await visible(page, "summary-reviewed").check()
  await drawSignature(page)
  await visible(page, "signature-confirm").click()
  await expect(visible(page, "settlement-signature-registered")).toBeVisible()
}

test("prepara la sesión, la mesa y tres jugadores con compras reales", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request, { minNominal: 20_000 })).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${sessionId}/tables`
  )
  t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await api(page, "post", `/api/sessions/${sessionId}/tables/${t25}/open`, {
    idempotencyKey: randomUUID(),
  })
  const suffix = `${testInfo.project.name} ${Date.now() % 100000}`
  for (const k of ["a", "b", "c"] as const) {
    players[k].name = `Liquida ${k.toUpperCase()} ${suffix}`
    players[k].id = (await createE2EPlayer(page.request, players[k].name)).id
    players[k].participationId = (
      await api<{ id: string }>(
        page,
        "post",
        `/api/sessions/${sessionId}/tables/${t25}/players`,
        { playerId: players[k].id, idempotencyKey: randomUUID() }
      )
    ).id
  }
  await cashPurchase(page, players.a.participationId, "4000")
  await creditPurchase(page, players.a.participationId, "1000")
  await creditPurchase(page, players.b.participationId, "1000")
  await creditPurchase(page, players.b.participationId, "2000")
  expect(await outstanding(page, players.a.id)).toBe("1000.00")
  expect(await outstanding(page, players.b.id)).toBe("3000.00")
})

test("NO_COMPENSATE, firma, recepción con pago parcial y transferencia posterior hasta pagar todo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const id = await startFromTable(page, players.a, "5000", "NO_COMPENSATE")
  await expect(visible(page, "summary-debt")).toHaveText(mxn(1000))
  await expect(visible(page, "summary-offset")).toHaveText(mxn(0))
  await expect(visible(page, "summary-net")).toHaveText(mxn(5000))
  await signOnDevice(page)
  // Recepción + pago inmediato parcial en efectivo.
  const form = visible(page, "confirm-return-form")
  await form.getByTestId("chips-received").check()
  await form.getByTestId("pay-now").check()
  await form.getByTestId("immediate-cash").fill("2000")
  await form.getByTestId("cash-delivered").check()
  await visible(page, "confirm-return").click()
  await expect(page).toHaveURL(new RegExp(`/liquidaciones/${id}/pagos$`))
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "settlement-status")).toHaveText("Pago pendiente")
  await expect(visible(page, "payouts-paid")).toHaveText(mxn(2000))
  await expect(visible(page, "payouts-pending")).toHaveText(mxn(3000))
  // La deuda no compensada sigue vigente.
  expect(await outstanding(page, players.a.id)).toBe("1000.00")
  const s = await api<{ participationStatus: string }>(
    page,
    "get",
    `/api/settlements/${id}`
  )
  expect(s.participationStatus).toBe("SETTLING")
  // Sin compras durante SETTLING.
  const buy = await page.request.post("/api/purchases", {
    data: {
      participationId: players.a.participationId,
      nominalAmount: "500",
      idempotencyKey: randomUUID(),
    },
  })
  expect(buy.status()).toBe(422)
  // Transferencia posterior: en trámite no cuenta como pagada.
  const payout = visible(page, "payout-form")
  await payout.getByTestId("payout-method").selectOption("BANK_TRANSFER")
  await payout.getByTestId("payout-amount").fill("3000")
  await visible(page, "payout-submit").click()
  await expect(visible(page, "payouts-in-transit")).toHaveText(mxn(3000))
  await expect(visible(page, "payouts-paid")).toHaveText(mxn(2000))
  await expect(visible(page, "payouts-pending")).toHaveText(mxn(3000))
  await visible(page, "transfer-execute").click()
  await visible(page, "transfer-reference").fill(
    `SPEI-${randomUUID().slice(0, 8)}`
  )
  await visible(page, "transfer-verified").check()
  await visible(page, "transfer-resolve-submit").click()
  await expect(visible(page, "settlement-status")).toHaveText("Pagada")
  await expect(visible(page, "payouts-pending")).toHaveText(mxn(0))
  const done = await api<{ status: string; participationStatus: string }>(
    page,
    "get",
    `/api/settlements/${id}`
  )
  expect(done).toMatchObject({
    status: "COMPLETED",
    participationStatus: "SETTLED",
  })
  await noHorizontalScroll(page)
  // Comprobante de recepción + anexo, descarga PNG; sin PDF.
  await visible(page, "payouts-go-receipt").click()
  await expect(page).toHaveURL(new RegExp(`/liquidaciones/${id}/comprobante$`))
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "settlement-receipt-RECEPTION")).toContainText(
    "Pagado al emitir"
  )
  await expect(visible(page, "settlement-receipt-PAYOUT")).toHaveCount(1)
  const download = page.waitForEvent("download")
  await visible(page, "receipt-download").first().click()
  expect((await download).suggestedFilename()).toMatch(/^liquidacion-.*\.png$/)
  await expect(page.getByRole("button", { name: /pdf/i })).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("compensación parcial con FIFO automático descuenta la deuda más antigua", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const id = await startFromTable(page, players.b, "2500", "PARTIAL", "1500")
  await expect(visible(page, "fifo-row")).toHaveCount(2)
  await expect(visible(page, "summary-offset")).toHaveText(mxn(1500))
  await expect(visible(page, "summary-net")).toHaveText(mxn(1000))
  await signOnDevice(page)
  const form = visible(page, "confirm-return-form")
  await form.getByTestId("chips-received").check()
  await form.getByTestId("pay-now").check()
  await form.getByTestId("immediate-cash").fill("1000")
  await form.getByTestId("cash-delivered").check()
  await visible(page, "confirm-return").click()
  await expect(page).toHaveURL(new RegExp(`/liquidaciones/${id}/comprobante$`))
  expect(await outstanding(page, players.b.id)).toBe("1500.00")
  const s = await api<{ offsets: { amount: string }[]; status: string }>(
    page,
    "get",
    `/api/settlements/${id}`
  )
  expect(s.status).toBe("COMPLETED")
  expect(s.offsets.map((o) => o.amount)).toEqual(["1000.00", "500.00"])
})

test("devolución de $0: firma obligatoria y sin movimiento nominal de valor cero", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(
    `/dashboard/liquidaciones/nueva?participationId=${players.c.participationId}`
  )
  await page.waitForLoadState("networkidle")
  await visible(page, "returned-amount").fill("0")
  // Con $0 no se puede compensar.
  await expect(visible(page, "offset-PARTIAL")).toBeDisabled()
  await expect(visible(page, "offset-MAXIMUM")).toBeDisabled()
  await visible(page, "offset-NO_COMPENSATE").check()
  await expect(visible(page, "preview-net")).toHaveText(mxn(0))
  await visible(page, "settlement-submit").click()
  await expect(page).toHaveURL(/\/firma$/)
  const id = page.url().split("/").at(-2)!
  // La API no permite recibir sin firma.
  const noSig = await page.request.post(
    `/api/settlements/${id}/confirm-return`,
    {
      data: {
        expectedVersion: 1,
        chipsReceived: true,
        idempotencyKey: randomUUID(),
      },
    }
  )
  expect(noSig.status()).toBe(422)
  await page.waitForLoadState("networkidle")
  await signOnDevice(page)
  // Con $0 no hay «fichas recibidas»: el cajero confirma EXPRESAMENTE el cero.
  await expect(page.getByTestId("chips-received")).toHaveCount(0)
  await expect(visible(page, "confirm-return")).toBeDisabled()
  await visible(page, "zero-return-confirmed").check()
  await visible(page, "confirm-return").click()
  await expect(page).toHaveURL(new RegExp(`/liquidaciones/${id}/comprobante$`))
  const s = await api<{
    status: string
    chipReturnOperationId: string | null
    participationStatus: string
  }>(page, "get", `/api/settlements/${id}`)
  expect(s).toMatchObject({
    status: "COMPLETED",
    chipReturnOperationId: null,
    participationStatus: "SETTLED",
  })
  const moves = await api<{ items: { referenceId: string | null }[] }>(
    page,
    "get",
    "/api/chip-inventory/nominal-movements?pageSize=100"
  )
  expect(moves.items.some((m) => m.referenceId === id)).toBe(false)
  await noHorizontalScroll(page)
})

test("listado, pagos pendientes y menú en celular", async ({ page }) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/dashboard/liquidaciones")
  await page.waitForLoadState("networkidle")
  await expect(
    visible(page, "settlement-row").filter({ hasText: players.a.name })
  ).toContainText("Pagada")
  await noHorizontalScroll(page)
  await visible(page, "go-pending-payouts").click()
  await expect(page).toHaveURL(/\/liquidaciones\/pendientes$/)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "pending-total")).toBeVisible()
  await noHorizontalScroll(page)
})

test("sin sesión no hay acceso a liquidaciones", async ({ playwright }) => {
  requireE2EUsers()
  const anonymous = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  })
  for (const url of [
    "/api/settlements",
    "/api/settlements/pending-payouts",
    "/api/settlements/preview?participationId=x&returnedNominalAmount=0&offsetDecision=NO_COMPENSATE",
  ])
    expect((await anonymous.get(url)).status()).toBe(401)
  expect(
    (
      await anonymous.post("/api/settlements", {
        data: {},
        headers: { origin: test.info().project.use.baseURL! },
      })
    ).status()
  ).toBe(401)
  await anonymous.dispose()
})
