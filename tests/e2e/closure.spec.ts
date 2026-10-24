import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, logout, requireE2EUsers } from "./helpers"
import {
  createE2EPlayer,
  openSessionViaApi,
  simulatePhysicalCount,
} from "./session-fixtures"

/**
 * Módulo 12 — cierre de mesas y sesión desde la UI (Chrome + iPhone), con
 * operaciones REALES en la base de PRUEBAS: compras y recompras, crédito con
 * firma, liquidaciones, cierre independiente de mesas, arqueo global de
 * fichas por denominación con diferencia simulada y ajuste autorizado por
 * un socio, arqueo de efectivo, retiro final con receptor, rechazo del
 * cajero y confirmación del socio, comprobante PNG, cierre sin actividad y
 * regreso auditado a Abierta.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let t25 = ""
let t10 = ""
const people = {
  a: { id: "", name: "", participationId: "" },
  b: { id: "", name: "", participationId: "" },
}

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const card = (page: Page, name: string) =>
  visible(page, "session-table-card").filter({ hasText: name })
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

async function purchase(
  page: Page,
  participationId: string,
  amount: string,
  credit = false
) {
  const p = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId,
    nominalAmount: amount,
    idempotencyKey: randomUUID(),
  })
  if (credit) {
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
  } else {
    await api(page, "post", `/api/purchases/${p.id}/payments`, {
      method: "CASH",
      amount,
      cashReceived: true,
      idempotencyKey: randomUUID(),
    })
  }
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

/** Liquidación real por API (firma incluida); `cash` = pago inmediato en efectivo. */
async function settle(
  page: Page,
  participationId: string,
  returned: string,
  cash?: string
) {
  const created = await api<{ id: string }>(page, "post", "/api/settlements", {
    participationId,
    returnedNominalAmount: returned,
    offsetDecision: "NO_COMPENSATE",
    idempotencyKey: randomUUID(),
  })
  const s = { settlementId: created.id }
  const prepared = await api<{
    summary: { snapshotId: string; payloadHash: string }
  }>(page, "post", `/api/settlements/${s.settlementId}/signature-summary`)
  await api(page, "post", `/api/settlements/${s.settlementId}/signatures`, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/settlements/${s.settlementId}`
  )
  await api(page, "post", `/api/settlements/${s.settlementId}/confirm-return`, {
    expectedVersion: view.version,
    chipsReceived: true,
    ...(Number(returned) === 0 ? { zeroReturnConfirmed: true } : {}),
    ...(cash ? { immediateCashAmount: cash, cashDelivered: true } : {}),
    idempotencyKey: randomUUID(),
  })
  return s.settlementId
}

/** Captura el arqueo final EN LA UI, denominación por denominación. */
async function countInUi(page: Page, shortBy = 0) {
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/inventario`)
  await page.waitForLoadState("networkidle")
  const start = visible(page, "closure-count-start")
  if (await start.isVisible()) {
    await start.click()
    await expect(visible(page, "count-lines")).toBeVisible()
  }
  const inv = await api<{
    count: { id: string }
  }>(page, "get", `/api/sessions/${sessionId}/closure/inventory`)
  const count = await api<{
    expectedTotal: string
    details: {
      denominationId: string
      unitValue: string
      expectedQuantity: number
    }[]
  }>(page, "get", `/api/chip-inventory/counts/${inv.count.id}`)
  const pieces = new Map(
    simulatePhysicalCount(
      count.details,
      Number(count.expectedTotal) - shortBy
    ).map((l) => [l.denominationId, l.countedQuantity])
  )
  const inputs = visible(page, "count-line")
  const n = await inputs.count()
  for (let i = 0; i < n; i++) {
    const line = inputs.nth(i)
    const id = await line.locator("input").getAttribute("id")
    await line
      .locator("input")
      .fill(String(pieces.get(id!.replace(/^c-/, "")) ?? 0))
  }
  await noHorizontalScroll(page)
  await page.getByRole("button", { name: "Confirmar conteo" }).click()
  await visible(page, "confirm-submit").click()
  await page.waitForLoadState("networkidle")
}

test("prepara una noche real con dos mesas, compras, recompras y liquidaciones", async ({
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
  t10 = tables.find((t) => t.name === "Mesa 10/10")!.tableId
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await page.waitForLoadState("networkidle")
  await card(page, "Mesa 25/25").getByTestId("table-open").click()
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  await card(page, "Mesa 10/10").getByTestId("table-open").click()
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  const suffix = `${testInfo.project.name} ${Date.now() % 100000}`
  for (const [k, table] of [
    ["a", t25],
    ["b", t10],
  ] as const) {
    people[k].name = `Cierre ${k.toUpperCase()} ${suffix}`
    people[k].id = (await createE2EPlayer(page.request, people[k].name)).id
    people[k].participationId = (
      await api<{ id: string }>(
        page,
        "post",
        `/api/sessions/${sessionId}/tables/${table}/players`,
        { playerId: people[k].id, idempotencyKey: randomUUID() }
      )
    ).id
  }
  await purchase(page, people.a.participationId, "3000")
  await purchase(page, people.a.participationId, "1000") // recompra
  await purchase(page, people.b.participationId, "2000", true) // crédito
  // A devuelve $3,500 y se le pagan en efectivo; B devuelve $1,000 (pago pendiente).
  await settle(page, people.a.participationId, "3500", "3500")
  await settle(page, people.b.participationId, "1000")
})

test("cierra la primera mesa mientras la otra sigue operando y luego la segunda", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await page.waitForLoadState("networkidle")
  await card(page, "Mesa 25/25").getByTestId("table-close").click()
  await page.getByTestId("confirm-close-table").click()
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Cerrada"
  )
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  // La otra mesa sigue operando: alta de un jugador nuevo.
  const extra = await createE2EPlayer(page.request, `Extra ${Date.now() % 1e5}`)
  const p = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${sessionId}/tables/${t10}/players`,
    { playerId: extra.id, idempotencyKey: randomUUID() }
  )
  await settle(page, p.id, "0")
  await card(page, "Mesa 10/10").getByTestId("table-close").click()
  await page.getByTestId("confirm-close-table").click()
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Cerrada"
  )
})

test("prevalidación, entrada a CLOSING y arqueo global con diferencia que bloquea", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}`)
  await visible(page, "go-closure").click()
  await expect(page).toHaveURL(/\/cierre$/)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/prevalidacion`)
  await expect(visible(page, "precheck-summary")).toContainText("0 bloqueo(s)")
  await expect(visible(page, "finding-PAYABLES_PENDING")).toHaveAttribute(
    "data-severity",
    "WARNING"
  )
  // Todos terminaron y faltan $1,500 por regresar: diferencia nominal GLOBAL
  // (advertencia antes del cierre; bloquea la confirmación).
  await expect(
    visible(page, "finding-SESSION_NOMINAL_DIFFERENCE")
  ).toHaveAttribute("data-severity", "WARNING")
  await noHorizontalScroll(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre`)
  await visible(page, "closure-start").click()
  await expect(visible(page, "session-status")).toHaveText("En cierre")

  // CLOSING bloquea compras.
  const blocked = await page.request.post("/api/purchases", {
    data: {
      participationId: people.a.participationId,
      nominalAmount: "500",
      idempotencyKey: randomUUID(),
    },
  })
  expect(blocked.ok()).toBeFalsy()

  // Fichas: entregadas $6,000 − devueltas $4,500 = $1,500 de diferencia nominal.
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/inventario`)
  await expect(visible(page, "chip-session-outstanding")).toHaveText(mxn(1500))
  // Arqueo con UNA ficha menos de la denominación menor: diferencia física.
  const inv0 = await api<{ nominal: { projectedCustody: string } }>(
    page,
    "get",
    `/api/sessions/${sessionId}/closure/inventory`
  )
  await expect(visible(page, "nominal-expected")).toHaveText(
    mxn(Number(inv0.nominal.projectedCustody))
  )
  const denominations = await api<
    { denominations: { value: string; isActive: boolean }[] }[]
  >(page, "get", "/api/chip-inventory")
  const smallest = Math.min(
    ...denominations[0].denominations
      .filter((d) => d.isActive)
      .map((d) => Number(d.value))
  )
  await countInUi(page, smallest)
  await expect(visible(page, "closure-count-difference")).toBeVisible()
  await expect(visible(page, "chip-physical-difference")).toHaveText(
    mxn(-smallest)
  )
  // La diferencia nominal se muestra aparte de la física (no se mezclan).
  await expect(visible(page, "chip-session-outstanding")).toHaveText(mxn(1500))
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/resumen`)
  await expect(visible(page, "check-CHIP_DIFFERENCES")).toHaveAttribute(
    "data-ok",
    "false"
  )
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/diferencias`)
  await expect(visible(page, "discrepancy")).toHaveAttribute(
    "data-status",
    "OPEN"
  )
  // El cajero no puede autorizar el ajuste excepcional.
  await expect(visible(page, "adjustment-requires-partner")).toBeVisible()
  await expect(visible(page, "authorize-adjustment")).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("un socio autoriza el ajuste; el cajero cuenta el efectivo y registra el retiro final con receptor", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/diferencias`)
  await page.waitForLoadState("networkidle")
  await page
    .getByLabel("Motivo")
    .filter({ visible: true })
    .fill("Ficha extraviada confirmada tras revisar")
  await visible(page, "authorize-adjustment").click()
  await expect(visible(page, "discrepancy")).toHaveAttribute(
    "data-status",
    "RESOLVED"
  )
  await expect(visible(page, "discrepancy-resolution")).toContainText(
    "Ajuste excepcional autorizado"
  )
  // Diferencia nominal global: las fichas no aparecieron en el arqueo → el
  // socio documenta y autoriza (sin movimientos).
  await expect(visible(page, "nominal-reconciliation")).toHaveAttribute(
    "data-status",
    "UNEXPLAINED_DIFFERENCE"
  )
  await expect(visible(page, "nominal-difference")).toHaveText(mxn(1500))
  await visible(page, "chip-rec-unrecovered").check()
  await visible(page, "chip-rec-reason").fill(
    "Fichas no localizadas tras revisar ambas mesas con el cajero"
  )
  await visible(page, "chip-rec-submit").click()
  await expect(visible(page, "nominal-reconciliation")).toHaveAttribute(
    "data-status",
    "RECONCILED"
  )
  await logout(page)

  await login(page, users.cashier)
  // Efectivo esperado: $3,000 + $1,000 − $3,500 pagados = $500.
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/caja`)
  await expect(visible(page, "cash-expected")).toHaveText(mxn(500))
  await page.getByLabel("Efectivo contado físicamente").fill("500")
  await visible(page, "closing-cash-verified").check()
  await visible(page, "closing-cash-submit").click()
  await expect(visible(page, "cash-difference-status")).toContainText(
    "Sin diferencia"
  )
  await noHorizontalScroll(page)

  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/retiro`)
  await expect(visible(page, "withdrawal-available")).toHaveText(mxn(500))
  await page.getByLabel("¿Quién recibe el efectivo?").fill("Socio receptor E2E")
  await visible(page, "withdrawal-delivered").check()
  await visible(page, "withdrawal-submit").click()
  await expect(visible(page, "withdrawal-done")).toBeVisible()
  await expect(visible(page, "withdrawal-recipient")).toHaveText(
    "Socio receptor E2E"
  )
  await expect(visible(page, "withdrawal-cash")).toHaveText(mxn(0))
  await noHorizontalScroll(page)
})

test("el cajero no puede confirmar; el socio confirma, ve el comprobante y descarga el PNG", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/resumen`)
  await expect(visible(page, "summary-final-cash")).toHaveText(mxn(0))
  await expect(visible(page, "closure-confirm-restricted")).toBeVisible()
  await expect(visible(page, "closure-confirm")).toHaveCount(0)
  const preview = await api<{ previewHash: string }>(
    page,
    "get",
    `/api/sessions/${sessionId}/closure/preview`
  )
  const denied = await page.request.post(
    `/api/sessions/${sessionId}/closure/confirm`,
    { data: { idempotencyKey: randomUUID(), previewHash: preview.previewHash } }
  )
  expect(denied.status()).toBe(403)
  await logout(page)

  await login(page, users.partner)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/resumen`)
  await page.waitForLoadState("networkidle")
  await noHorizontalScroll(page)
  await visible(page, "closure-reviewed").check()
  await visible(page, "closure-confirm").click()
  await expect(page).toHaveURL(/\/cierre\/comprobante$/, { timeout: 30_000 })
  await expect(visible(page, "closure-report")).toContainText(
    "Balance nominal de la sesión"
  )
  await expect(visible(page, "closure-report")).toContainText(
    "Socio receptor E2E"
  )
  await expect(visible(page, "session-status")).toHaveText("Cerrada")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    visible(page, "receipt-download").click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^cierre-.+\.png$/)
  await noHorizontalScroll(page)

  // Deuda y obligación persisten; la sesión cerrada no acepta compras.
  const credit = await api<{ outstanding: string }>(
    page,
    "get",
    `/api/credits/players/${people.b.id}`
  )
  expect(credit.outstanding).toBe("2000.00")
  const report = await api<{
    content: { settlements: { pendingAmount: string } }
  }>(page, "get", `/api/sessions/${sessionId}/closure/report`)
  expect(report.content.settlements.pendingAmount).toBe("1000.00")
  const closedBuy = await page.request.post("/api/purchases", {
    data: {
      participationId: people.a.participationId,
      nominalAmount: "500",
      idempotencyKey: randomUUID(),
    },
  })
  expect(closedBuy.ok()).toBeFalsy()
})

test("regreso CLOSING → Abierta con motivo queda auditado en el historial", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request)).id
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre`)
  await page.waitForLoadState("networkidle")
  await visible(page, "closure-start").click()
  await expect(visible(page, "session-status")).toHaveText("En cierre")
  await visible(page, "closure-return-open").click()
  await page.getByLabel("Motivo").fill("Faltó registrar una aportación real")
  await visible(page, "closure-return-open-confirm").click()
  await expect(visible(page, "session-status")).toHaveText("Abierta")
  await expect(visible(page, "closure-attempts")).toContainText(
    "Faltó registrar una aportación real"
  )
  await page.goto(`/dashboard/sesiones/${sessionId}`)
  await expect(visible(page, "status-history")).toContainText(
    "En cierre → Abierta"
  )
})

test("cierre sin actividad: motivo obligatorio y comprobante distinto", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  // Misma sesión del caso anterior: nunca abrió mesas.
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre`)
  await page.waitForLoadState("networkidle")
  await visible(page, "closure-start").click()
  await expect(visible(page, "session-status")).toHaveText("En cierre")
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/caja`)
  // Esperar la hidratación: en WebKit un fill previo se pierde al hidratar.
  await page.waitForLoadState("networkidle")
  const counted = page.getByLabel("Efectivo contado físicamente")
  await counted.fill("0")
  await expect(counted).toHaveValue("0")
  await visible(page, "closing-cash-verified").check()
  await visible(page, "closing-cash-submit").click()
  await expect(visible(page, "cash-difference-status")).toContainText(
    "Sin diferencia"
  )
  await logout(page)

  await login(page, users.superadmin)
  await page.goto(`/dashboard/sesiones/${sessionId}/cierre/resumen`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "closure-no-activity")).toBeVisible()
  await visible(page, "closure-reviewed").check()
  await expect(visible(page, "closure-confirm")).toBeDisabled()
  await page
    .getByLabel("Motivo del cierre sin actividad")
    .fill("No llegaron jugadores esta noche")
  await visible(page, "closure-confirm").click()
  await expect(page).toHaveURL(/\/cierre\/comprobante$/, { timeout: 30_000 })
  await expect(visible(page, "closure-report-kind")).toHaveText(
    "Cerrada sin actividad"
  )
  await expect(visible(page, "closure-report")).toContainText(
    "No llegaron jugadores esta noche"
  )
  await noHorizontalScroll(page)
})
