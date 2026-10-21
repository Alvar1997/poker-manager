import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 07 — mesas y participación con una sesión REAL abierta por API con
 * el flujo del Módulo 06 (fixture solo en la base de pruebas). Cada proyecto
 * abre su propia sesión y crea su jugador de prueba.
 */
test.describe.configure({ mode: "serial" })

let sessionId = ""
let playerName = ""

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const card = (page: Page, name: string) =>
  visible(page, "session-table-card").filter({ hasText: name })

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function tableIds(page: Page) {
  const res = await page.request.get(`/api/sessions/${sessionId}/tables`)
  const tables = (await res.json()).data as { tableId: string; name: string }[]
  return {
    t25: tables.find((t) => t.name === "Mesa 25/25")!.tableId,
    t10: tables.find((t) => t.name === "Mesa 10/10")!.tableId,
  }
}

test("con la sesión abierta, abre 25/25 y registra un jugador", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  sessionId = (await openSessionViaApi(page.request)).id
  playerName = `Jugador Mesa ${testInfo.project.name} ${Date.now() % 100000}`
  await createE2EPlayer(page.request, playerName)

  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await page.waitForLoadState("networkidle")
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Sin abrir"
  )
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Sin abrir"
  )
  await card(page, "Mesa 25/25").getByTestId("table-open").click()
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  await expect(card(page, "Mesa 25/25").getByTestId("table-cycle")).toHaveText(
    "1"
  )

  const { t25 } = await tableIds(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await page
    .getByLabel("Agregar jugador")
    .filter({ visible: true })
    .fill(playerName)
  await visible(page, "player-search-results")
    .getByTestId("add-player")
    .first()
    .click()
  await expect(
    visible(page, "participant-row").filter({ hasText: playerName })
  ).toBeVisible()
  await noHorizontalScroll(page)
})

test("abre 10/10 y rechaza registrar al mismo jugador en ambas mesas", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await page.waitForLoadState("networkidle")
  await card(page, "Mesa 10/10").getByTestId("table-open").click()
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  const { t10 } = await tableIds(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t10}/jugadores`)
  await page.waitForLoadState("networkidle")
  await page
    .getByLabel("Agregar jugador")
    .filter({ visible: true })
    .fill(playerName)
  await visible(page, "player-search-results")
    .getByTestId("add-player")
    .first()
    .click()
  await expect(
    page.getByText(/ya se encuentra activo en la Mesa 25\/25/).first()
  ).toBeVisible()
  await expect(visible(page, "participant-row")).toHaveCount(0)
})

test("transfiere al jugador 25/25 → 10/10 sin cobros ni fichas y queda en el historial", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const { t25, t10 } = await tableIds(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/jugadores`)
  await page.waitForLoadState("networkidle")
  await visible(page, "participant-row")
    .filter({ hasText: playerName })
    .getByTestId("transfer-player")
    .click()
  await expect(page.getByTestId("transfer-notice")).toContainText(
    "El jugador conservará sus fichas. Esta operación no genera cobros, pagos ni movimientos de inventario."
  )
  await page.getByTestId("confirm-transfer").click()
  await expect(
    page.getByText("La transferencia se realizó correctamente.").first()
  ).toBeVisible()
  await expect(visible(page, "participant-row")).toHaveCount(0)

  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t10}/jugadores`)
  await expect(
    visible(page, "participant-row").filter({ hasText: playerName })
  ).toBeVisible()
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/historial`)
  await expect(
    visible(page, "table-event").filter({ hasText: "se cambió a Mesa 10/10" })
  ).toBeVisible()
})

test("no cierra una mesa con jugadores activos; cierra la vacía y la reabre con un ciclo nuevo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await page.waitForLoadState("networkidle")
  await card(page, "Mesa 10/10").getByTestId("table-close").click()
  await page.getByTestId("confirm-close-table").click()
  await expect(
    page
      .getByText(/No puedes cerrar esta mesa mientras tenga jugadores activos/)
      .first()
  ).toBeVisible()
  await expect(card(page, "Mesa 10/10").getByTestId("table-status")).toHaveText(
    "Abierta"
  )

  await page.keyboard.press("Escape")
  await card(page, "Mesa 25/25").getByTestId("table-close").click()
  await page.getByTestId("confirm-close-table").click()
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Cerrada"
  )
  await card(page, "Mesa 25/25").getByTestId("table-open").click()
  await expect(card(page, "Mesa 25/25").getByTestId("table-status")).toHaveText(
    "Abierta"
  )
  await expect(card(page, "Mesa 25/25").getByTestId("table-cycle")).toHaveText(
    "2"
  )

  const { t25 } = await tableIds(page)
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas/${t25}/historial`)
  await expect(visible(page, "table-cycle-row")).toHaveCount(2)
  // Sin importes financieros ficticios en las pantallas de mesas.
  await page.goto(`/dashboard/sesiones/${sessionId}/mesas`)
  await expect(page.getByText(/saldo|cobrado|compras de/i)).toHaveCount(0)
  await noHorizontalScroll(page)
})
