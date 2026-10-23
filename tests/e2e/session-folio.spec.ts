import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import { openSessionViaApi } from "./session-fixtures"

/**
 * Folios S-0001-YYYYMMDD y captura histórica (Chrome + iPhone), con la base
 * de PRUEBAS: SUPERADMIN registra una sesión de una fecha anterior mientras
 * hay una sesión normal abierta; la normal no cambia y la histórica no
 * tiene caja ni operación. PARTNER y CASHIER no pueden (ni por API).
 */
test.describe.configure({ mode: "serial" })

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })

/** Día YYYY-MM-DD en la zona del negocio, `daysAgo` días antes de hoy. */
function businessDay(daysAgo: number) {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Monterrey",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d)
  const [y, m, d] = fmt(new Date()).split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d - daysAgo)).toISOString().slice(0, 10)
}
const mx = (day: string) => day.split("-").reverse().join("/")
/** dd/mm/aa: formato corto de `formatDateTime` (es-MX). */
const mxShort = (day: string) => {
  const [y, m, d] = day.split("-")
  return `${d}/${m}/${y.slice(2)}`
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

let active = { id: "", folio: "" }
const historical = { id: "", folio: "" }
const pastDay = businessDay(9)

test("SUPERADMIN registra una sesión histórica sin alterar la sesión vigente", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  active = await openSessionViaApi(page.request)
  expect(active.folio).toMatch(/^S-\d{4,}-\d{8}$/)

  await page.goto("/dashboard/sesiones")
  await page.waitForLoadState("networkidle")
  // Con una sesión vigente, la captura histórica sigue disponible.
  await visible(page, "new-historical-session-link").click()
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "historical-toggle")).toBeChecked()
  await visible(page, "historical-date").fill(pastDay)
  await expect(visible(page, "historical-warning")).toContainText(
    "no se modificarán automáticamente caja ni inventario"
  )
  await expect(visible(page, "folio-preview")).toContainText(
    new RegExp(`S-\\d{4,}-${pastDay.replaceAll("-", "")}`)
  )
  await expect(visible(page, "folio-preview")).toContainText("provisional")
  await noHorizontalScroll(page)
  await visible(page, "create-session").click()
  const definitive = visible(page, "definitive-folio")
  await expect(definitive).toHaveText(
    new RegExp(`^S-\\d{4,}-${pastDay.replaceAll("-", "")}$`)
  )
  historical.folio = (await definitive.textContent())!.trim()
  await visible(page, "go-created-session").click()
  await expect(page).toHaveURL(/\/dashboard\/sesiones\/[A-Za-z0-9]+$/)
  historical.id = page.url().split("/").at(-1)!

  await expect(visible(page, "session-folio")).toHaveText(historical.folio)
  await expect(visible(page, "session-status")).toHaveText("Histórica")
  await expect(visible(page, "session-business-date")).toHaveText(mx(pastDay))
  // Fecha REAL de captura = hoy (no la fecha histórica).
  await expect(visible(page, "session-created-at")).toContainText(
    mxShort(businessDay(0))
  )
  await expect(visible(page, "historical-notice")).toBeVisible()
  // Sin operación en vivo: ni preparación, ni mesas, ni cierre.
  for (const id of ["go-preparation", "go-tables", "go-closure"])
    await expect(page.getByTestId(id)).toHaveCount(0)
  await noHorizontalScroll(page)

  // La sesión vigente no cambió y la histórica no tiene caja.
  const res = await page.request.get("/api/sessions/active")
  const body = await res.json()
  expect(body.data).toMatchObject({
    id: active.id,
    folio: active.folio,
    status: "OPEN",
  })
})

test("el listado filtra por fecha operativa y muestra el folio nuevo", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  await page.goto("/dashboard/sesiones")
  await page.waitForLoadState("networkidle")
  await visible(page, "filter-from").fill(pastDay)
  await visible(page, "filter-to").fill(pastDay)
  await visible(page, "filter-kind").selectOption("historical")
  await page.getByRole("button", { name: "Filtrar" }).click()
  await expect(page).toHaveURL(new RegExp(`from=${pastDay}`))
  const row = visible(page, "session-row").filter({ hasText: historical.folio })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(`Fecha operativa ${mx(pastDay)}`)
  // La sesión normal (fecha de hoy) no aparece en ese día.
  await expect(
    visible(page, "session-row").filter({ hasText: active.folio })
  ).toHaveCount(0)
  await noHorizontalScroll(page)
})

for (const role of ["partner", "cashier"] as const) {
  test(`${role.toUpperCase()} no puede crear sesiones históricas (ni manipulando la petición)`, async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users[role])
    await page.goto("/dashboard/sesiones/nueva")
    await page.waitForLoadState("networkidle")
    await expect(page.getByTestId("historical-toggle")).toHaveCount(0)
    await expect(page.getByTestId("historical-date")).toHaveCount(0)
    const res = await page.request.post("/api/sessions", {
      data: {
        idempotencyKey: randomUUID(),
        historical: true,
        businessDate: pastDay,
      },
    })
    expect(res.status()).toBe(403)
    const sneaky = await page.request.post("/api/sessions", {
      data: { idempotencyKey: randomUUID(), businessDate: pastDay },
    })
    expect(sneaky.status()).toBe(400)
    await noHorizontalScroll(page)
  })
}
