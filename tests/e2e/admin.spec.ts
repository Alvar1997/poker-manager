import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { Client } from "pg"

import { resolveTestDatabaseUrl } from "../integration/test-db"
import { login, logout, requireE2EUsers } from "./helpers"
import { createE2EPlayer, openSessionViaApi } from "./session-fixtures"

/**
 * Módulo 15 desde la UI (Chrome + iPhone) sobre la base de PRUEBAS:
 * auditoría con filtros, detalle de una compra, solicitud de corrección
 * (CASHIER), rechazo de su aprobación, aprobación del socio SIN efectos
 * monetarios, integridad, incidencias, respaldos (uno REAL ejecutado por el
 * CLI contra la base de pruebas), recuperación (solo SUPERADMIN) y estado
 * del sistema. Nunca se restaura producción ni se activa el mantenimiento.
 */
test.describe.configure({ mode: "serial" })

const ctx = { sessionId: "", purchaseId: "", correctionId: "" }

const visible = (page: Page, id: string) =>
  page.getByTestId(id).filter({ visible: true })

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

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

async function counts() {
  const db = new Client({ connectionString: resolveTestDatabaseUrl() })
  await db.connect()
  try {
    const q = async (t: string) =>
      Number((await db.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n)
    return {
      tx: await q("cash_transactions"),
      entries: await q("cash_transaction_entries"),
      chips: await q("chip_nominal_movements"),
      alloc: await q("payment_allocations"),
    }
  } finally {
    await db.end()
  }
}

test("prepara una compra real en la base de pruebas", async ({
  page,
}, testInfo: TestInfo) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  ctx.sessionId = (
    await openSessionViaApi(page.request, { minNominal: 5_000 })
  ).id
  const tables = await api<{ tableId: string; name: string }[]>(
    page,
    "get",
    `/api/sessions/${ctx.sessionId}/tables`
  )
  const t25 = tables.find((t) => t.name === "Mesa 25/25")!.tableId
  await api(page, "post", `/api/sessions/${ctx.sessionId}/tables/${t25}/open`, {
    idempotencyKey: randomUUID(),
  })
  const player = await createE2EPlayer(
    page.request,
    `Auditoría ${testInfo.project.name} ${Date.now() % 1e5}`
  )
  const part = await api<{ id: string }>(
    page,
    "post",
    `/api/sessions/${ctx.sessionId}/tables/${t25}/players`,
    {
      playerId: player.id,
      idempotencyKey: randomUUID(),
    }
  )
  const p = await api<{ id: string }>(page, "post", "/api/purchases", {
    participationId: part.id,
    nominalAmount: "500",
    idempotencyKey: randomUUID(),
  })
  await api(page, "post", `/api/purchases/${p.id}/payments`, {
    method: "CASH",
    amount: "500",
    cashReceived: true,
    idempotencyKey: randomUUID(),
  })
  const view = await api<{ version: number }>(
    page,
    "get",
    `/api/purchases/${p.id}`
  )
  await api(page, "post", `/api/purchases/${p.id}/confirm-delivery`, {
    expectedVersion: view.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: randomUUID(),
  })
  ctx.purchaseId = p.id
})

test("CASHIER: administración, auditoría filtrada, detalle de compra y solicitud de corrección", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.cashier)
  await page.goto("/dashboard/administracion")
  await expect(visible(page, "admin-card-audit")).toBeVisible()
  // Sin acceso a infraestructura ni recuperación.
  await expect(visible(page, "admin-tab-respaldos")).toHaveCount(0)
  await expect(visible(page, "admin-tab-recuperacion")).toHaveCount(0)
  await noHorizontalScroll(page)

  await visible(page, "admin-tab-auditoria").click()
  await page
    .getByTestId("f-sessionId")
    .filter({ visible: true })
    .fill(ctx.sessionId)
  await page
    .getByTestId("f-action")
    .filter({ visible: true })
    .selectOption("PURCHASE_CONFIRMED")
  await visible(page, "apply-admin-filters").click()
  await expect(page).toHaveURL(new RegExp(`sessionId=${ctx.sessionId}`))
  await expect(visible(page, "audit-row")).toHaveCount(1)
  await visible(page, "audit-row-link").first().click()
  await expect(visible(page, "audit-entity")).toContainText(ctx.purchaseId)
  // Volver conserva los filtros.
  // El enlace de REGRESO (el último «Auditoría» exacto; los anteriores son
  // el menú y la pestaña) conserva los filtros.
  await Promise.all([
    page.waitForURL(/\/administracion\/auditoria\?/),
    page
      .getByRole("link", { name: "Auditoría", exact: true })
      .filter({ visible: true })
      .last()
      .click(),
  ])
  await expect(page).toHaveURL(new RegExp(`sessionId=${ctx.sessionId}`))
  await expect(visible(page, "audit-row")).toHaveCount(1)
  await visible(page, "audit-row-link").first().click()

  await visible(page, "audit-request-correction").click()
  await expect(page).toHaveURL(/correcciones\/nueva/)
  await expect(visible(page, "m16-warning")).toBeVisible()
  await expect(visible(page, "correction-target")).toHaveValue(ctx.purchaseId)
  await visible(page, "correction-reason").fill(
    "Compra registrada al jugador equivocado (prueba E2E)"
  )
  await visible(page, "submit-correction").click()
  await expect(page).toHaveURL(/correcciones\/[A-Za-z0-9_-]+$/)
  ctx.correctionId = page.url().split("/").pop()!
  await expect(visible(page, "correction-status")).toContainText("Solicitada")
  await expect(visible(page, "cashier-cannot-authorize")).toBeVisible()
  await expect(visible(page, "correction-approve")).toHaveCount(0)
  // Intento directo por API: rechazado.
  const denied = await page.request.post(
    `/api/admin/corrections/${ctx.correctionId}/approve`,
    {
      data: { expectedVersion: 1, notes: "intento del cajero" },
    }
  )
  expect(denied.status()).toBe(403)
  await noHorizontalScroll(page)
})

test("PARTNER: aprueba sin modificar saldos; integridad, incidencias y respaldos", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.partner)
  await page.goto(`/dashboard/administracion/correcciones/${ctx.correctionId}`)
  const before = await counts()
  await visible(page, "correction-notes").fill(
    "Aprobada: pendiente del flujo seguro del Módulo 16"
  )
  await visible(page, "correction-approve").click()
  await expect(visible(page, "correction-status")).toContainText(
    "pendiente de ejecución"
  )
  await expect(visible(page, "correction-status")).toContainText("Módulo 16")
  expect(await counts()).toEqual(before)

  await page.goto("/dashboard/administracion/integridad")
  await visible(page, "run-integrity").click()
  await expect(page).toHaveURL(/integridad\/[A-Za-z0-9_-]+$/, {
    timeout: 60_000,
  })
  await expect(visible(page, "integrity-overall")).toBeVisible()
  await expect(
    visible(page, "finding-RECEIVABLES_PENDING_INFO")
  ).toHaveAttribute("data-status", "OK")
  await expect(visible(page, "finding-INV_CIRCULATION_INFO")).toHaveAttribute(
    "data-status",
    "OK"
  )

  await page.goto("/dashboard/administracion/incidencias/nueva")
  await visible(page, "incident-title").fill("Revisión E2E de arqueo")
  await visible(page, "incident-description").fill(
    "Incidencia manual creada por la prueba E2E para revisión"
  )
  await visible(page, "submit-incident").click()
  await expect(page).toHaveURL(/incidencias\/[A-Za-z0-9_-]+$/)
  await visible(page, "incident-comment").fill("Revisado por el socio")
  await visible(page, "submit-incident-update").click()
  await expect(visible(page, "incident-history")).toContainText(
    "Revisado por el socio"
  )

  // Respaldo REAL de la base de pruebas con el CLI (destino temporal).
  const dir = mkdtempSync(join(tmpdir(), "pm-e2e-backup-"))
  const url = resolveTestDatabaseUrl()
  execFileSync(
    "npx",
    ["tsx", "--conditions=react-server", "scripts/ops.ts", "backup:run"],
    {
      env: {
        ...process.env,
        // Solo la base de PRUEBAS y valores de prueba (como el servidor E2E).
        DATABASE_URL: url,
        DIRECT_URL: url,
        AUTH_SECRET:
          process.env.AUTH_SECRET ??
          "e2e-test-secret-at-least-32-characters-long",
        AUTH_URL: "http://localhost:3100",
        LOG_LEVEL: "warn",
        BACKUP_STORAGE_DIR: dir,
        BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
      stdio: "pipe",
      timeout: 120_000,
    }
  )
  await page.goto("/dashboard/administracion/respaldos")
  // Un respaldo MANUAL no prueba que exista la tarea diaria.
  await expect(visible(page, "backup-automation")).toHaveAttribute(
    "data-value",
    "NOT_CONFIGURED"
  )
  await Promise.all([
    page.waitForURL(/\/administracion\/respaldos\/[A-Za-z0-9_-]+$/),
    visible(page, "last-backup-success").getByRole("link").click(),
  ])
  await expect(
    page.getByRole("heading", { name: "Respaldo", exact: true })
  ).toBeVisible()
  // Sin cadenas de conexión ni secretos en la interfaz.
  await expect(page.getByText(/postgres(ql)?:\/\//)).toHaveCount(0)
  // El socio no accede a recuperación.
  await page.goto("/dashboard/administracion/recuperacion")
  await expect(page).toHaveURL(/access-denied/)
  await noHorizontalScroll(page)
})

test("SUPERADMIN: controles de recuperación y estado del sistema; CASHIER sin acceso", async ({
  page,
}) => {
  const users = requireE2EUsers()
  await login(page, users.superadmin)
  await page.goto("/dashboard/administracion/recuperacion")
  await expect(visible(page, "recovery-procedure")).toBeVisible()
  await expect(visible(page, "maintenance-status")).toContainText("Inactivo")
  await expect(
    visible(page, "recovery-request-form").or(
      visible(page, "no-recoverable-backups")
    )
  ).toBeVisible()
  await page.goto("/dashboard/administracion/sistema")
  await expect(visible(page, "system-overall")).toBeVisible()
  await expect(visible(page, "system-database")).toHaveAttribute(
    "data-status",
    "OK"
  )
  await expect(visible(page, "system-backups")).toHaveAttribute(
    "data-status",
    "NOT_CONFIGURED"
  )
  await noHorizontalScroll(page)
  await logout(page)

  await login(page, users.cashier)
  for (const url of [
    "/api/admin/recovery",
    "/api/admin/backups",
    "/api/admin/system/health",
  ])
    expect((await page.request.get(url)).status()).toBe(403)
  const restore = await page.request.post("/api/admin/recovery", {
    data: {
      backupId: "x",
      reason: "intento de recuperación del cajero",
      password: "x",
      idempotencyKey: randomUUID(),
    },
  })
  expect(restore.status()).toBe(403)
})
