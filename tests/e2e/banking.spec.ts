import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, logout, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 17 — jugadores bancados (Chrome + iPhone), con la base de PRUEBAS.
 * Acuerdo privado → cuatro noches (compras financiadas, recompra, devolución
 * física, retorno conciliado) → anticipo verbal pagado → cambio de
 * porcentaje aprobado digitalmente → corte con distribución entre tramos
 * aprobado por PARTNER (CASHIER rechazado) → reserva y obligación →
 * siguiente ciclo → retiro aprobado y pago parcial → auditoría y XLSX. La
 * mesa nunca muestra señales del bancaje.
 */
test.describe.configure({ mode: "serial" })
// Varias noches reales por prueba: más tiempo que el predeterminado.
test.setTimeout(240_000)

const ctx = {
  suffix: "",
  playerId: "",
  playerName: "",
  sessionId: "",
  t25: "",
  cycleId: "",
}
const BASE = "/dashboard/administracion/bancaje"

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })

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

/** Cambia de usuario dentro de la misma prueba (cierra sesión primero). */
async function switchTo(page: Page, user: { email: string; password: string }) {
  await logout(page)
  await login(page, user)
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function go(page: Page, url: string) {
  await page.waitForLoadState("networkidle")
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url)
      break
    } catch (e) {
      if (
        attempt >= 3 ||
        !String(e).includes("interrupted by another navigation")
      )
        throw e
      await page.waitForLoadState("networkidle")
    }
  }
  await page.waitForLoadState("networkidle")
}

/** Abre una noche real con la mesa 25/25 y sienta al bancado en el asiento 1. */
async function openNight(page: Page) {
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 40_000 })
  ).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/tables`
  )
  ctx.t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await api(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/open`,
    {
      idempotencyKey: randomUUID(),
    }
  )
  await api(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/seats/1/assign`,
    {
      playerId: ctx.playerId,
      idempotencyKey: randomUUID(),
    }
  )
}

/** Contraparte ordinaria que paga en efectivo (fichas reales en circulación). */
async function cashPlayer(page: Page, amount: string, seat?: number) {
  const p = await createE2EPlayer(
    page.request,
    `Contraparte ${ctx.suffix} ${randomUUID().slice(0, 4)}`
  )
  const part = seat
    ? await api<{ participationId: string }>(
        page,
        "post",
        `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/seats/${seat}/assign`,
        { playerId: p.id, idempotencyKey: randomUUID() }
      ).then((r) => ({ id: r.participationId }))
    : await api<{ id: string }>(
        page,
        "post",
        `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/players`,
        {
          playerId: p.id,
          idempotencyKey: randomUUID(),
        }
      )
  for (const a of amount.split("+")) {
    const purchase = await api<{ id: string }>(page, "post", "/api/purchases", {
      participationId: part.id,
      nominalAmount: a,
      idempotencyKey: randomUUID(),
    })
    await api(page, "post", `/api/purchases/${purchase.id}/payments`, {
      method: "CASH",
      amount: a,
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
  return p.id
}

async function gotoPlayer(page: Page) {
  await go(page, `${BASE}/jugadores/${ctx.playerId}`)
  await expect(page.getByTestId("player-agreement")).toBeVisible()
}

/** Entrega financiada desde la sección PRIVADA (nunca desde la mesa). */
async function financedBuy(page: Page, amount: string) {
  await gotoPlayer(page)
  const panel = visible(page, "financed-panel")
  await panel.getByTestId("financed-form-nominalAmount").fill(amount)
  await panel.getByTestId("financed-form-physicalDeliveryConfirmed").check()
  await panel.getByTestId("financed-form-submit").click()
  await expect(page.getByText("Entrega registrada")).toBeVisible()
}

async function reconcile(page: Page, returned: string) {
  await gotoPlayer(page)
  await visible(page, "reconcile-panel").locator("summary").click()
  await visible(page, "reconcile-form-returnedNominalAmount").fill(returned)
  if (returned === "0")
    await visible(page, "reconcile-form-zeroReturnConfirmed").check()
  await visible(page, "reconcile-form-physicalReturnVerified").check()
  await visible(page, "reconcile-form-submit").click()
  await expect(page.getByText("Jugada conciliada")).toBeVisible()
}

/** Noche completa: financia, la contraparte equilibra y se concilia. */
async function night(page: Page, buys: string[], returned: string) {
  await openNight(page)
  for (const b of buys) await financedBuy(page, b)
  const total = buys.reduce((a, b) => a + Number(b), 0)
  const win = Number(returned) - total
  if (win > 0) await cashPlayer(page, String(win))
  await reconcile(page, returned)
}

test("PARTNER registra un acuerdo privado para un jugador existente", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  ctx.suffix = `${testInfo.project.name === "chromium" ? "C" : "M"}${Date.now() % 100000}`
  ctx.playerName = `Ramírez Uno ${ctx.suffix}`
  ctx.playerId = (await createE2EPlayer(page.request, ctx.playerName)).id
  await go(page, `${BASE}/jugadores`)
  const form = visible(page, "agreement-form")
  await form.getByTestId("agreement-form-playerId").selectOption(ctx.playerId)
  await form.getByTestId("agreement-form-playerPercent").fill("50")
  await form
    .getByTestId("agreement-form-reason")
    .fill("Acuerdo privado 50/50 de prueba E2E")
  await form.getByTestId("agreement-form-submit").click()
  await expect(
    visible(page, "banked-row").filter({ hasText: ctx.playerName })
  ).toContainText("50.00% / 50.00%")
  await noHorizontalScroll(page)
})

test("noche 1: compra y recompra financiadas, mesa SIN indicadores, devolución física → +3,000", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await openNight(page)
  // Un jugador normal con dos compras pagadas, como referencia visual.
  await cashPlayer(page, "500+500", 2)
  await financedBuy(page, "5000")
  await financedBuy(page, "2000")
  await expect(visible(page, "live-financed")).toContainText("7,000")
  // Mesa compartida: el bancado se ve EXACTAMENTE como el normal.
  await go(page, `/dashboard/sesiones/${ctx.sessionId}/mesas/${ctx.t25}`)
  await expect(page.getByTestId("poker-table")).toBeVisible()
  const s1 = page.getByTestId("seat-1")
  const s2 = page.getByTestId("seat-2")
  await expect(s1).toHaveAttribute("data-seat-state", "PLAYING")
  expect(await s1.getAttribute("data-seat-state")).toBe(
    await s2.getAttribute("data-seat-state")
  )
  expect(await s1.getAttribute("class")).toBe(await s2.getAttribute("class"))
  const table = await page.getByTestId("poker-table").innerText()
  expect(table).not.toMatch(/banc|financ|reserva|anticipo|%/i)
  const board = await page.request.get(
    `/api/sessions/${ctx.sessionId}/tables/${ctx.t25}/seats`
  )
  expect(await board.text()).not.toMatch(
    /bank|HOUSE|fundingSource|reserv|agreement/i
  )
  // La contraparte aporta las fichas que el bancado gana.
  await cashPlayer(page, "3000")
  await reconcile(page, "10000")
  await expect(visible(page, "player-cycle")).toContainText("#1 · 1/4")
  ctx.cycleId = (await page
    .getByTestId("cycle-link")
    .first()
    .getAttribute("href"))!
    .split("/")
    .at(-1)!
  await go(page, `${BASE}/ciclos/${ctx.cycleId}`)
  await expect(visible(page, "game-result").first()).toContainText("3,000")
  await noHorizontalScroll(page)
})

test("anticipo autorizado VERBALMENTE por un socio y pagado con efectivo real", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoPlayer(page)
  await expect(visible(page, "advance-available")).toContainText("1,500")
  await visible(page, "advance-panel").locator("summary").click()
  const f = visible(page, "advance-form")
  await f.getByTestId("advance-form-enablingGameId").selectOption({ index: 1 })
  await f.getByTestId("advance-form-requestedAmount").fill("1000")
  await f.getByTestId("advance-form-authorizedAmount").fill("1000")
  const authorizer = f.getByTestId("advance-form-authorizerId")
  await authorizer.selectOption({ label: `${users.partner.name} (PARTNER)` })
  await f.getByTestId("advance-form-channel").selectOption("VERBAL")
  await f.getByTestId("advance-form-submit").click()
  await expect(visible(page, "advance-status").first()).toHaveText("Autorizado")
  const row = visible(page, "advance-row").first()
  await row.locator("summary", { hasText: "Entregar dinero" }).click()
  await row.locator('[data-testid$="-funding"]').selectOption("SESSION_CASH")
  await row.locator('[data-testid$="-amount"]').fill("1000")
  await row.locator('[data-testid$="-submit"]').first().click()
  await expect(visible(page, "advance-status").first()).toHaveText("Pagado")
  await expect(visible(page, "advance-paid").first()).toContainText("1,000")
})

test("noches 2–4 con cambio de porcentaje aprobado DIGITALMENTE desde la jugada 3", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await night(page, ["5000"], "3000") // −2,000 @50%
  // CASHIER solicita; no ve la aprobación.
  await gotoPlayer(page)
  await visible(page, "change-panel").locator("summary").click()
  await visible(page, "change-form-playerPercent").fill("60")
  await visible(page, "change-form-mode").selectOption("FROM_NEXT_GAME")
  await visible(page, "change-form-reason").fill(
    "Nuevo porcentaje desde la tercera jugada"
  )
  await visible(page, "change-form-submit").click()
  await expect(visible(page, "change-status").first()).toHaveText("Pendiente")
  await expect(page.locator('[data-testid^="change-decision-"]')).toHaveCount(0)
  // PARTNER aprueba digitalmente.
  await switchTo(page, users.partner)
  await gotoPlayer(page)
  const decision = page
    .locator('[data-testid^="change-decision-"]')
    .filter({ visible: true })
    .first()
  await decision.locator('[data-testid$="-decision"]').selectOption("APPROVE")
  await decision.locator('[data-testid$="-submit"]').click()
  await expect(visible(page, "change-status").first()).toHaveText("Aprobada")
  await expect(visible(page, "player-agreement")).toContainText("60.00%")
  await switchTo(page, users.cashier)
  await night(page, ["2000"], "6000") // +4,000 @60%
  await night(page, ["2000"], "1000") // −1,000 @60%
  await go(page, `${BASE}/ciclos/${ctx.cycleId}`)
  await expect(visible(page, "cycle-status")).toHaveText("Listo para corte")
  await expect(visible(page, "cycle-game-row")).toHaveCount(4)
  await expect(visible(page, "prov-allocation")).toBeVisible()
  await expect(visible(page, "allocation-needed")).toBeVisible()
  await noHorizontalScroll(page)
})

test("corte: PARTNER distribuye pérdidas entre tramos y aprueba; CASHIER no puede aprobar", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await go(page, `${BASE}/ciclos/${ctx.cycleId}`)
  // Ganancias: tramo 50% = 3,000 · tramo 60% = 4,000; pérdidas = 3,000.
  await visible(page, "alloc-0").fill("2000")
  await visible(page, "alloc-1").fill("1000")
  // (3,000−2,000)×50% + (4,000−1,000)×60% = 2,300 − anticipo 1,000 = 1,300.
  await visible(page, "closing-reserve").fill("1000")
  await visible(page, "closing-pay").fill("400")
  await visible(page, "prepare-closing-submit").click()
  await expect(visible(page, "prepare-closing-error")).toContainText(
    "exactamente el saldo"
  )
  await visible(page, "closing-pay").fill("300")
  await visible(page, "prepare-closing-submit").click()
  await expect(visible(page, "closing-status").first()).toHaveText(
    "En revisión"
  )
  await expect(visible(page, "closing-player").first()).toContainText("2,300")
  // CASHIER: sin aprobación (ni en pantalla ni por API).
  await switchTo(page, users.cashier)
  await go(page, `${BASE}/ciclos/${ctx.cycleId}`)
  await expect(visible(page, "approval-required")).toBeVisible()
  await expect(page.getByTestId("approve-closing-form")).toHaveCount(0)
  const cycle = await api<{
    closings: { id: string; snapshotHash: string; status: string }[]
  }>(page, "get", `/api/admin/banking/cycles/${ctx.cycleId}`)
  const review = cycle.closings.find((c) => c.status === "UNDER_REVIEW")!
  const denied = await page.request.post(
    `/api/admin/banking/cycles/${ctx.cycleId}/approve-closing`,
    {
      data: {
        closingId: review.id,
        snapshotHash: review.snapshotHash,
        idempotencyKey: randomUUID(),
      },
    }
  )
  expect(denied.status()).toBe(403)
  // PARTNER aprueba digitalmente.
  await switchTo(page, users.partner)
  await go(page, `${BASE}/ciclos/${ctx.cycleId}`)
  await visible(page, "approve-closing-form-submit").click()
  await expect(visible(page, "cycle-status")).toHaveText("Cerrado")
  await expect(visible(page, "closing-reserve-amount").first()).toContainText(
    "1,000"
  )
  await expect(visible(page, "closing-payable-pending").first()).toContainText(
    "300"
  )
  await gotoPlayer(page)
  await expect(visible(page, "player-reserve")).toContainText("1,000")
})

test("siguiente ciclo y retiro de reserva aprobado digitalmente con pago parcial", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await night(page, ["3000"], "2500") // ciclo 2: −500 (la reserva lo cubriría en su corte)
  await gotoPlayer(page)
  await expect(visible(page, "player-cycle")).toContainText("#2 · 1/4")
  // Reserva 1,000 − déficit confirmado 500 del ciclo abierto = 500 retirables.
  await expect(visible(page, "reserve-withdrawable")).toContainText("500")
  await visible(page, "withdrawal-panel").locator("summary").click()
  await visible(page, "withdrawal-form-amount").fill("400")
  await visible(page, "withdrawal-form-reason").fill(
    "El jugador solicita parte de su reserva"
  )
  await visible(page, "withdrawal-form-submit").click()
  await expect(visible(page, "withdrawal-status").first()).toHaveText(
    "Solicitado"
  )
  await expect(
    page.locator('[data-testid^="withdrawal-decision-form-"]')
  ).toHaveCount(0)
  await switchTo(page, users.partner)
  await gotoPlayer(page)
  const d = page
    .locator('[data-testid^="withdrawal-decision-form-"]')
    .filter({ visible: true })
    .first()
  await d.locator('[data-testid$="-decision"]').selectOption("APPROVE")
  await d.locator('[data-testid$="-submit"]').click()
  await expect(visible(page, "withdrawal-status").first()).toHaveText(
    "Aprobado"
  )
  await expect(visible(page, "player-reserve")).toContainText("600")
  await switchTo(page, users.cashier)
  await gotoPlayer(page)
  // Efectivo REAL en la caja de la sesión (un cobro ordinario) para pagar:
  // sin él, el libro rechaza el pago (nunca saldo negativo).
  await cashPlayer(page, "1000")
  await gotoPlayer(page)
  const row = visible(page, "withdrawal-row").first()
  await row.locator("summary", { hasText: "Pagar retiro" }).click()
  await row.locator('[data-testid$="-funding"]').selectOption("SESSION_CASH")
  await row.locator('[data-testid$="-amount"]').fill("300")
  await row.locator('[data-testid$="-submit"]').first().click()
  await expect(visible(page, "withdrawal-status").first()).toHaveText(
    "Pagado parcialmente"
  )
  await expect(visible(page, "withdrawal-paid").first()).toContainText("300")
  await noHorizontalScroll(page)
})

test("auditoría privada, XLSX y la mesa sigue sin señales de bancaje", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await go(page, "/dashboard/administracion/auditoria?module=BANKING")
  await expect(
    page.getByText("BANKING_CLOSING_APPROVED").filter({ visible: true }).first()
  ).toBeVisible()
  const xlsx = await page.request.get(
    "/api/admin/banking/reports/export?format=xlsx"
  )
  expect(xlsx.status()).toBe(200)
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml")
  expect(
    (
      await page.request.get("/api/admin/banking/reports/export?format=csv")
    ).status()
  ).toBe(400)
  await go(page, BASE)
  await expect(visible(page, "dash-active")).not.toHaveText("0")
  await noHorizontalScroll(page)
  // Mesa compartida de la última noche: sin datos del bancaje.
  await go(page, `/dashboard/sesiones/${ctx.sessionId}/mesas/${ctx.t25}`)
  await expect(page.getByTestId("poker-table")).toBeVisible()
  expect(await page.getByTestId("poker-table").innerText()).not.toMatch(
    /banc|financ|reserva|anticipo/i
  )
  // Sin sesión: los endpoints privados responden 401.
  const anon = await page
    .context()
    .browser()!
    .newContext({ baseURL: test.info().project.use.baseURL })
  expect(
    (await anon.request.get("/api/admin/banking/dashboard")).status()
  ).toBe(401)
  await anon.close()
})
