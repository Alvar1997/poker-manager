import { existsSync, readFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

import { E2E_USERS_FILE, type E2EUser, type E2EUsers } from "./global-setup"

/** Usuarios sembrados por global-setup, o null si no hay base de pruebas. */
export function loadE2EUsers(): E2EUsers | null {
  if (!existsSync(E2E_USERS_FILE)) return null
  return JSON.parse(readFileSync(E2E_USERS_FILE, "utf8")) as E2EUsers
}

/** Omite la suite si no se configuró TEST_DATABASE_URL (ver docs/SETUP.md). */
export function requireE2EUsers(): E2EUsers {
  const users = loadE2EUsers()
  test.skip(!users, "Requiere TEST_DATABASE_URL (base de pruebas desechable)")
  return users as E2EUsers
}

export async function fillLogin(page: Page, email: string, password: string) {
  await page.goto("/login")
  // Esperar la hidratación: si se escribe antes, React reinicia los campos
  // controlados (se observó en WebKit/iPhone).
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Correo").fill(email)
  await page.getByLabel("Contraseña", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Entrar" }).click()
}

export async function login(
  page: Page,
  user: Pick<E2EUser, "email" | "password">
) {
  await fillLogin(page, user.email, user.password)
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** En celular la navegación vive en un menú; en escritorio, en la barra lateral. */
export async function navigation(page: Page) {
  const menuButton = page.getByRole("button", { name: "Abrir menú" })
  if (await menuButton.isVisible()) {
    await menuButton.click()
    return page.getByRole("dialog").getByRole("navigation")
  }
  return page.locator("aside").getByRole("navigation")
}

export async function logout(page: Page) {
  // Que termine el router.refresh() posterior al login antes de salir.
  await page.waitForLoadState("networkidle")
  await page
    .getByRole("button", { name: "Cerrar sesión" })
    .filter({ visible: true })
    .first()
    .click()
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
}
