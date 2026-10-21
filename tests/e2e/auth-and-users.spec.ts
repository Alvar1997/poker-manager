import { expect, test } from "@playwright/test"

import {
  fillLogin,
  login,
  logout,
  navigation,
  requireE2EUsers,
} from "./helpers"

/**
 * E2E con sesión REAL (Auth.js + cookies + base de datos de pruebas):
 * login, administración de usuarios por SUPERADMIN y denegación de
 * acceso para PARTNER/CASHIER — en escritorio y en iPhone.
 */

test.describe("login y logout", () => {
  test("SUPERADMIN inicia sesión, ve su rol y cierra sesión", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)

    await expect(page.getByTestId("current-role")).toHaveText("Superadmin")
    await expect(
      page.getByRole("heading", { name: /Hola, Admin E2E/ })
    ).toBeVisible()

    await logout(page)
    await page.goto("/dashboard")
    await expect(page).toHaveURL(/\/login/)
  })

  test("usuario inactivo no puede iniciar sesión (mensaje genérico)", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await fillLogin(page, users.inactive.email, users.inactive.password)

    // (Next añade su propio role=alert vacío: el anunciador de rutas.)
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Correo o contraseña incorrectos." })
    ).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test("mostrar/ocultar contraseña", async ({ page }) => {
    await page.goto("/login")
    const password = page.getByLabel("Contraseña", { exact: true })
    await expect(password).toHaveAttribute("type", "password")
    await page.getByRole("button", { name: "Mostrar contraseña" }).click()
    await expect(password).toHaveAttribute("type", "text")
  })
})

test.describe("navegación por rol", () => {
  test("SUPERADMIN ve la administración de usuarios", async ({ page }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)
    const nav = await navigation(page)

    await expect(nav.getByRole("link", { name: "Usuarios" })).toBeVisible()
    await expect(nav.locator('[data-nav-id="settings"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="reports"]')).toBeVisible()
  })

  test("PARTNER ve finanzas, auditoría y configuración, pero no usuarios", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.partner)
    const nav = await navigation(page)

    await expect(nav.locator('[data-nav-id="cash"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="reports"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="audit"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="settings"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="users"]')).toHaveCount(0)
  })

  test("CASHIER ve la operación de caja, reportes (M14) y auditoría (M15), sin administración de usuarios", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.cashier)
    const nav = await navigation(page)

    await expect(nav.locator('[data-nav-id="cash"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="purchases"]')).toBeVisible()
    await expect(nav.locator('[data-nav-id="settings"]')).toBeVisible()
    // DEC-08: CASHIER consulta todos los reportes (solo lectura).
    await expect(nav.locator('[data-nav-id="reports"]')).toBeVisible()
    // DEC-03 (Módulo 15): CASHIER consulta la auditoría operativa y financiera.
    await expect(nav.locator('[data-nav-id="audit"]')).toBeVisible()
    for (const hidden of ["users"]) {
      await expect(nav.locator(`[data-nav-id="${hidden}"]`)).toHaveCount(0)
    }
  })
})

test.describe("denegación de acceso", () => {
  test("PARTNER no entra a usuarios ni por URL ni por API", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.partner)

    await page.goto("/dashboard/users")
    await expect(page).toHaveURL(/\/dashboard\/access-denied/)
    await expect(
      page.getByRole("heading", { name: "Acceso denegado" })
    ).toBeVisible()

    const api = await page.request.get("/api/users")
    expect(api.status()).toBe(403)

    const create = await page.request.post("/api/users", {
      data: { name: "Intruso", email: "intruso@e2e.test", role: "SUPERADMIN" },
    })
    expect(create.status()).toBe(403)
  })

  test("CASHIER no puede abrir el alta de usuarios", async ({ page }) => {
    const users = requireE2EUsers()
    await login(page, users.cashier)

    await page.goto("/dashboard/users/new")
    await expect(page).toHaveURL(/\/dashboard\/access-denied/)

    const escalate = await page.request.patch("/api/auth/profile", {
      data: { name: "Cajero E2E", role: "SUPERADMIN" },
    })
    expect(escalate.status()).toBe(400)
  })

  test("las rutas privadas y la API exigen sesión", async ({ page }) => {
    await page.goto("/dashboard/users")
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fdashboard%2Fusers/)

    const api = await page.request.get("/api/users")
    expect(api.status()).toBe(401)
    const me = await page.request.get("/api/auth/me")
    expect(me.status()).toBe(401)
  })
})

test.describe("administración de usuarios (SUPERADMIN)", () => {
  test("crea un usuario, que entra con credencial temporal y debe cambiarla", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    const email = `nuevo-${testInfo.project.name}-${Date.now()}@e2e.test`
    const name = `Nuevo ${testInfo.project.name}`

    await login(page, users.superadmin)
    await page.goto("/dashboard/users")
    await page.getByRole("link", { name: "Nuevo usuario" }).click()

    await page.getByLabel("Nombre").fill(name)
    await page.getByLabel("Correo").fill(email)
    await page.getByLabel("Rol").selectOption("CASHIER")
    await page.getByRole("button", { name: "Crear usuario" }).click()

    const temporary = await page.getByTestId("temporary-password").innerText()
    expect(temporary).toMatch(/^[\w]{5}(-[\w]{5}){3}$/)

    // Aparece en la lista y se puede encontrar con la búsqueda.
    await page.getByRole("link", { name: "Ir a usuarios" }).click()
    await page.getByLabel("Buscar usuarios").fill(email)
    await page.getByRole("button", { name: "Buscar" }).click()
    const card = page.getByTestId("user-card").filter({ hasText: email })
    await expect(card).toHaveCount(1)
    await expect(card.getByText("Credencial temporal")).toBeVisible()

    // Primer acceso del usuario nuevo: debe cambiar la credencial temporal.
    await logout(page)
    await fillLogin(page, email, temporary)
    await expect(
      page.getByRole("heading", { name: "Cambia tu contraseña temporal" })
    ).toBeVisible()

    const newPassword = `Propia-${Date.now()}-x9`
    await page.getByLabel("Contraseña actual").fill(temporary)
    await page.getByLabel("Nueva contraseña", { exact: true }).fill(newPassword)
    await page.getByLabel("Confirmar nueva contraseña").fill(newPassword)
    await page.getByRole("button", { name: "Guardar y continuar" }).click()

    await expect(page).toHaveURL(/\/login\?passwordChanged=1/)
    await expect(page.getByRole("status")).toContainText(
      "Contraseña actualizada"
    )
    await login(page, { email, password: newPassword })
    await expect(page.getByTestId("current-role")).toHaveText("Cajero")
  })

  test("edita, desactiva y restablece la contraseña desde el menú de acciones", async ({
    page,
  }, testInfo) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)

    const email = `editable-${testInfo.project.name}-${Date.now()}@e2e.test`
    const created = await page.request.post("/api/users", {
      data: { name: "Editable", email, role: "CASHIER" },
    })
    expect(created.status()).toBe(201)

    await page.goto(`/dashboard/users?q=${encodeURIComponent(email)}`)
    const card = page.getByTestId("user-card").filter({ hasText: email })

    // Editar: cambiar rol a socio.
    await card.getByRole("button", { name: /Acciones para/ }).click()
    await page.getByRole("menuitem", { name: "Editar" }).click()
    await expect(
      page.getByRole("heading", { name: "Editar usuario" })
    ).toBeVisible()
    await page.getByLabel("Rol").selectOption("PARTNER")
    await page.getByRole("button", { name: "Guardar cambios" }).click()
    await expect(page.getByText("Usuario actualizado")).toBeVisible()

    // Restablecer contraseña.
    await page.getByRole("button", { name: "Restablecer contraseña" }).click()
    await page.getByRole("button", { name: "Confirmar" }).click()
    await expect(page.getByTestId("temporary-password")).toBeVisible()
    await page.getByRole("button", { name: "Listo" }).click()

    // Desactivar.
    await page.getByRole("button", { name: "Desactivar usuario" }).click()
    await page.getByRole("button", { name: "Confirmar" }).click()
    await expect(page.getByText("Usuario desactivado")).toBeVisible()
    // Esperar a que terminen los router.refresh() encolados (guardar,
    // restablecer, desactivar) antes de navegar; si no, WebKit interrumpe
    // la navegación siguiente.
    await expect(
      page.getByRole("button", { name: "Activar usuario" })
    ).toBeVisible()
    await page.waitForLoadState("networkidle")

    // Aun así WebKit puede interrumpir la navegación con un refresh tardío
    // ("interrupted by another navigation"): se reintenta hasta que aterriza.
    const inactiveUrl = `/dashboard/users?q=${encodeURIComponent(email)}&status=inactive`
    await expect(async () => {
      await page.goto(inactiveUrl)
      await expect(page).toHaveURL(/status=inactive/)
    }).toPass({ timeout: 15_000 })
    await expect(
      page
        .getByTestId("user-card")
        .filter({ hasText: email })
        .getByText("Inactivo")
    ).toBeVisible()
  })

  test("SUPERADMIN no ve acciones para desactivarse a sí mismo", async ({
    page,
  }) => {
    const users = requireE2EUsers()
    await login(page, users.superadmin)
    await page.goto(
      `/dashboard/users?q=${encodeURIComponent(users.superadmin.email)}`
    )

    const card = page
      .getByTestId("user-card")
      .filter({ hasText: users.superadmin.email })
    await card.getByRole("button", { name: /Acciones para/ }).click()
    await expect(page.getByRole("menuitem", { name: "Editar" })).toBeVisible()
    await expect(
      page.getByRole("menuitem", { name: "Desactivar" })
    ).toHaveCount(0)
  })
})

test.describe("perfil", () => {
  test("cada rol ve su perfil con correo y rol", async ({ page }) => {
    const users = requireE2EUsers()
    await login(page, users.partner)
    await page.goto("/dashboard/profile")

    await expect(page.getByTestId("profile-email")).toHaveText(
      users.partner.email
    )
    await expect(
      page.getByRole("heading", { name: "Cambiar contraseña" })
    ).toBeVisible()
  })
})
