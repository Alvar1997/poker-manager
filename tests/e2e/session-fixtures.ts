import { randomUUID } from "node:crypto"

import { expect, type APIRequestContext } from "@playwright/test"
import { Client } from "pg"

import { resolveTestDatabaseUrl } from "../integration/test-db"

/**
 * Fixtures E2E SOLO para la base de pruebas desechable (TEST_DATABASE_URL,
 * nunca producción). Como solo puede existir UNA sesión vigente, cada spec
 * que necesita un estado conocido deja cerradas/canceladas las sesiones de
 * corridas o proyectos anteriores. Usa `session_replication_role = replica`
 * (solo en esta base) para no depender del cierre del Módulo 12.
 *
 * Desde el Módulo 08 las compras E2E dejan fichas en circulación. Desde el
 * Módulo 12 esa circulación es legítima entre sesiones (valor pendiente de
 * retorno, no bloquea la apertura), así que ya NO se devuelve a custodia a
 * mano: esta limpieza de la base de PRUEBAS solo cancela borradores de
 * compras, liquidaciones y arqueos y libera reservas.
 */
export async function resetActiveSessions() {
  const db = new Client({ connectionString: resolveTestDatabaseUrl() })
  await db.connect()
  try {
    await db.query("BEGIN")
    await db.query("SET LOCAL session_replication_role = replica")
    await db.query(`UPDATE "table_participations" SET "status" = 'TRANSFERRED', "leftAt" = NOW(),
      "leftById" = "joinedById", "exitReason" = 'E2E_CLEANUP' WHERE "status" = 'ACTIVE'`)
    await db.query(`UPDATE "session_table_cycles" SET "status" = 'CLOSED', "closedAt" = NOW(),
      "closedById" = "openedById" WHERE "status" = 'OPEN'`)
    await db.query(
      `UPDATE "session_tables" SET "status" = 'CLOSED' WHERE "status" = 'OPEN'`
    )
    await db.query(`UPDATE "poker_sessions" SET
      "status" = CASE WHEN "status" IN ('DRAFT', 'PREPARATION') THEN 'CANCELLED'::"PokerSessionStatus" ELSE 'CLOSED'::"PokerSessionStatus" END,
      "cancelledAt" = CASE WHEN "status" IN ('DRAFT', 'PREPARATION') THEN NOW() ELSE "cancelledAt" END,
      "cancellationReason" = CASE WHEN "status" IN ('DRAFT', 'PREPARATION') THEN 'Limpieza E2E' ELSE "cancellationReason" END,
      "closedAt" = CASE WHEN "status" IN ('OPEN', 'CLOSING') THEN NOW() ELSE "closedAt" END
      WHERE "status" IN ('DRAFT', 'PREPARATION', 'OPEN', 'CLOSING')`)
    await db.query(
      `UPDATE "chip_stock_counts" SET "status" = 'CANCELLED', "cancelledAt" = NOW() WHERE "status" = 'DRAFT'`
    )
    await db.query(`UPDATE "chip_purchases" SET "status" = 'CANCELLED', "cancelledAt" = NOW(),
      "cancelledById" = "createdById", "cancellationReason" = 'Limpieza E2E'
      WHERE "status" IN ('DRAFT', 'READY_FOR_DELIVERY')`)
    await db.query(
      `UPDATE "chip_reservations" SET "status" = 'RELEASED', "releasedAt" = NOW() WHERE "status" = 'ACTIVE'`
    )
    await db.query(`UPDATE "settlement_signatures" SET "status" = 'CANCELLED', "invalidatedAt" = NOW(),
      "invalidatedById" = "capturedById", "invalidationReason" = 'Limpieza E2E' WHERE "status" = 'VALID'
      AND "settlementId" IN (SELECT "id" FROM "player_settlements" WHERE "status" IN ('DRAFT', 'READY_FOR_CONFIRMATION'))`)
    await db.query(`UPDATE "player_settlements" SET "status" = 'CANCELLED', "cancelledAt" = NOW(),
      "cancelledById" = "createdById", "cancellationReason" = 'Limpieza E2E'
      WHERE "status" IN ('DRAFT', 'READY_FOR_CONFIRMATION')`)
    await db.query(
      `UPDATE "chip_set_inventory_states" SET "reservedNominal" = 0`
    )
    await db.query(
      `UPDATE "cash_reconciliations" SET "status" = 'CANCELLED', "cancelledAt" = NOW() WHERE "status" = 'DRAFT'`
    )
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    await db.end()
  }
}

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["post"]>>
): Promise<T> {
  const body = (await res.json()) as { data: unknown }
  expect(res.ok(), JSON.stringify(body)).toBeTruthy()
  return body.data as T
}

/** Inventario inicial de PRUEBA si aún no existe (50 fichas por denominación). */
export async function ensureInventoryInitialized(request: APIRequestContext) {
  const inventory = await json<
    {
      chipSet: { id: string }
      initialized: boolean
      denominations: { denominationId: string; isActive: boolean }[]
    }[]
  >(await request.get("/api/chip-inventory"))
  const set = inventory[0]
  if (!set.initialized) {
    await json(
      await request.post("/api/chip-inventory/initial-stock", {
        data: {
          chipSetId: set.chipSet.id,
          lines: set.denominations
            .filter((d) => d.isActive)
            .map((d) => ({ denominationId: d.denominationId, quantity: 50 })),
          idempotencyKey: randomUUID(),
        },
      })
    )
  }
}

/**
 * Garantiza un saldo nominal DISPONIBLE mínimo en la base de PRUEBAS con
 * una entrada de inventario real (Módulo 04) de la denominación mayor.
 * Nunca se usa contra producción.
 */
export async function ensureNominalAvailable(
  request: APIRequestContext,
  minimum: number
) {
  const nominal = await json<{ available: string }>(
    await request.get("/api/chip-inventory/nominal")
  )
  const missing = minimum - Number(nominal.available)
  if (missing <= 0) return
  const inventory = await json<
    {
      chipSet: { id: string }
      denominations: {
        denominationId: string
        value: string
        isActive: boolean
      }[]
    }[]
  >(await request.get("/api/chip-inventory"))
  const top = inventory[0].denominations
    .filter((d) => d.isActive)
    .sort((a, b) => Number(b.value) - Number(a.value))[0]
  await json(
    await request.post("/api/chip-inventory/entries", {
      data: {
        chipSetId: inventory[0].chipSet.id,
        lines: [
          {
            denominationId: top.denominationId,
            quantity: Math.ceil(missing / Number(top.value)) + 1,
          },
        ],
        reason: "Fichas de prueba E2E",
        idempotencyKey: randomUUID(),
      },
    })
  )
}

/**
 * Abre una sesión real por API con el flujo completo del Módulo 06 (con el
 * usuario autenticado en `request`): crear → preparar → contar el
 * inventario compartido (sin diferencias) → caja $0 → abrir.
 */
export async function openSessionViaApi(
  request: APIRequestContext,
  opts: { minNominal?: number } = {}
): Promise<{ id: string; folio: string }> {
  await resetActiveSessions()
  await ensureInventoryInitialized(request)
  if (opts.minNominal) await ensureNominalAvailable(request, opts.minNominal)
  const session = await json<{ id: string; folio: string }>(
    await request.post("/api/sessions", {
      data: { idempotencyKey: randomUUID() },
    })
  )
  await json(await request.post(`/api/sessions/${session.id}/prepare`))
  const count = await json<{
    id: string
    expectedTotal: string
    breakdownExact: boolean
    details: {
      denominationId: string
      unitValue: string
      expectedQuantity: number
    }[]
  }>(await request.post(`/api/sessions/${session.id}/opening-chip-count`))
  await json(
    await request.patch(`/api/chip-inventory/counts/${count.id}`, {
      data: { lines: physicalCount(count) },
    })
  )
  await json(
    await request.post(`/api/chip-inventory/counts/${count.id}/confirm`, {
      data: { idempotencyKey: randomUUID() },
    })
  )
  await json(
    await request.post(`/api/sessions/${session.id}/opening-cash`, {
      data: { countedAmount: "0", physicallyVerified: true },
    })
  )
  await json(
    await request.post(`/api/sessions/${session.id}/open`, {
      data: { idempotencyKey: randomUUID() },
    })
  )
  return session
}

/**
 * Conteo físico SIMULADO que coincide con el valor nominal `total`: parte
 * de la composición de referencia y solo corrige la diferencia (quita de
 * las denominaciones mayores o agrega a la que la represente), para no
 * vaciar denominaciones que otras pruebas usan. Solo base de pruebas.
 */
export function simulatePhysicalCount(
  details: {
    denominationId: string
    unitValue: string
    expectedQuantity: number
  }[],
  total: number
) {
  const cents = (v: string) => Math.round(Number(v) * 100)
  const qty = new Map(
    details.map((d) => [d.denominationId, d.expectedQuantity])
  )
  let diff =
    Math.round(total * 100) -
    details.reduce((acc, d) => acc + cents(d.unitValue) * d.expectedQuantity, 0)
  const desc = [...details].sort(
    (a, b) => cents(b.unitValue) - cents(a.unitValue)
  )
  // Sobra referencia: quitar fichas, de la mayor a la menor.
  for (const d of desc) {
    while (
      diff < 0 &&
      qty.get(d.denominationId)! > 0 &&
      -diff >= cents(d.unitValue)
    ) {
      qty.set(d.denominationId, qty.get(d.denominationId)! - 1)
      diff += cents(d.unitValue)
    }
  }
  // Falta valor: agregar fichas, de la mayor a la menor.
  for (const d of desc) {
    const v = cents(d.unitValue)
    if (diff >= v) {
      const q = Math.floor(diff / v)
      qty.set(d.denominationId, qty.get(d.denominationId)! + q)
      diff -= q * v
    }
  }
  expect(diff, "valor no representable con las denominaciones").toBe(0)
  return details.map((d) => ({
    denominationId: d.denominationId,
    countedQuantity: qty.get(d.denominationId)!,
  }))
}

function physicalCount(count: {
  expectedTotal: string
  breakdownExact: boolean
  details: {
    denominationId: string
    unitValue: string
    expectedQuantity: number
  }[]
}) {
  if (count.breakdownExact)
    return count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity: d.expectedQuantity,
    }))
  return simulatePhysicalCount(count.details, Number(count.expectedTotal))
}

/** Jugador de PRUEBA (solo base de pruebas), con teléfono sintético único. */
export async function createE2EPlayer(
  request: APIRequestContext,
  name: string
) {
  const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999))
  return json<{ id: string; name: string }>(
    await request.post("/api/players", {
      data: {
        name,
        phone: `871 ${digits.slice(0, 3)} ${digits.slice(3)}`,
        phoneCountry: "MX",
      },
    })
  )
}
