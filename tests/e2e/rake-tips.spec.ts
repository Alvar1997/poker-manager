import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import {
  createE2EPlayer,
  openSessionViaApi,
  simulatePhysicalCount,
} from "./session-fixtures"

/**
 * Módulo 18 simplificado (Chrome + iPhone), base de PRUEBAS: staff →
 * rake manual de 10/10 con acumulado → conteo final de 25/25 → propinas
 * por empleado (borrador y confirmación) → resumen de cierre con
 * entregado/devuelto/rake/propinas/diferencia → el CAJERO cierra con
 * motivo cuando faltan fichas.
 */
test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)

const ctx = { sessionId: "", t10: "", t25: "", player: "", suffix: "" }
const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const mxn = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n
  )

async function api<T>(
  page: Page,
  method: "get" | "post" | "patch",
  url: string,
  data?: unknown
) {
  const res =
    method === "get"
      ? await page.request.get(url)
      : method === "post"
        ? await page.request.post(url, { data })
        : await page.request.patch(url, { data })
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

async function goto(page: Page, url: string) {
  await page.goto(url)
  await page.waitForLoadState("networkidle")
}

test("prepara la sesión, el staff y una compra de $3,000 en efectivo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  ctx.suffix = randomUUID().slice(0, 5)
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 10_000 })
  ).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/tables`
  )
  ctx.t10 = tables.find((t) => t.name === "Mesa 10/10")!.tableId
  ctx.t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  for (const t of [ctx.t10, ctx.t25])
    await api(page, "post", `/api/sessions/${ctx.sessionId}/tables/${t}/open`, {
      idempotencyKey: randomUUID(),
    })
  const p = await createE2EPlayer(page.request, `Jugador ${ctx.suffix}`)
  const part = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/players`,
    { playerId: p.id, idempotencyKey: randomUUID() }
  )
  ctx.player = part.id
  const purchase = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId: part.id,
    nominalAmount: "3000",
    idempotencyKey: randomUUID(),
  })
  await api(page, "post", `/api/purchases/${purchase.id}/payments`, {
    method: "CASH",
    amount: "3000",
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
  await goto(page, "/dashboard/administracion/staff")
  for (const [name, position] of [
    [`Carlos ${ctx.suffix}`, "Dealer"],
    [`Ana ${ctx.suffix}`, "Mesero"],
  ]) {
    await visible(page, "staff-name").fill(name)
    await visible(page, "staff-position").selectOption({ label: position })
    await visible(page, "staff-create-submit").click()
    await expect(
      page.getByTestId("staff-row").filter({ hasText: name })
    ).toBeVisible()
  }
  await noHorizontalScroll(page)
})

test("rake manual de 10/10: $50, $75 y $100 con acumulado de $225", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/mesas/${ctx.t10}/rake`)
  await expect(visible(page, "rake-mode-label")).toHaveText("Captura manual")
  for (const [i, a] of ["50", "75", "100"].entries()) {
    await visible(page, "rake-amount").fill(a)
    await expect(visible(page, "rake-amount")).toHaveValue(a)
    await visible(page, "rake-entry-submit").click()
    await expect(visible(page, "rake-history").locator("li")).toHaveCount(i + 1)
  }
  await expect(visible(page, "rake-total")).toHaveText(mxn(225))
  // El cajero no cambia la modalidad (solo un socio).
  await expect(page.getByTestId("rake-mode-form")).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("propinas por empleado: borrador, confirmación y total", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre/propinas`)
  for (const name of [`Carlos ${ctx.suffix}`, `Ana ${ctx.suffix}`]) {
    const value = await page
      .getByTestId("session-staff-select")
      .filter({ visible: true })
      .locator("option", { hasText: name })
      .getAttribute("value")
    await visible(page, "session-staff-select").selectOption(value!)
    await visible(page, "add-session-staff-submit").click()
    await expect(
      page.getByTestId("staff-tip-row").filter({ hasText: name })
    ).toBeVisible()
  }
  for (const [name, amount] of [
    [`Carlos ${ctx.suffix}`, "300"],
    [`Ana ${ctx.suffix}`, "200"],
  ]) {
    const row = page
      .getByTestId("staff-tip-row")
      .filter({ hasText: name })
      .filter({ visible: true })
    await row.getByTestId("staff-tip-amount").fill(amount)
    await row.getByTestId("staff-tip-save").click()
    await expect(row).toHaveAttribute("data-state", "DRAFT")
    // El borrador no cuenta todavía.
    await row.getByTestId("staff-tip-received").check()
    await row.getByTestId("staff-tip-confirm").click()
    await expect(row).toHaveAttribute("data-state", "CONFIRMED")
  }
  await expect(visible(page, "tips-total")).toHaveText(mxn(500))
  await noHorizontalScroll(page)
  // Asistente, paso 3: confirmación EXPLÍCITA de que el conteo está completo.
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre?paso=3`)
  await expect(visible(page, "wizard-step-3")).toHaveAttribute(
    "data-status",
    "ERROR"
  )
  await visible(page, "tips-review").click()
  await expect(visible(page, "tips-reviewed")).toBeVisible()
  await expect(visible(page, "wizard-step-3")).toHaveAttribute(
    "data-status",
    "COMPLETED"
  )
})

test("cierre: faltan $25 → advertencia, el CAJERO registra el motivo y cierra", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  // Liquidación: devuelve 2,000. 3,000 = 2,000 + 225 (rake 10/10) + 500 (propinas) + 250 (rake 25/25) + 25 faltantes.
  const s = await api<{ id: string }>(page, "post", "/api/settlements", {
    participationId: ctx.player,
    returnedNominalAmount: "2000",
    offsetDecision: "NO_COMPENSATE",
    idempotencyKey: randomUUID(),
  })
  const prepared = await api<{
    summary: { snapshotId: string; payloadHash: string }
  }>(page, "post", `/api/settlements/${s.id}/signature-summary`)
  const strokes = [
    Array.from({ length: 40 }, (_, i) => [
      100 + i * 20,
      Math.round(200 + 120 * Math.sin(i / 3)),
    ]),
    Array.from({ length: 15 }, (_, i) => [150 + i * 50, 360]),
  ]
  await api(page, "post", `/api/settlements/${s.id}/signatures`, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes,
    idempotencyKey: randomUUID(),
  })
  const sv = await api<{ version: number }>(
    page,
    "get",
    `/api/settlements/${s.id}`
  )
  await api(page, "post", `/api/settlements/${s.id}/confirm-return`, {
    expectedVersion: sv.version,
    chipsReceived: true,
    immediateCashAmount: "2000",
    cashDelivered: true,
    idempotencyKey: randomUUID(),
  })
  for (const t of [ctx.t10, ctx.t25])
    await api(
      page,
      "post",
      `/api/sessions/${ctx.sessionId}/tables/${t}/close`,
      {
        idempotencyKey: randomUUID(),
      }
    )
  // Asistente, paso 2: el rake de 25/25 está pendiente → RESOLVER.
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre?paso=2`)
  await expect(visible(page, "wizard-step-2")).toHaveAttribute(
    "data-status",
    "ERROR"
  )
  const task = page
    .getByTestId("wizard-task")
    .filter({ visible: true })
    .and(page.locator('[data-code="RAKE_COUNT_MISSING"]'))
  await task.getByTestId("wizard-resolve").click()
  await expect(page).toHaveURL(new RegExp(`/mesas/${ctx.t25}/rake$`))
  await page.waitForLoadState("networkidle")
  const form = visible(page, "rake-count-form")
  await form.getByTestId("rake-count-amount").fill("250")
  await expect(form.getByTestId("rake-count-amount")).toHaveValue("250")
  await form.getByTestId("rake-count-confirm").check()
  await form.getByTestId("rake-count-submit").click()
  await expect(visible(page, "rake-total")).toHaveText(mxn(250))
  // Volver al cierre con un toque: el paso se recalcula.
  await visible(page, "closure-return").click()
  await expect(page).toHaveURL(/\/cierre\?paso=2$/)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "wizard-step-2")).toHaveAttribute(
    "data-status",
    "COMPLETED"
  )
  // Cierre: arqueo global exacto y caja.
  await api(page, "post", `/api/sessions/${ctx.sessionId}/closure/start`, {
    idempotencyKey: randomUUID(),
  })
  const started = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/closure/inventory-count`,
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
    `/api/sessions/${ctx.sessionId}/closure/inventory-count`,
    {
      action: "confirm",
      countId: count.id,
      idempotencyKey: randomUUID(),
    }
  )
  await api(page, "post", `/api/sessions/${ctx.sessionId}/closure/cash-count`, {
    countedAmount: "1000",
    physicallyCounted: true,
  })
  await api(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/closure/cash-withdrawal`,
    {
      idempotencyKey: randomUUID(),
      amount: "1000",
      recipientName: "Socio receptor E2E",
      physicallyDelivered: true,
    }
  )
  // Paso 5: conciliación con desglose y motivo obligatorio.
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre?paso=5`)
  await expect(visible(page, "rec-delivered")).toHaveText(mxn(3000))
  await expect(visible(page, "rec-players")).toHaveText(mxn(2000))
  await expect(visible(page, "rec-rake")).toHaveText(mxn(475))
  await expect(visible(page, "rec-tips")).toHaveText(mxn(500))
  await expect(visible(page, "rec-nominal")).toHaveText(
    "faltan $25.00 por justificar"
  )
  await expect(visible(page, "wizard-step-5")).toHaveAttribute(
    "data-status",
    "ERROR"
  )
  await visible(page, "reason-nominal").fill(
    "Propina que no quedó correctamente registrada"
  )
  await visible(page, "reason-save").click()
  await expect(visible(page, "wizard-step-5")).toHaveAttribute(
    "data-status",
    "WARNING"
  )
  await noHorizontalScroll(page)
  // Persistencia: al recargar el cierre sin ?paso abre el último paso.
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre`)
  await expect(visible(page, "wizard-panel-reconciliation")).toBeVisible()
  await expect(visible(page, "reason-nominal")).toHaveValue(
    "Propina que no quedó correctamente registrada"
  )
  // Paso 6: resumen y confirmación final (el CAJERO cierra).
  await goto(page, `/dashboard/sesiones/${ctx.sessionId}/cierre?paso=6`)
  await expect(visible(page, "wizard-ready")).toContainText("faltan $25.00")
  await expect(visible(page, "wizard-progress")).toHaveText(
    "Progreso: 6 de 6 pasos"
  )
  await noHorizontalScroll(page)
  await visible(page, "wizard-confirm").click()
  await visible(page, "wizard-confirm-final").click()
  await expect(page).toHaveURL(/\/cierre\/comprobante$/, { timeout: 30_000 })
  await expect(visible(page, "closure-report")).toContainText(
    "Propina que no quedó correctamente registrada"
  )
  await expect(visible(page, "closure-report")).toContainText("faltan")
})
