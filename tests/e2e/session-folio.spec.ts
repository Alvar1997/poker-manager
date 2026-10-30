import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"
import {
  completeOpeningViaApi,
  ensureInventoryInitialized,
  openSessionViaApi,
  resetActiveSessions,
} from "./session-fixtures"

/**
 * Folios S-0001-YYYYMMDD y sesiones de fecha anterior (Chrome + iPhone), con
 * la base de PRUEBAS: SUPERADMIN crea una sesión de una fecha anterior que
 * se abre (conteo, caja $0, mesa) y opera como una de hoy, conservando su
 * fecha operativa. PARTNER y CASHIER no pueden (ni por API).
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

test("SUPERADMIN crea una sesión de fecha anterior y la opera como una de hoy", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  await resetActiveSessions()
  await ensureInventoryInitialized(page.request)

  await page.goto("/dashboard/sesiones/nueva")
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "mode-new")).toBeChecked()
  await visible(page, "historical-toggle").check()
  await visible(page, "historical-date").fill(pastDay)
  await visible(page, "historical-time").fill("20:00")
  await expect(visible(page, "historical-warning")).toContainText(
    "igual que una de hoy"
  )
  await expect(visible(page, "folio-preview")).toContainText(
    new RegExp(`S-\\d{4,}-${pastDay.replaceAll("-", "")}`)
  )
  await expect(visible(page, "folio-preview")).toContainText("provisional")
  await noHorizontalScroll(page)
  await visible(page, "create-session").click()
  // Misma apertura que una sesión de hoy.
  await expect(page).toHaveURL(/\/dashboard\/sesiones\/[A-Za-z0-9]+\/apertura/)
  historical.id = page.url().split("/").at(-2)!
  const folio = visible(page, "opening-folio")
  await expect(folio).toHaveText(
    new RegExp(`^S-\\d{4,}-${pastDay.replaceAll("-", "")}$`)
  )
  historical.folio = (await folio.textContent())!.trim()
  // Aviso fijo de jornada histórica y hora operativa de apertura.
  await expect(visible(page, "historical-banner")).toContainText(
    "JORNADA HISTÓRICA"
  )
  await expect(visible(page, "opening-mode")).toHaveText("Jornada histórica")
  await expect(visible(page, "opening-operated-at")).toContainText(
    /\b(8:00|20:00)\b/
  )

  // Conteo, caja $0 y apertura con la mesa 25/25 preparada.
  const tables = await (
    await page.request.get(`/api/sessions/${historical.id}/tables`)
  ).json()
  const t25 = (tables.data as { tableId: string; code: string }[]).find(
    (t) => t.code === "TABLE_25_25"
  )!.tableId
  await completeOpeningViaApi(page.request, historical.id, {
    tableIds: [t25],
  })

  await page.goto(`/dashboard/sesiones/${historical.id}`)
  await page.waitForLoadState("networkidle")
  await expect(visible(page, "session-folio")).toHaveText(historical.folio)
  await expect(visible(page, "session-status")).toHaveText("Abierta")
  await expect(visible(page, "session-business-date")).toHaveText(mx(pastDay))
  // Fecha REAL de captura = hoy (no la fecha operativa).
  await expect(visible(page, "session-created-at")).toContainText(
    mxShort(businessDay(0))
  )
  await expect(visible(page, "historical-notice")).toContainText(
    "Se opera completa"
  )
  await expect(visible(page, "go-tables")).toBeVisible()
  await expect(visible(page, "go-closure")).toBeVisible()
  await noHorizontalScroll(page)
  const after = await (
    await page.request.get(`/api/sessions/${historical.id}/tables`)
  ).json()
  expect(
    (after.data as { code: string; status: string }[]).find(
      (t) => t.code === "TABLE_25_25"
    )?.status
  ).toBe("OPEN")

  // Ocupa la sesión vigente.
  const res = await page.request.get("/api/sessions/active")
  expect((await res.json()).data).toMatchObject({
    id: historical.id,
    status: "OPEN",
  })
  // Para el listado: una sesión normal de hoy.
  active = await openSessionViaApi(page.request)
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
  test(`${role.toUpperCase()} no puede crear sesiones de fecha anterior (ni manipulando la petición)`, async ({
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
        openingTime: "20:00",
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
