import { expect, test, type Page } from "@playwright/test"

import { login, requireE2EUsers } from "./helpers"

/**
 * Módulo 02 — Configuración, con sesión real en escritorio y iPhone.
 * Ningún paso crea dinero, existencias ni folios.
 */

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function sectionIds(page: Page) {
  return page
    .locator("[data-section-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-section-id")))
}

test.describe("Configuración — SUPERADMIN", () => {
  test("/configuracion lleva al panel con las 9 secciones y avisos pendientes", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)

    await page.goto("/configuracion")
    await expect(page).toHaveURL(/\/dashboard\/configuracion$/)
    expect(await sectionIds(page)).toEqual([
      "general",
      "caja",
      "mesas",
      "fichas",
      "pagos",
      "banco",
      "folios",
      "reglas",
      "whatsapp",
    ])
    await expect(
      page
        .locator('[data-section-id="whatsapp"]')
        .getByText("Pendiente de configuración")
    ).toBeVisible()
    await expectNoHorizontalScroll(page)
  })

  test("las mesas iniciales usan juegos físicos distintos", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)
    await page.goto("/dashboard/configuracion/mesas")

    const t25 = page
      .getByTestId("table-card")
      .filter({ hasText: "TABLE_25_25" })
    const t10 = page
      .getByTestId("table-card")
      .filter({ hasText: "TABLE_10_10" })
    await expect(t25.getByTestId("table-chip-set")).toHaveText(
      "Fichas Mesa 25/25"
    )
    await expect(t10.getByTestId("table-chip-set")).toHaveText(
      "Fichas Mesa 10/10"
    )
    await expect(t25.getByTestId("table-blinds")).toHaveText("$25.00 / $25.00")
    await expect(page.getByRole("button", { name: "Nueva mesa" })).toBeVisible()
    await expectNoHorizontalScroll(page)
  })

  test("agrega una denominación y rechaza el duplicado en el mismo juego", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    // Valor distinto por proyecto: ambos comparten la base en la misma corrida.
    const value = testInfo.project.name === "chromium" ? "25" : "50"
    await login(page, users.superadmin)
    await page.goto("/dashboard/configuracion/fichas")
    await page
      .getByTestId("chip-set-card")
      .filter({ hasText: "CHIPSET_25_25" })
      .click()
    await expect(
      page.getByRole("heading", { name: /Fichas Mesa 25\/25/ })
    ).toBeVisible()

    const add = async () => {
      await page.getByRole("button", { name: "Agregar denominación" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByLabel("Valor (MXN)").fill(value)
      await dialog.getByLabel("Color").fill("Verde")
      await dialog.getByRole("button", { name: "Agregar" }).click()
      return dialog
    }

    await add()
    await expect(page.getByText("Denominación agregada")).toBeVisible()
    await expect(
      page.getByTestId("denomination-row").filter({ hasText: `$${value}.00` })
    ).toBeVisible()

    const dialog = await add()
    await expect(
      page.getByText("Este juego ya tiene una denominación con ese valor")
    ).toBeVisible()
    await dialog.press("Escape")
    await expect(
      page.getByTestId("denomination-row").filter({ hasText: `$${value}.00` })
    ).toHaveCount(1)
    await expectNoHorizontalScroll(page)
  })

  test("WhatsApp aparece pendiente, sin número ni acciones de envío", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)
    await page.goto("/dashboard/configuracion/whatsapp")

    await expect(page.getByTestId("whatsapp-status")).toHaveText(
      "Pendiente de configuración"
    )
    await expect(page.getByText("No configurado")).toBeVisible()
    await expect(page.getByTestId("whatsapp-notice")).toContainText(
      "No se necesitan datos reales para finalizar el Módulo 02"
    )
    await expect(
      page.getByRole("button", { name: /enviar|conectar|verificar/i })
    ).toHaveCount(0)
  })

  test("la cuenta bancaria aparece pendiente de captura y los folios con vista previa", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)
    await page.goto("/dashboard/configuracion/banco")
    await expect(page.getByTestId("bank-pending")).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.goto("/dashboard/configuracion/folios")
    await expect(page.getByTestId("folio-card")).toHaveCount(7)
    await expect(
      page
        .getByTestId("folio-card")
        .filter({ hasText: "Sesiones" })
        .getByTestId("folio-preview")
    ).toHaveText("SES-000001")
  })
})

test.describe("Configuración — PARTNER (consulta)", () => {
  test("ve todas las secciones en modo solo consulta y no puede modificar", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.partner)
    await page.goto("/dashboard/configuracion")
    expect(await sectionIds(page)).toHaveLength(9)

    await page.goto("/dashboard/configuracion/mesas")
    await expect(page.getByTestId("read-only-badge")).toBeVisible()
    await expect(page.getByRole("button", { name: "Nueva mesa" })).toHaveCount(
      0
    )
    await expect(page.getByRole("button", { name: /Editar/ })).toHaveCount(0)

    const patch = await page.request.patch("/api/settings/general", {
      data: { businessName: "Intento de socio" },
    })
    expect(patch.status()).toBe(403)
    const bank = await page.request.get("/api/settings/bank-account")
    expect(bank.status()).toBe(200)
  })
})

test.describe("Configuración — CASHIER (catálogos)", () => {
  test("ve solo los catálogos para operar; banco y folios están denegados", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.cashier)
    await page.goto("/dashboard/configuracion")
    expect(await sectionIds(page)).toEqual([
      "general",
      "mesas",
      "fichas",
      "pagos",
      "reglas",
    ])

    await page.goto("/dashboard/configuracion/banco")
    await expect(page).toHaveURL(/\/dashboard\/access-denied/)

    expect(
      (await page.request.get("/api/settings/bank-account")).status()
    ).toBe(403)
    expect((await page.request.get("/api/settings/folios")).status()).toBe(403)
    expect((await page.request.get("/api/payment-methods")).status()).toBe(200)

    await page.goto("/dashboard/configuracion/reglas")
    await expect(
      page.getByTestId("operational-rules").locator("li")
    ).toHaveCount(16)
    await expectNoHorizontalScroll(page)
  })
})
