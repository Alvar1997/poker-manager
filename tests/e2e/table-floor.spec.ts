import { randomUUID } from "node:crypto"

import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Mesa interactiva (Chrome + iPhone), con la base de PRUEBAS: mesa ovalada
 * de nueve asientos con el dealer entre 7 y 6 → paño persistente → sentar
 * pendiente de compra → compra inicial en efectivo → recompra a crédito
 * (socio + firma + entrega) → cambio de asiento → transferencia a 10/10 →
 * dealer (asignar, cambiar, historial) → liquidación con firma y recepción
 * → retiro sin compra → reportes y auditoría → pantallas estrechas,
 * reintentos y concurrencia.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let t25 = ""
let t10 = ""
let suffix = ""
const player = { id: "", name: "" }

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

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function gotoTable(page: Page, tableId: string) {
  // El router.refresh() de la operación anterior puede registrar en WebKit
  // una navegación a la misma URL que interrumpe la nueva: se reintenta.
  const url = `/dashboard/sesiones/${sessionId}/mesas/${tableId}`
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
  await expect(page.getByTestId("poker-table")).toBeVisible()
}

/** Cajas de los nueve asientos y del dealer: ninguna se toca. */
async function assertNoOverlap(page: Page) {
  const boxes = []
  for (let n = 1; n <= 9; n++) {
    const b = await page.getByTestId(`seat-${n}`).boundingBox()
    expect(b, `asiento ${n}`).not.toBeNull()
    boxes.push({ id: `seat-${n}`, ...b! })
  }
  const d = await page.getByTestId("dealer-card").boundingBox()
  boxes.push({ id: "dealer", ...d! })
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const overlap =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      expect(overlap, `${a.id} con ${b.id}`).toBe(false)
    }
  // Táctiles: al menos 44 px de alto.
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44)
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

const seatState = (page: Page, n: number) =>
  page.getByTestId(`seat-${n}`).getAttribute("data-seat-state")

test("prepara la sesión con las dos mesas abiertas y un jugador del directorio", async ({
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
  for (const t of [t25, t10])
    await api(page, "post", `/api/sessions/${sessionId}/tables/${t}/open`, {
      idempotencyKey: randomUUID(),
    })
  suffix = `${testInfo.project.name === "chromium" ? "C" : "M"}${Date.now() % 100000}`
  player.name = `Peña Mesa ${suffix}`
  player.id = (await createE2EPlayer(page.request, player.name)).id
  // El paño de 25/25 empieza en verde (por si otra corrida lo cambió).
  const res = await page.request.patch(`/api/tables/${t25}/appearance`, {
    data: { feltColor: "CASINO_GREEN" },
  })
  expect(res.ok()).toBeTruthy()
})

test("mesa ovalada con nueve asientos, dealer dentro entre 7 y 6, sin superposiciones", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  for (let n = 1; n <= 9; n++)
    await expect(page.getByTestId(`seat-${n}`)).toHaveAttribute(
      "data-seat-state",
      "FREE"
    )
  const felt = (await page.getByTestId("table-felt").boundingBox())!
  const dealer = (await page.getByTestId("dealer-card").boundingBox())!
  const s6 = (await page.getByTestId("seat-6").boundingBox())!
  const s7 = (await page.getByTestId("seat-7").boundingBox())!
  const cx = dealer.x + dealer.width / 2
  // Dentro del óvalo, en la zona inferior y entre los asientos 7 y 6.
  expect(dealer.x).toBeGreaterThan(felt.x)
  expect(dealer.x + dealer.width).toBeLessThan(felt.x + felt.width)
  expect(dealer.y + dealer.height).toBeLessThan(felt.y + felt.height)
  expect(dealer.y).toBeGreaterThan(felt.y + felt.height / 2)
  expect(cx).toBeGreaterThan(s7.x + s7.width / 2)
  expect(cx).toBeLessThan(s6.x + s6.width / 2)
  await expect(page.getByTestId("dealer-card")).toHaveAttribute(
    "data-dealer",
    "NONE"
  )
  await assertNoOverlap(page)
  await noHorizontalScroll(page)
})

test("el color del paño cambia, persiste al recargar y es independiente por mesa", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("open-felt-settings").click()
  await visible(page, "felt-NAVY").click()
  await expect(page.getByTestId("poker-table")).toHaveAttribute(
    "data-felt",
    "NAVY"
  )
  await visible(page, "felt-WINE").click()
  await expect(page.getByTestId("poker-table")).toHaveAttribute(
    "data-felt",
    "WINE"
  )
  await page.keyboard.press("Escape")
  await page.reload()
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("poker-table")).toHaveAttribute(
    "data-felt",
    "WINE"
  )
  await gotoTable(page, t10)
  await expect(page.getByTestId("poker-table")).not.toHaveAttribute(
    "data-felt",
    "WINE"
  )
})

test("asiento libre → buscar sin acentos → sentar pendiente de compra (sin dinero ni fichas)", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("seat-3").click()
  const sheet = visible(page, "player-search-sheet")
  await sheet.getByTestId("seat-player-search").fill(`pena mesa ${suffix}`)
  await sheet
    .getByTestId("seat-candidate")
    .filter({ hasText: player.name })
    .click()
  await expect(sheet.getByTestId("selected-player")).toContainText(player.name)
  await sheet.getByTestId("confirm-seat").click()
  await expect(page.getByTestId("seat-3")).toHaveAttribute(
    "data-seat-state",
    "PENDING_BUY"
  )
  await expect(page.getByTestId("seat-3")).toContainText("Pend. compra")
  const purchases = await api<{ items: unknown[] }>(
    page,
    "get",
    `/api/purchases?sessionId=${sessionId}&playerId=${player.id}`
  )
  expect(purchases.items).toHaveLength(0)
})

test("compra inicial rápida en efectivo con confirmación física de entrega", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("seat-3").click()
  const seatSheet = visible(page, "seat-action-sheet")
  await expect(seatSheet.getByTestId("seat-buy")).toHaveText(/Compra inicial/)
  await seatSheet.getByTestId("seat-buy").click()
  const sheet = visible(page, "quick-purchase-sheet")
  await expect(sheet.getByTestId("quick-purchase-kind")).toHaveText(
    "Compra inicial"
  )
  await sheet.getByTestId("quick-amount-1000").click()
  await sheet.getByTestId("quick-method-CASH").check()
  await sheet.getByTestId("quick-cash-received").check()
  await sheet.getByTestId("quick-purchase-continue").click()
  await expect(sheet.getByTestId("progress-credit")).toHaveText(/\$0\.00/)
  await sheet.getByTestId("physical-delivery").check()
  await sheet.getByTestId("confirm-delivery").click()
  await expect(sheet.getByTestId("quick-purchase-done")).toContainText(
    "compra inicial"
  )
  await sheet.getByTestId("quick-purchase-close").click()
  await expect(page.getByTestId("seat-3")).toHaveAttribute(
    "data-seat-state",
    "PLAYING"
  )
})

test("recompra rápida a crédito: socio, firma en el celular y entrega", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("seat-3").click()
  const seatSheet = visible(page, "seat-action-sheet")
  await expect(seatSheet.getByTestId("seat-buy")).toHaveText(/\+ Recompra 1/)
  await seatSheet.getByTestId("seat-buy").click()
  const sheet = visible(page, "quick-purchase-sheet")
  await sheet.getByTestId("quick-amount-custom").fill("750")
  await sheet.getByTestId("quick-method-CREDIT").check()
  await sheet.getByTestId("quick-purchase-continue").click()
  await expect(sheet.getByTestId("progress-credit")).toHaveText(/750\.00/)
  const auth = sheet.getByTestId("credit-auth-form")
  await auth.locator("#partnerId").selectOption({ label: "Socio E2E" })
  await auth.getByText("Verbal").click()
  await auth.getByTestId("save-credit-auth").click()
  await expect(sheet.getByTestId("quick-signature-step")).toBeVisible()
  await sheet.getByTestId("summary-reviewed").check()
  await drawSignature(page)
  await sheet.getByTestId("signature-confirm").click()
  await sheet.getByTestId("physical-delivery").check()
  await sheet.getByTestId("confirm-delivery").click()
  await expect(sheet.getByTestId("quick-purchase-done")).toContainText(
    "recompra 1"
  )
  await sheet.getByTestId("quick-purchase-close").click()
  await expect(page.getByTestId("seat-3")).toHaveAttribute(
    "aria-label",
    /con crédito pendiente/
  )
  // Registro financiero real (Módulos 08 y 10).
  const report = await api<{
    items: {
      type: string
      rebuyNumber: number | null
      creditOriginated: string
    }[]
  }>(
    page,
    "get",
    `/api/reports/purchases?sessionId=${sessionId}&playerId=${player.id}`
  )
  expect(
    report.items.map((r) => [r.type, r.rebuyNumber, r.creditOriginated]).sort()
  ).toEqual([
    ["INITIAL_PURCHASE", null, "0.00"],
    ["REBUY", 1, "750.00"],
  ])
  const credit = await api<{ outstanding: string }>(
    page,
    "get",
    `/api/credits/players/${player.id}`
  )
  expect(credit.outstanding).toBe("750.00")
})

test("cambio de asiento: sin dinero ni fichas, conserva compras", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("seat-3").click()
  await visible(page, "seat-action-sheet").getByTestId("seat-change").click()
  const sheet = visible(page, "seat-change-sheet")
  await expect(sheet.getByTestId("pick-seat-3")).toBeDisabled()
  await sheet.getByTestId("pick-seat-8").click()
  await sheet.getByTestId("confirm-seat-change").click()
  await expect(page.getByTestId("seat-8")).toHaveAttribute(
    "data-seat-state",
    "PLAYING"
  )
  expect(await seatState(page, 3)).toBe("FREE")
  await page.getByTestId("seat-8").click()
  await expect(
    visible(page, "seat-action-sheet").getByTestId("seat-sheet-purchases")
  ).toHaveText(/2 \(1 recompra\)/)
})

test("mover de mesa a 10/10 en un asiento libre; la recompra sigue la secuencia", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await page.getByTestId("seat-8").click()
  await visible(page, "seat-action-sheet").getByTestId("seat-move").click()
  const sheet = visible(page, "table-transfer-sheet")
  await sheet
    .getByTestId("transfer-destination")
    .filter({ hasText: "10/10" })
    .click()
  await sheet.getByTestId("pick-seat-2").click()
  await sheet.getByTestId("confirm-transfer").click()
  await expect(page.getByTestId("seat-8")).toHaveAttribute(
    "data-seat-state",
    "FREE"
  )
  await gotoTable(page, t10)
  await expect(page.getByTestId("seat-2")).toHaveAttribute(
    "data-seat-state",
    "PLAYING"
  )
  await page.getByTestId("seat-2").click()
  await expect(
    visible(page, "seat-action-sheet").getByTestId("seat-buy")
  ).toHaveText(/\+ Recompra 2/)
})

test("dealer como persona: asignar, cambiar e historial", async ({ page }) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t10)
  const names = [`Dealer Uno ${suffix}`, `Dealer Dos ${suffix}`]
  for (const [i, name] of names.entries()) {
    await page.getByTestId("dealer-card").click()
    const sheet = visible(page, "dealer-sheet")
    await sheet.getByTestId(i === 0 ? "assign-dealer" : "change-dealer").click()
    await sheet.getByTestId("new-dealer").click()
    await sheet.locator("#dealer-name").fill(name)
    await sheet.getByTestId("save-dealer").click()
    await sheet.getByTestId("dealer-option").filter({ hasText: name }).click()
    await expect(sheet.getByTestId("dealer-current")).toContainText(name)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("dealer-card")).toHaveAttribute(
      "data-dealer",
      "ASSIGNED"
    )
  }
  await expect(page.getByTestId("dealer-card")).toContainText("DEALER")
  await page.getByTestId("dealer-card").click()
  const sheet = visible(page, "dealer-sheet")
  await sheet.getByTestId("dealer-history").click()
  const list = sheet.getByTestId("dealer-history-list")
  await expect(list.locator("li")).toHaveCount(2)
  await expect(list).toContainText("Reemplazado")
  await page.keyboard.press("Escape")
  // El dealer no ocupa asientos.
  expect(await seatState(page, 2)).toBe("PLAYING")
  for (const n of [1, 3, 4, 5, 6, 7, 8, 9])
    expect(await seatState(page, n)).toBe("FREE")
})

test("liquidar desde el asiento: firma, recepción física y asiento liberado", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await gotoTable(page, t10)
  await page.getByTestId("seat-2").click()
  await visible(page, "seat-action-sheet").getByTestId("seat-settle").click()
  const sheet = visible(page, "quick-settlement-sheet")
  const form = sheet.getByTestId("settlement-form")
  await form.getByTestId("returned-amount").fill("1200")
  await form.getByTestId("offset-NO_COMPENSATE").check()
  await expect(form.getByTestId("preview-net")).toBeVisible()
  await form.getByTestId("settlement-submit").click()
  await expect(sheet.getByTestId("quick-settlement-signature")).toBeVisible()
  await sheet.getByTestId("summary-reviewed").check()
  await drawSignature(page)
  await sheet.getByTestId("signature-confirm").click()
  await expect(sheet.getByTestId("quick-confirm-return")).toBeVisible()
  await sheet.getByTestId("chips-received").check()
  await sheet.getByTestId("confirm-return").click()
  await expect(sheet.getByTestId("quick-settlement-done")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("seat-2")).toHaveAttribute(
    "data-seat-state",
    "FREE"
  )
  await expect(page.getByTestId("settling-payout")).toContainText(
    player.name.split(" ")[0]
  )
  // Módulo 11: la liquidación existe con la recepción confirmada.
  const list = await api<{
    items: { player: { id: string }; status: string }[]
  }>(page, "get", `/api/settlements?sessionId=${sessionId}`)
  expect(list.items.find((s) => s.player.id === player.id)?.status).toBe(
    "PENDING_PAYOUT"
  )
})

test("retiro sin compra libera el asiento", async ({ page }) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const p = await createE2EPlayer(page.request, `Retiro ${suffix}`)
  await api(
    page,
    "post",
    `/api/sessions/${sessionId}/tables/${t25}/seats/5/assign`,
    { playerId: p.id, idempotencyKey: randomUUID() }
  )
  await gotoTable(page, t25)
  await page.getByTestId("seat-5").click()
  const sheet = visible(page, "seat-action-sheet")
  await expect(sheet.getByTestId("seat-settle")).toHaveCount(0)
  await sheet.getByTestId("seat-withdraw").click()
  await sheet.getByTestId("withdraw-reason").fill("Se fue antes de comprar")
  await sheet.getByTestId("confirm-withdraw").click()
  await expect(page.getByTestId("seat-5")).toHaveAttribute(
    "data-seat-state",
    "FREE"
  )
})

test("auditoría de la mesa en el Módulo 15", async ({ page }) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(
    `/dashboard/administracion/auditoria?module=TABLES&sessionId=${sessionId}&pageSize=100`
  )
  await page.waitForLoadState("networkidle")
  for (const action of [
    "SEAT_ASSIGNED",
    "PLAYER_SEATED_PENDING_BUY",
    "SEAT_CHANGED",
    "SEAT_RELEASED",
    "TABLE_PLAYER_TRANSFERRED",
    "DEALER_ASSIGNED",
    "DEALER_CHANGED",
    "TABLE_PARTICIPATION_WITHDRAWN",
  ])
    await expect(
      page.getByText(action, { exact: true }).filter({ visible: true }).first()
    ).toBeVisible()
})

test("pantalla estrecha (320 px): mesa completa, táctil y sin desplazamiento horizontal", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await page.setViewportSize({ width: 320, height: 640 })
  await login(page, users.cashier)
  await gotoTable(page, t25)
  await assertNoOverlap(page)
  await noHorizontalScroll(page)
  // Paño distinto también legible: el nombre de la mesa sigue visible.
  await expect(page.getByTestId("felt-table-name")).toBeVisible()
})

test("reintentos y concurrencia: un asiento, un ocupante; la misma clave no duplica", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const [a, b] = [
    await createE2EPlayer(page.request, `Carrera A ${suffix}`),
    await createE2EPlayer(page.request, `Carrera B ${suffix}`),
  ]
  const url = `/api/sessions/${sessionId}/tables/${t25}/seats/9/assign`
  const [r1, r2] = await Promise.all([
    page.request.post(url, {
      data: { playerId: a.id, idempotencyKey: randomUUID() },
    }),
    page.request.post(url, {
      data: { playerId: b.id, idempotencyKey: randomUUID() },
    }),
  ])
  expect([r1.status(), r2.status()].sort()).toEqual([201, 409])
  // Reintento con la misma clave (doble toque): mismo resultado, sin duplicar.
  const k = randomUUID()
  const c = await createE2EPlayer(page.request, `Doble ${suffix}`)
  const seat1 = `/api/sessions/${sessionId}/tables/${t25}/seats/1/assign`
  const first = await page.request.post(seat1, {
    data: { playerId: c.id, idempotencyKey: k },
  })
  const again = await page.request.post(seat1, {
    data: { playerId: c.id, idempotencyKey: k },
  })
  expect([first.status(), again.status()]).toEqual([201, 200])
  const board = await api<{
    seats: { seatNumber: number; occupant: unknown }[]
  }>(page, "get", `/api/sessions/${sessionId}/tables/${t25}/seats`)
  expect(
    board.seats.filter((s) => s.occupant).map((s) => s.seatNumber)
  ).toEqual([1, 9])
})
