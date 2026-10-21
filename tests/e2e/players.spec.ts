import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

import { login, navigation, requireE2EUsers } from "./helpers"

/**
 * Módulo 03 — Jugadores con sesión real, en escritorio y en iPhone (táctil).
 * Teléfonos SINTÉTICOS aleatorios (+52 871 …) que solo existen en la base
 * de pruebas; nunca se envía nada a WhatsApp.
 */

/** "871 XXX XXXX": el mismo agrupamiento con que la app lo muestra. */
function randomPhone() {
  const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999))
  return `871 ${digits.slice(0, 3)} ${digits.slice(3)}`
}

/** En iPhone se toca; en escritorio, clic. */
async function press(target: Locator, testInfo: TestInfo) {
  if (testInfo.project.use.hasTouch) await target.tap()
  else await target.click()
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function createPlayer(
  page: Page,
  testInfo: TestInfo,
  data: { name: string; phone: string; nickname?: string }
) {
  await page.goto("/dashboard/jugadores/nuevo")
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Nombre completo").fill(data.name)
  if (data.nickname)
    await page.getByLabel("Apodo (opcional)").fill(data.nickname)
  // Teclado virtual: escribir carácter por carácter.
  await page
    .getByLabel("Teléfono", { exact: true })
    .pressSequentially(data.phone)
  await press(page.getByRole("button", { name: "Registrar jugador" }), testInfo)
}

test.describe("Jugadores", () => {
  test("directorio desde la navegación, con diseño móvil", async ({ page }) => {
    const users = requireE2EUsers()
    await login(page, users.cashier)
    const nav = await navigation(page)
    await nav.getByRole("link", { name: "Jugadores" }).click()

    await expect(page).toHaveURL(/\/dashboard\/jugadores$/)
    await expect(
      page.getByRole("heading", { name: "Jugadores", level: 1 })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Nuevo jugador" })
    ).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.goto("/jugadores")
    await expect(page).toHaveURL(/\/dashboard\/jugadores$/)
  })

  test("valida el teléfono, crea, busca y detecta duplicados", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    const phone = randomPhone()
    const name = `Jugador E2E ${testInfo.project.name} ${Date.now()}`
    await login(page, users.cashier)

    // Teléfono requerido / inválido.
    await page.goto("/dashboard/jugadores/nuevo")
    await page.waitForLoadState("networkidle")
    await page.getByLabel("Nombre completo").fill(name)
    await press(
      page.getByRole("button", { name: "Registrar jugador" }),
      testInfo
    )
    await expect(
      page.getByText("El teléfono es obligatorio", { exact: true })
    ).toBeVisible()
    await page.getByLabel("Teléfono", { exact: true }).fill("12345")
    await press(
      page.getByRole("button", { name: "Registrar jugador" }),
      testInfo
    )
    await expect(page.getByText(/Teléfono inválido/)).toBeVisible()

    // Número válido: vista previa normalizada y el consentimiento inicia desmarcado.
    await page.getByLabel("Teléfono", { exact: true }).fill(phone)
    await expect(page.getByTestId("phone-preview")).toHaveText(`+52 ${phone}`)
    await expect(
      page.getByTestId("whatsapp-consent-checkbox")
    ).not.toBeChecked()
    await expectNoHorizontalScroll(page)
    await press(
      page.getByRole("button", { name: "Registrar jugador" }),
      testInfo
    )

    await expect(page).toHaveURL(/\/dashboard\/jugadores\/[a-z0-9]+$/)
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    await expect(page.getByTestId("player-phone")).toHaveText(`+52 ${phone}`)
    await expect(page.getByTestId("consent-status")).toHaveText(
      "Sin consentimiento"
    )
    await expect(page.getByTestId("history-placeholders")).toContainText(
      "Disponible cuando se implemente el módulo de compras"
    )
    await expect(page.getByText("$0")).toHaveCount(0)
    const profileUrl = page.url()

    // Buscar por teléfono (en otro formato).
    await page.goto("/dashboard/jugadores")
    await page
      .getByLabel("Buscar jugadores")
      .filter({ visible: true })
      .fill(phone.replace(/\s/g, "-"))
    await press(page.getByRole("button", { name: "Buscar" }), testInfo)
    await expect(
      page.getByTestId("player-card").filter({ hasText: name, visible: true })
    ).toHaveCount(1)

    // Duplicado con otro formato del mismo número.
    await createPlayer(page, testInfo, {
      name: "Otro nombre",
      phone: `+52${phone.replace(/\s/g, "")}`,
    })
    await expect(
      page.getByText("Ya existe un jugador registrado con ese teléfono")
    ).toBeVisible()
    await page.getByTestId("duplicate-link").click()
    await expect(page).toHaveURL(profileUrl)
  })

  test("edita apodo y teléfono; el SUPERADMIN ve el historial", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    const phone = randomPhone()
    const newPhone = randomPhone()
    const name = `Editable ${testInfo.project.name} ${Date.now()}`
    await login(page, users.superadmin)
    await createPlayer(page, testInfo, { name, phone })
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()

    await press(page.getByRole("link", { name: "Editar" }), testInfo)
    await page.waitForLoadState("networkidle")
    await page.getByLabel("Apodo (opcional)").fill("El Rápido")
    await page.getByLabel("Teléfono", { exact: true }).fill(newPhone)
    await page.getByLabel(/Motivo del cambio/).fill("Cambió de número")
    await press(page.getByRole("button", { name: "Guardar cambios" }), testInfo)

    await expect(page.getByTestId("player-nickname")).toHaveText("“El Rápido”")
    await expect(page.getByTestId("player-phone")).toHaveText(`+52 ${newPhone}`)
    await expect(page.getByTestId("phone-history")).toContainText(
      `+52 ${phone} → +52 ${newPhone}`
    )
    await expect(page.getByTestId("player-audit")).toContainText(
      "Cambio de teléfono"
    )
  })

  test("desactiva y reactiva, y registra y revoca el consentimiento", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    const name = `Estado ${testInfo.project.name} ${Date.now()}`
    await login(page, users.cashier)
    await createPlayer(page, testInfo, { name, phone: randomPhone() })
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()

    // Desactivar con confirmación.
    await press(
      page.getByRole("button", { name: `Desactivar ${name}` }),
      testInfo
    )
    await press(page.getByRole("button", { name: "Confirmar" }), testInfo)
    await expect(page.getByText("Jugador inactivo:")).toBeVisible()
    await press(page.getByRole("button", { name: `Activar ${name}` }), testInfo)
    await press(page.getByRole("button", { name: "Confirmar" }), testInfo)
    await expect(page.getByText("Jugador inactivo:")).toHaveCount(0)

    // Consentimiento: el botón exige confirmar la aceptación del jugador.
    await press(
      page.getByRole("button", { name: "Registrar aceptación" }),
      testInfo
    )
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByTestId("consent-notice")).toContainText(
      "Acepto recibir por WhatsApp"
    )
    const submit = dialog.getByRole("button", { name: "Registrar aceptación" })
    await expect(submit).toBeDisabled()
    await press(dialog.getByTestId("consent-confirm"), testInfo)
    await press(submit, testInfo)
    await expect(page.getByTestId("consent-status")).toHaveText("Aceptadas")

    await press(
      page.getByRole("button", { name: "Revocar consentimiento" }),
      testInfo
    )
    await press(
      page.getByRole("dialog").getByRole("button", { name: "Revocar" }),
      testInfo
    )
    await expect(page.getByTestId("consent-status")).toHaveText(
      "Sin consentimiento"
    )
    await expectNoHorizontalScroll(page)
  })

  test("CASHIER no ve el historial telefónico; sí la auditoría del jugador (Módulo 15)", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    const name = `Privado ${testInfo.project.name} ${Date.now()}`
    await login(page, users.cashier)
    await createPlayer(page, testInfo, { name, phone: randomPhone() })
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Historial de teléfonos" })
    ).toHaveCount(0)
    // Módulo 15 (DEC-03): CASHIER sí consulta la auditoría del jugador; el
    // historial de teléfonos (dato personal) sigue reservado.
    await expect(page.getByRole("heading", { name: "Auditoría" })).toBeVisible()

    const id = page.url().split("/").pop()
    expect(
      (await page.request.get(`/api/players/${id}/phone-history`)).status()
    ).toBe(403)
  })
})
