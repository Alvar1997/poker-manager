import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"
import ExcelJS from "exceljs"

import { login, logout, requireE2EUsers } from "./helpers"
import {
  countPendingRakeAsZero,
  createE2EPlayer,
  openSessionViaApi,
  simulatePhysicalCount,
} from "./session-fixtures"

/**
 * Módulo 14 — reportes desde la UI (Chrome + iPhone) sobre operaciones
 * REALES en la base de PRUEBAS:
 *   Sesión A (cerrada y autorizada por el socio): compra a crédito $3,000 y
 *   recompra a crédito $2,000; abono general de $2,000 (FIFO → A).
 *   Sesión B (abierta): compra a crédito $6,000.
 *   Juan debe $9,000 (A $3,000 + B $6,000). Desde el Módulo 10 se registra
 *   un abono de $4,000 → FIFO: A queda en $0 y B en $5,000.
 */
test.describe.configure({ mode: "serial" })

const juan = { id: "", name: "" }
const folios = { a: "", b: "" }

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
  method: "get" | "post" | "patch",
  url: string,
  data?: unknown
) {
  const res =
    method === "get"
      ? await page.request.get(url)
      : method === "patch"
        ? await page.request.patch(url, { data })
        : await page.request.post(url, { data })
  const body = await res.json()
  expect(res.ok(), JSON.stringify(body)).toBeTruthy()
  return body.data as T
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

async function settleZero(page: Page, participationId: string) {
  const created = await api<{ id: string }>(page, "post", "/api/settlements", {
    participationId,
    returnedNominalAmount: "0",
    offsetDecision: "NO_COMPENSATE",
    idempotencyKey: randomUUID(),
  })
  const prepared = await api<{
    summary: { snapshotId: string; payloadHash: string }
  }>(page, "post", `/api/settlements/${created.id}/signature-summary`)
  await api(page, "post", `/api/settlements/${created.id}/signatures`, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/settlements/${created.id}`
  )
  await api(page, "post", `/api/settlements/${created.id}/confirm-return`, {
    expectedVersion: view.version,
    chipsReceived: true,
    zeroReturnConfirmed: true,
    idempotencyKey: randomUUID(),
  })
}

async function tableId(page: Page, sessionId: string, name: string) {
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${sessionId}/tables`
  )
  return tables.find((t) => t.name === name)!.tableId
}

async function seat(page: Page, sessionId: string, table: string) {
  await api(page, "post", `/api/sessions/${sessionId}/tables/${table}/open`, {
    idempotencyKey: randomUUID(),
  })
  return (
    await api<{ id: string }>(
      page,
      "post",
      `/api/sessions/${sessionId}/tables/${table}/players`,
      { playerId: juan.id, idempotencyKey: randomUUID() }
    )
  ).id
}

/** Cierre real por API: el cajero prepara (arqueos) y el socio confirma. */
async function closeSessionViaApi(
  page: Page,
  sessionId: string,
  table: string
) {
  await api(page, "post", `/api/sessions/${sessionId}/tables/${table}/close`, {
    idempotencyKey: randomUUID(),
  })
  await countPendingRakeAsZero(page.request, sessionId)
  await api(page, "post", `/api/sessions/${sessionId}/closure/start`, {
    idempotencyKey: randomUUID(),
  })
  const started = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${sessionId}/closure/inventory-count`,
    { action: "start" }
  )
  const count = await api<{
    id: string
    expectedTotal: string
    details: {
      denominationId: string
      unitValue: string
      expectedQuantity: number
    }[]
  }>(page, "get", `/api/chip-inventory/counts/${started.id}`)
  await api(page, "patch", `/api/chip-inventory/counts/${count.id}`, {
    lines: simulatePhysicalCount(count.details, Number(count.expectedTotal)),
  })
  await api(
    page,
    "post",
    `/api/sessions/${sessionId}/closure/inventory-count`,
    {
      action: "confirm",
      countId: count.id,
      idempotencyKey: randomUUID(),
    }
  )
  await api(page, "post", `/api/sessions/${sessionId}/closure/cash-count`, {
    countedAmount: "0",
    physicallyCounted: true,
  })
  const users = requireE2EUsers()
  await logout(page)
  await login(page, users.partner)
  // Escenario con fichas no devueltas a propósito: la conciliación global
  // exige que el socio documente y autorice la diferencia antes de cerrar.
  const outstanding = await api<{ reconciliation: { status: string } }>(
    page,
    "get",
    `/api/sessions/${sessionId}/closure/outstanding-chips`
  )
  if (outstanding.reconciliation.status === "UNEXPLAINED_DIFFERENCE")
    await api(
      page,
      "post",
      `/api/sessions/${sessionId}/closure/chip-reconciliation`,
      {
        kind: "UNRECOVERED_AUTHORIZED",
        reason: "Escenario de prueba: fichas no devueltas documentadas",
        idempotencyKey: randomUUID(),
      }
    )
  const preview = await api<{ previewHash: string }>(
    page,
    "get",
    `/api/sessions/${sessionId}/closure/preview`
  )
  await api(page, "post", `/api/sessions/${sessionId}/closure/confirm`, {
    idempotencyKey: randomUUID(),
    previewHash: preview.previewHash,
  })
  await logout(page)
  await login(page, users.cashier)
}

const playerReport = () => `/dashboard/reportes/creditos/${juan.id}`

async function expandSession(page: Page, folio: string) {
  const s = visible(page, `credit-session-${folio}`)
  await s.locator("summary").first().click()
  await expect(s).toHaveAttribute("open", "")
  return s
}

test("prepara dos sesiones reales con créditos y un abono previo", async ({
  page,
}, testInfo: TestInfo) => {
  test.setTimeout(180_000)
  const users = requireE2EUsers()
  await login(page, users.cashier)
  juan.name = `Juan Pérez ${testInfo.project.name} ${Date.now() % 100000}`
  juan.id = (await createE2EPlayer(page.request, juan.name)).id

  // Sesión A: compra $3,000 + recompra $2,000 a crédito; liquidación $0; cierre.
  const a = await openSessionViaApi(page.request, { minNominal: 20_000 })
  folios.a = a.folio
  const t10 = await tableId(page, a.id, "Mesa 10/10")
  const pa = await seat(page, a.id, t10)
  await creditPurchase(page, pa, "3000")
  await creditPurchase(page, pa, "2000")
  await settleZero(page, pa)
  await closeSessionViaApi(page, a.id, t10)

  // Abono general previo de $2,000 (fuera de sesión).
  await api(page, "post", "/api/credits/payments", {
    playerId: juan.id,
    amount: "2000",
    origin: "ADMINISTRATIVE",
    method: "CASH",
    cashReceived: true,
    idempotencyKey: randomUUID(),
  })

  // Sesión B (queda abierta): compra $6,000 a crédito.
  const b = await openSessionViaApi(page.request, { minNominal: 10_000 })
  folios.b = b.folio
  const t25 = await tableId(page, b.id, "Mesa 25/25")
  const pb = await seat(page, b.id, t25)
  await creditPurchase(page, pb, "6000")
})

test("CASHIER: dashboard, créditos, jugador y desglose por sesión y compra", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/dashboard/reportes")
  await expect(visible(page, "kpi-session-value")).toHaveText(folios.b)
  await expect(visible(page, "kpi-receivables")).toContainText(
    "Global, a la fecha"
  )
  await expect(visible(page, "dashboard-updated-at")).toBeVisible()
  await noHorizontalScroll(page)

  await visible(page, "report-tab-creditos").click()
  await expect(page).toHaveURL(/\/dashboard\/reportes\/creditos$/)
  await visible(page, "toggle-filters").click()
  await visible(page, "filter-playerId").selectOption(juan.id)
  await visible(page, "apply-filters").click()
  await expect(page).toHaveURL(new RegExp(`playerId=${juan.id}`))
  await expect(visible(page, "credits-global-balance")).toHaveText(mxn(9000))
  await noHorizontalScroll(page)
  await visible(page, "credit-player-link").click()
  await expect(page).toHaveURL(new RegExp(`/creditos/${juan.id}`))
  await expect(visible(page, "report-player-name")).toHaveText(juan.name)
  await expect(visible(page, "report-player-balance")).toHaveText(mxn(9000))
  await expect(visible(page, "report-player-sessions-with-balance")).toHaveText(
    "2"
  )

  // Sesión A (cerrada): crédito $5,000, abonos $2,000, debe $3,000.
  const sa = await expandSession(page, folios.a)
  await expect(visible(page, `credit-session-${folios.a}-original`)).toHaveText(
    mxn(5000)
  )
  await expect(visible(page, `credit-session-${folios.a}-paid`)).toHaveText(
    mxn(2000)
  )
  await expect(visible(page, `credit-session-${folios.a}-balance`)).toHaveText(
    mxn(3000)
  )
  // Deuda al cierre (histórica) vs. deuda actual.
  await expect(
    visible(page, `credit-session-${folios.a}-at-closure`)
  ).toHaveText(mxn(5000))
  await expect(visible(page, `credit-session-${folios.a}-current`)).toHaveText(
    mxn(3000)
  )
  // Compra inicial ($1,000 pendientes) y recompra #1 ($2,000 pendientes).
  const debts = sa.locator(
    '[data-testid^="credit-debt-"][data-testid$="-balance"]'
  )
  await expect(debts).toHaveText([mxn(1000), mxn(2000)])
  await expect(sa).toContainText("Compra inicial")
  await expect(sa).toContainText("Recompra #1")

  // Sesión B (abierta): $6,000, sin deuda histórica al cierre.
  const sb = await expandSession(page, folios.b)
  await expect(visible(page, `credit-session-${folios.b}-balance`)).toHaveText(
    mxn(6000)
  )
  await expect(sb).toContainText("aún no cerrada")
  await noHorizontalScroll(page)
})

test("registra un abono en el Módulo 10 y el reporte refleja FIFO al volver", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(playerReport())
  await visible(page, "report-register-payment").click()
  await expect(page).toHaveURL(/\/dashboard\/creditos\/abonos\/nuevo/)
  await page.waitForLoadState("networkidle")
  const form = visible(page, "credit-payment-form")
  await form.getByLabel("Importe del abono").fill("4000")
  await form.getByLabel("Dónde se recibe").selectOption("ADMINISTRATIVE")
  await form.getByLabel("Método").selectOption("CASH")
  await form.getByTestId("credit-cash-received").check()
  await expect(visible(page, "fifo-preview")).toContainText("resta")
  await visible(page, "submit-credit-payment").click()
  await expect(page).toHaveURL(/\/dashboard\/creditos\/abonos\/[A-Za-z0-9_-]+$/)

  await page.goto(playerReport())
  await expect(visible(page, "report-player-balance")).toHaveText(mxn(5000))
  await expandSession(page, folios.a)
  await expect(visible(page, `credit-session-${folios.a}-balance`)).toHaveText(
    mxn(0)
  )
  await expect(
    visible(page, `credit-session-${folios.a}-at-closure`)
  ).toHaveText(mxn(5000))
  await expandSession(page, folios.b)
  await expect(visible(page, `credit-session-${folios.b}-balance`)).toHaveText(
    mxn(5000)
  )
})

test("descarga el XLSX de créditos y su contenido coincide con la pantalla", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(playerReport())
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    visible(page, "export-xlsx").click(),
  ])
  expect(download.suggestedFilename()).toBe("PokerManager_Creditos.xlsx")
  const path = await download.path()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path!)
  expect(wb.worksheets.map((w) => w.name)).toEqual([
    "Resumen global",
    "Deudas por jugador",
    "Deudas por sesión",
    "Detalle de compras",
    "Aplicaciones de abonos",
    "Filtros y fecha",
  ])
  const ws = wb.getWorksheet("Deudas por sesión")!
  const header = (ws.getRow(1).values as unknown[]).slice(1)
  const col = (h: string) => header.indexOf(h) + 1
  const bySession = new Map(
    [2, 3].map((r) => [
      String(ws.getRow(r).getCell(col("Sesión")).value),
      ws.getRow(r),
    ])
  )
  expect(bySession.get(folios.a)!.getCell(col("Saldo actual")).value).toBe(0)
  expect(
    bySession.get(folios.a)!.getCell(col("Deuda registrada al cierre")).value
  ).toBe(5000)
  expect(bySession.get(folios.b)!.getCell(col("Saldo actual")).value).toBe(5000)
  const players = wb.getWorksheet("Deudas por jugador")!
  expect(players.getRow(2).getCell(1).value).toBe(juan.name)
  expect(players.getRow(2).getCell(6).value).toBe(5000)
})

test("los filtros persisten al ir al detalle, volver y cambiar de reporte", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(
    `/dashboard/reportes/creditos?playerId=${juan.id}&status=PARTIALLY_PAID`
  )
  await expect(visible(page, "credits-global-balance")).toHaveText(mxn(5000))
  await visible(page, "credit-player-link").click()
  await page.getByRole("link", { name: "Reporte de créditos" }).click()
  await expect(page).toHaveURL(new RegExp(`playerId=${juan.id}`))
  await expect(page).toHaveURL(/status=PARTIALLY_PAID/)
  // Cambiar de reporte y regresar por la pestaña: se restauran.
  await visible(page, "report-tab-sesiones").click()
  await expect(page).toHaveURL(/\/reportes\/sesiones/)
  await visible(page, "report-tab-creditos").click()
  await expect(page).toHaveURL(new RegExp(`playerId=${juan.id}`))
  await expect(visible(page, "credits-global-balance")).toHaveText(mxn(5000))
  await visible(page, "clear-filters").click()
  await expect(page).toHaveURL(/\/dashboard\/reportes\/creditos$/)
})

test("PARTNER y SUPERADMIN consultan los reportes; sin sesión no hay acceso", async ({
  page,
  playwright,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto(playerReport())
  await expect(visible(page, "report-player-balance")).toHaveText(mxn(5000))
  await page.goto("/dashboard/reportes/sesiones")
  await expect(visible(page, `session-row-${folios.a}`)).toBeVisible()
  await logout(page)

  await login(page, users.superadmin)
  await page.goto("/dashboard/reportes/finanzas")
  await expect(visible(page, "fin-receivables")).toBeVisible()
  await expect(visible(page, "fin-payables")).toBeVisible()
  await expect(
    page.getByText("utilidad neta", { exact: false }).first()
  ).toContainText("No se calcula utilidad neta")
  await page.goto("/dashboard/reportes/comparativos")
  await expect(visible(page, "comparison-charts")).toBeVisible()
  await page.goto("/dashboard/reportes/fichas")
  await expect(visible(page, "chips-circulation")).toBeVisible()
  await noHorizontalScroll(page)

  const anonymous = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  })
  for (const url of [
    "/api/reports/dashboard",
    "/api/reports/credits",
    "/api/reports/export/xlsx?report=credits",
  ])
    expect((await anonymous.get(url)).status()).toBe(401)
  await anonymous.dispose()
})
