import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, logout, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 16 desde la UI (Chrome + iPhone) sobre la base de PRUEBAS:
 * canje posterior (solicitud del cajero, validación del socio, recepción
 * física con firma, pago por transferencia en trámite → ejecutada), reverso
 * de compra (bloqueado sin devolución física, ejecutado con devolución y
 * reembolso desde la caja abierta) y pantallas de correcciones y fondos no
 * aplicados. Nunca se usan servicios bancarios reales.
 */
test.describe.configure({ mode: "serial" })

const ctx = {
  sessionId: "",
  playerId: "",
  playerName: "",
  purchaseId: "",
  redemptionId: "",
  correctionId: "",
}
const BASE = "/dashboard/operaciones-especiales"

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
  return p.id
}

test("prepara compras reales en la base de pruebas", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 5_000 })
  ).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/tables`
  )
  const t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await page.request.post(`/api/sessions/${ctx.sessionId}/tables/${t25}/open`, {
    data: { idempotencyKey: randomUUID() },
  })
  ctx.playerName = `Especial ${testInfo.project.name} ${Date.now() % 1e5}`
  const player = await createE2EPlayer(page.request, ctx.playerName)
  ctx.playerId = player.id
  const part = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${t25}/players`,
    { playerId: player.id, idempotencyKey: randomUUID() }
  )
  // Fichas en circulación (para el canje) y la compra que se revertirá.
  await cashPurchase(page, part.id, "500")
  ctx.purchaseId = await cashPurchase(page, part.id, "300")
})

test("CASHIER: registra un canje posterior; no puede validarlo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(BASE)
  await expect(visible(page, "special-rules")).toBeVisible()
  await noHorizontalScroll(page)
  await visible(page, "new-redemption").click()
  await expect(page).toHaveURL(/canjes\/nuevo/)
  await visible(page, "redemption-player").selectOption(ctx.playerId)
  await visible(page, "redemption-presenter").fill(ctx.playerName)
  await visible(page, "redemption-amount").fill("200")
  await Promise.all([
    page.waitForURL(/canjes\/(?!nuevo)[A-Za-z0-9_-]+$/),
    visible(page, "submit-redemption").click(),
  ])
  ctx.redemptionId = page.url().split("/").pop()!
  await expect(visible(page, "redemption-status")).toContainText(
    "falta validación"
  )
  await expect(visible(page, "cashier-cannot-validate")).toBeVisible()
  await expect(visible(page, "redemption-validate-form")).toHaveCount(0)
  const denied = await page.request.post(
    `/api/special-operations/redemptions/${ctx.redemptionId}/validate`,
    {
      data: {
        expectedVersion: 1,
        acceptedNominal: "200",
        notes: "Intento del cajero E2E",
      },
    }
  )
  expect(denied.status()).toBe(403)
  await noHorizontalScroll(page)
})

test("PARTNER: valida el valor del canje (sin recibir fichas ni mover dinero)", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto(`${BASE}/canjes/${ctx.redemptionId}`)
  await visible(page, "redemption-accepted").fill("200")
  await visible(page, "redemption-validation-notes").fill(
    "Fichas auténticas revisadas por el socio en E2E"
  )
  await visible(page, "submit-redemption-validation").click()
  await expect(visible(page, "redemption-status")).toContainText(
    "pendiente de recepción física"
  )
  await expect(visible(page, "redemption-received")).toContainText("Pendiente")
  await expect(visible(page, "payable-card")).toHaveCount(0)
})

test("CASHIER: recibe físicamente con firma y paga por transferencia (en trámite → realizada)", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`${BASE}/canjes/${ctx.redemptionId}`)
  // Sin confirmar la recepción física el panel de firma está deshabilitado.
  await expect(visible(page, "signature-confirm")).toBeDisabled()
  await visible(page, "redemption-physical").check()
  await drawSignature(page)
  await visible(page, "signature-confirm").click()
  await expect(visible(page, "redemption-status")).toContainText(
    "pago pendiente",
    { timeout: 15_000 }
  )
  await expect(visible(page, "payable-pending")).toContainText("200")
  await expect(visible(page, "payable-paid")).toContainText("0.00")
  // Transferencia: queda en trámite y no cuenta como pagada.
  await visible(page, "payout-method").selectOption("BANK_TRANSFER")
  await visible(page, "payout-amount").fill("120")
  await visible(page, "submit-payout").click()
  await expect(visible(page, "payable-in-transit")).toBeVisible({
    timeout: 15_000,
  })
  await expect(visible(page, "payable-paid")).toContainText("0.00")
  await visible(page, "resolve-reference").fill("SPEI-E2E-CANJE")
  await visible(page, "submit-resolve").click()
  await expect(visible(page, "payable-paid")).toContainText("120", {
    timeout: 15_000,
  })
  await expect(visible(page, "payable-pending")).toContainText("80")
  await expect(visible(page, "redemption-status")).toContainText("parcialmente")
  await expect(visible(page, "special-receipt-download")).toHaveCount(2)
  await noHorizontalScroll(page)
})

test("reverso de compra: bloqueado sin devolución física; ejecutado con devolución y reembolso desde la caja abierta", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const req = await api<{ id: string }>(
    page,
    "post",
    "/api/admin/corrections",
    {
      type: "PURCHASE_REVERSAL",
      targetType: "ChipPurchase",
      targetId: ctx.purchaseId,
      reason: "Compra capturada al jugador equivocado (E2E)",
      idempotencyKey: randomUUID(),
    }
  )
  ctx.correctionId = req.id
  await page.goto(
    `${BASE}/reversos-compras/nuevo?purchaseId=${ctx.purchaseId}&correctionId=${ctx.correctionId}`
  )
  await expect(visible(page, "reversal-needs-approval")).toBeVisible()
  await logout(page)

  await login(page, users.partner)
  await api(
    page,
    "post",
    `/api/admin/corrections/${ctx.correctionId}/approve`,
    {
      expectedVersion: 1,
      notes: "Autorizado por el socio (E2E)",
    }
  )
  await logout(page)

  await login(page, users.cashier)
  await page.goto(`${BASE}/reversos-compras`)
  await Promise.all([
    page.waitForURL(/reversos-compras\/nuevo/),
    visible(page, "open-reversal").first().click(),
  ])
  await visible(page, "reversal-reason").fill(
    "Compra capturada al jugador equivocado (E2E)"
  )
  // Sin devolución física: el servidor lo bloquea (y lo audita).
  await visible(page, "submit-reversal").click()
  await expect(visible(page, "special-error")).toContainText("físicamente")
  await expect(page).toHaveURL(/reversos-compras\/nuevo/)
  await visible(page, "reversal-physical").check()
  await expect(visible(page, "reversal-plan")).toHaveAttribute(
    "data-executable",
    "true"
  )
  await Promise.all([
    page.waitForURL(/reversos-compras\/(?!nuevo)[A-Za-z0-9_-]+$/),
    visible(page, "submit-reversal").click(),
  ])
  await expect(visible(page, "reversal-status")).toContainText("ejecutado")
  await expect(visible(page, "reversal-extinguished")).toContainText("0.00")
  await expect(visible(page, "reversal-refund")).toContainText("300")
  // Reembolso REAL desde la caja de la sesión (abierta).
  await visible(page, "payout-funding").selectOption("SESSION_CASH")
  await visible(page, "payout-amount").fill("300")
  await visible(page, "payout-delivered").check()
  await visible(page, "submit-payout").click()
  await expect(visible(page, "payable-status")).toContainText("Pagado", {
    timeout: 15_000,
  })
  await expect(visible(page, "payout-form")).toHaveCount(0)
  // La compra queda REVERSED y la solicitud EXECUTED (no solo autorizada).
  const purchase = await api<{ status: string }>(
    page,
    "get",
    `/api/purchases/${ctx.purchaseId}`
  )
  expect(purchase.status).toBe("REVERSED")
  await page.goto(`/dashboard/administracion/correcciones/${ctx.correctionId}`)
  await expect(visible(page, "correction-status")).toContainText("Ejecutada")
  await noHorizontalScroll(page)
})

test("pantallas de correcciones de liquidaciones y fondos no aplicados; CASHIER sin autorizar", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`${BASE}/correcciones-liquidaciones`)
  await expect(visible(page, "request-settlement-correction")).toBeVisible()
  await noHorizontalScroll(page)
  await page.goto(`${BASE}/fondos-no-aplicados`)
  await expect(
    visible(page, "unapplied-list").or(visible(page, "no-unapplied"))
  ).toBeVisible()
  await noHorizontalScroll(page)
  await page.goto(BASE)
  await expect(visible(page, "special-payables-REDEMPTION")).toBeVisible()
  // Estricto: el cliente no fija estados ni importes derivados.
  const bad = await page.request.post("/api/special-operations/redemptions", {
    data: {
      presenterName: "X Y",
      presentedNominal: "10",
      status: "PAID",
      idempotencyKey: randomUUID(),
    },
  })
  expect(bad.status()).toBe(400)
})
