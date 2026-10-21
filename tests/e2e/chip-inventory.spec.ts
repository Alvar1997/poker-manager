import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

import { login, navigation, requireE2EUsers } from "./helpers"

/**
 * Módulo 04 — Inventario de fichas con sesión real. Hay UN inventario
 * físico compartido por ambas mesas: los dos proyectos (Chrome e iPhone)
 * operan sobre el mismo. El inventario inicial se registra una sola vez:
 * lo hace el primer proyecto que corre y el otro lo encuentra inicializado.
 * Las pruebas de este archivo se ejecutan en orden.
 */
test.describe.configure({ mode: "serial" })

const SHARED_NAME = "Inventario General de Fichas"
const SHARED_CONTAINER = "INVENTARIO-GENERAL"

/**
 * El router de Next 16 puede conservar en el DOM copias OCULTAS de rutas
 * visitadas; los localizadores de estas pruebas se limitan a lo visible.
 */
const testId = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })
const label = (page: Page, ...args: Parameters<Page["getByLabel"]>) =>
  page.getByLabel(...args).filter({ visible: true })
const role = (page: Page, ...args: Parameters<Page["getByRole"]>) =>
  page.getByRole(...args).filter({ visible: true })

async function press(target: Locator, testInfo: TestInfo) {
  if (testInfo.project.use.hasTouch) await target.tap()
  else await target.click()
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function openSet(page: Page) {
  await page.goto("/inventario/fichas")
  await testId(page, "inventory-card").filter({ hasText: SHARED_NAME }).click()
  await expect(
    role(page, "heading", { name: SHARED_NAME, level: 1 })
  ).toBeVisible()
}

/** Fichas bajo custodia: suma de la composición por denominación (exacta: sin compras en E2E). */
async function custodyTotal(page: Page) {
  await openSet(page)
  const cells = testId(page, "stock-custody")
  await expect(cells.first()).toBeVisible()
  const texts = await cells.allInnerTexts()
  return texts.reduce((acc, t) => acc + Number(t.replace(/\D/g, "")), 0)
}

test("tablero: un solo inventario común, desde la navegación", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const nav = await navigation(page)
  await nav.getByRole("link", { name: "Inventario de fichas" }).click()
  await expect(page).toHaveURL(/\/dashboard\/inventario\/fichas$/)

  // Nunca dos saldos físicos como inventarios independientes.
  const cards = testId(page, "inventory-card")
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText(SHARED_NAME)
  await expect(cards).toContainText(SHARED_CONTAINER)
  await expect(page.getByText("Fichas Mesa 25/25")).toHaveCount(0)
  await expect(page.getByText("Fichas Mesa 10/10")).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("registra el inventario inicial del juego", async ({ page }, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await openSet(page)
  const register = role(page, "link", { name: "Registrar inventario inicial" })
  if ((await register.count()) === 0) {
    // El otro proyecto ya lo registró: el inventario común es uno solo.
    expect(await custodyTotal(page)).toBeGreaterThan(0)
    await expect(
      role(page, "link", { name: "Registrar inventario inicial" })
    ).toHaveCount(0)
    return
  }
  await press(register, testInfo)
  await page.waitForLoadState("networkidle")

  const inputs = role(page, "textbox")
  await expect(inputs.first()).toBeVisible()
  const n = await inputs.count()
  expect(n).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) await inputs.nth(i).pressSequentially("100")
  await noHorizontalScroll(page)
  await press(role(page, "button", { name: "Revisar y confirmar" }), testInfo)
  await expect(testId(page, "confirm-summary")).toContainText("Total nominal")
  await press(testId(page, "confirm-submit"), testInfo)

  await expect(
    role(page, "heading", { name: SHARED_NAME, level: 1 })
  ).toBeVisible()
  expect(await custodyTotal(page)).toBe(n * 100)
  await expect(
    page.getByText(SHARED_CONTAINER).filter({ visible: true })
  ).toBeVisible()
})

test("registra una entrada y una baja con motivo", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  const before = await custodyTotal(page)

  await page.goto("/inventario/fichas/entrada")
  await page.waitForLoadState("networkidle")
  await expect(testId(page, "shared-inventory")).toContainText(SHARED_NAME)
  await role(page, "textbox", { name: /Cantidad de/ })
    .first()
    .pressSequentially("10")
  await label(page, "Motivo").fill("Reposición de fichas nuevas")
  await press(role(page, "button", { name: "Revisar entrada" }), testInfo)
  await press(testId(page, "confirm-submit"), testInfo)
  await expect(
    page.getByText("Entrada registrada").filter({ visible: true })
  ).toBeVisible()

  await page.goto("/inventario/fichas/baja")
  await page.waitForLoadState("networkidle")
  await expect(testId(page, "shared-inventory")).toContainText(SHARED_NAME)
  await label(page, "Causa de la baja").selectOption("DAMAGE")
  await role(page, "textbox", { name: /Cantidad de/ })
    .first()
    .pressSequentially("3")
  await label(page, "Motivo").fill("Fichas despostilladas")
  await press(role(page, "button", { name: "Revisar baja" }), testInfo)
  await expect(testId(page, "confirm-summary")).toContainText("−3")
  await press(testId(page, "confirm-submit"), testInfo)
  await expect(
    page.getByText("Baja registrada").filter({ visible: true })
  ).toBeVisible()
  // La confirmación navega al detalle: esperar a que termine antes de otro goto.
  await page.waitForLoadState("networkidle")

  expect(await custodyTotal(page)).toBe(before + 10 - 3)
})

test("un ajuste exige motivo y muestra el antes y el después", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto("/inventario/fichas/ajustes")
  await page.waitForLoadState("networkidle")
  await expect(testId(page, "shared-inventory")).toContainText(SHARED_NAME)
  const denomination = label(page, "Denominación")
  await denomination.selectOption({ index: 1 })
  await label(page, "Tipo de ajuste").selectOption("SHORTAGE")
  await label(page, "Cantidad de fichas").pressSequentially("1")
  await expect(testId(page, "adjustment-preview")).toContainText("→")

  await press(role(page, "button", { name: "Revisar ajuste" }), testInfo)
  await expect(
    page.getByText(/El motivo es obligatorio/).filter({ visible: true })
  ).toBeVisible()
  await label(page, "Motivo").fill(
    "Faltante encontrado al revisar el inventario"
  )
  await press(role(page, "button", { name: "Revisar ajuste" }), testInfo)
  await press(testId(page, "confirm-submit"), testInfo)
  await expect(
    page.getByText("Ajuste registrado").filter({ visible: true })
  ).toBeVisible()
})

test("el historial muestra los movimientos con usuario y motivo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  await page.goto("/inventario/fichas/movimientos")
  const rows = testId(page, "movement-row")
  await expect(
    rows.filter({ hasText: "Reposición de fichas nuevas" }).first()
  ).toBeVisible()
  await expect(
    rows.filter({ hasText: "Fichas despostilladas" }).first()
  ).toContainText("Cajero E2E")
  await expect(
    rows.filter({ hasText: "Faltante encontrado" }).first()
  ).toContainText("Socio E2E")

  // El filtro de mesa solo consulta: las existencias son comunes.
  await expect(label(page, "Mesa")).toBeVisible()
  await label(page, "Tipo").selectOption("STOCK_WITHDRAWAL")
  await role(page, "button", { name: "Filtrar" }).click()
  await expect(rows.first()).toContainText("Baja")
  await noHorizontalScroll(page)
})

test("arqueo: captura, diferencia por denominación, confirmación y conciliación", async ({
  page,
}, testInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/inventario/fichas/arqueos/nuevo")
  await page.waitForLoadState("networkidle")
  const card = page
    .locator("li")
    .filter({ hasText: SHARED_NAME, visible: true })
  await press(
    card.getByRole("button", { name: /Iniciar arqueo|Continuar arqueo/ }),
    testInfo
  )
  await expect(page).toHaveURL(/\/arqueos\/[a-z0-9]+$/)
  await page.waitForLoadState("networkidle")

  const lines = testId(page, "count-line")
  // Navegación del lado cliente: la URL cambia antes que el contenido.
  await expect(lines.first()).toBeVisible()
  const n = await lines.count()
  for (let i = 0; i < n; i++) {
    const expectedText = await lines.nth(i).locator("p").innerText()
    const expected = Number(
      // Tras entregas por importe (compras), la composición es solo una
      // referencia hasta el siguiente arqueo: «Referencia N» en vez de «Esperado N».
      expectedText
        .match(/(?:Esperado|Referencia) ([\d,]+)/)![1]
        .replace(/,/g, "")
    )
    // Primera denominación: faltan 2 fichas.
    await lines
      .nth(i)
      .getByRole("textbox")
      .pressSequentially(String(i === 0 ? expected - 2 : expected))
  }
  await expect(testId(page, "count-diff").first()).toContainText(
    "Diferencia -2"
  )
  await noHorizontalScroll(page)

  await press(role(page, "button", { name: "Guardar borrador" }), testInfo)
  await expect(
    page.getByText(/Conteo guardado/).filter({ visible: true })
  ).toBeVisible()
  await press(role(page, "button", { name: "Confirmar conteo" }), testInfo)
  await expect(testId(page, "confirm-summary")).toContainText("-2")
  await press(testId(page, "confirm-submit"), testInfo)

  await expect(testId(page, "count-status")).toHaveText("Confirmado")
  await expect(testId(page, "count-reconciliation")).toHaveText(
    "Diferencias pendientes"
  )

  const before = await page.evaluate(() => location.href)
  await label(page, "Motivo").fill(
    "Faltante confirmado tras recontar dos veces"
  )
  await press(
    role(page, "button", { name: "Revisar ajuste de conciliación" }),
    testInfo
  )
  await press(testId(page, "confirm-submit"), testInfo)
  await expect(testId(page, "count-reconciliation")).toHaveText("Conciliado")
  await expect(testId(page, "reconcile-panel")).toHaveCount(0)
  expect(page.url()).toBe(before)

  // El tablero ya no muestra diferencias pendientes en el inventario común.
  await page.goto("/inventario/fichas")
  await expect(
    testId(page, "inventory-card")
      .filter({ hasText: SHARED_NAME })
      .getByTestId("inventory-pending-differences")
  ).toHaveCount(0)
})

test("permisos: el cajero opera inventario pero no edita el catálogo; sin sesión, 401", async ({
  page,
}) => {
  const users = requireE2EUsers()
  expect((await page.request.get("/api/chip-inventory")).status()).toBe(401)

  await login(page, users.cashier)
  expect((await page.request.get("/api/chip-inventory")).status()).toBe(200)
  const inventory = (
    await (await page.request.get("/api/chip-inventory")).json()
  ).data as {
    chipSet: { name: string }
    denominations: { denominationId: string }[]
  }[]
  const set = inventory.find((s) => s.chipSet.name === SHARED_NAME)!
  const patch = await page.request.patch(
    `/api/denominations/${set.denominations[0].denominationId}`,
    {
      data: { value: "999" },
    }
  )
  expect(patch.status()).toBe(403)
  await openSet(page)
  await expect(role(page, "link", { name: "Ajuste" })).toBeVisible()
})
