import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as containersRoute from "@/app/api/chip-containers/route"
import * as inventoryByIdRoute from "@/app/api/chip-inventory/[chipSetId]/route"
import * as adjustmentsRoute from "@/app/api/chip-inventory/adjustments/route"
import * as cancelRoute from "@/app/api/chip-inventory/counts/[id]/cancel/route"
import * as confirmRoute from "@/app/api/chip-inventory/counts/[id]/confirm/route"
import * as reconcileRoute from "@/app/api/chip-inventory/counts/[id]/reconcile/route"
import * as countByIdRoute from "@/app/api/chip-inventory/counts/[id]/route"
import * as countsRoute from "@/app/api/chip-inventory/counts/route"
import * as entriesRoute from "@/app/api/chip-inventory/entries/route"
import * as initialRoute from "@/app/api/chip-inventory/initial-stock/route"
import * as movementsRoute from "@/app/api/chip-inventory/movements/route"
import * as nominalMovementsRoute from "@/app/api/chip-inventory/nominal-movements/route"
import * as inventoryRoute from "@/app/api/chip-inventory/route"
import * as withdrawalsRoute from "@/app/api/chip-inventory/withdrawals/route"
import * as denominationByIdRoute from "@/app/api/denominations/[id]/route"
import * as chipSetStatusRoute from "@/app/api/chip-sets/[id]/status/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { seedChipContainers } from "@/modules/inventory/inventory.seed"
import {
  confirmNominalChipDelivery,
  confirmNominalChipReturn,
  expireReservations,
  getAvailableNominalValue,
  releaseNominalReservation,
  reserveNominalAmount,
} from "@/modules/inventory/reservation.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"

/** El inventario físico ÚNICO, compartido por ambas mesas. */
let set25: { id: string }
/** Un juego INACTIVO (historial previo a la consolidación). */
let set10: { id: string }
let d25: Record<string, string> // valor → id (inventario compartido)
let d10: Record<string, string> // valor → id (juego inactivo)

beforeEach(async () => {
  await resetDatabase()
  set25 = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  set10 = await prisma.chipSet.create({
    data: {
      code: "CHIPSET_HISTORICO",
      name: "Juego anterior",
      isActive: false,
    },
  })
  d25 = await denominations(set25.id, ["25", "100", "500"])
  // Mismo valor 100 en el juego histórico: entidad distinta.
  d10 = await denominations(set10.id, ["10", "50", "100"])
})

async function denominations(chipSetId: string, values: string[]) {
  const out: Record<string, string> = {}
  for (const value of values) {
    const d = await prisma.chipDenomination.create({
      data: { chipSetId, value },
    })
    out[value] = d.id
  }
  return out
}

async function asRole(role: Role) {
  const user = await createUser({ role })
  signInAs(user)
  return user
}

const key = () => randomUUID()

function post(handler: typeof entriesRoute.POST, body: unknown) {
  return call(handler, { method: "POST", body })
}

async function initialize(
  chipSetId: string,
  lines: Record<string, number>,
  denoms: Record<string, string>
) {
  return post(initialRoute.POST, {
    chipSetId,
    lines: Object.entries(lines).map(([value, quantity]) => ({
      denominationId: denoms[value],
      quantity,
    })),
    idempotencyKey: key(),
  })
}

async function custody(denominationId: string) {
  const rows = await prisma.chipInventoryBalance.findMany({
    where: { denominationId },
  })
  const sum = (loc: string) =>
    rows.filter((r) => r.location === loc).reduce((a, r) => a + r.quantity, 0)
  return {
    custody: sum("CUSTODY"),
    reserved: rows
      .filter((r) => r.location === "CUSTODY")
      .reduce((a, r) => a + r.reserved, 0),
    circulation: sum("CIRCULATION"),
    retired: sum("RETIRED"),
  }
}

/** Reconstruye la custodia desde el libro (MOV-15). */
async function custodyFromLedger(denominationId: string) {
  const movements = await prisma.chipInventoryMovement.findMany({
    where: { denominationId },
  })
  return movements.reduce(
    (acc, m) =>
      acc +
      (m.toLocation === "CUSTODY" ? m.quantity : 0) -
      (m.fromLocation === "CUSTODY" ? m.quantity : 0),
    0
  )
}

describe("contenedores y seed", () => {
  it("existe UNA ubicación física del inventario común y el seed es idempotente", async () => {
    await asRole("CASHIER")
    const res = await call(containersRoute.GET)
    const containers = res.json.data as {
      code: string
      chipSet: { code: string }
    }[]
    expect(containers.map((c) => [c.code, c.chipSet.code])).toEqual([
      ["INVENTARIO-GENERAL", "CHIPSET_MAIN"],
    ])
    await seedChipContainers(prisma)
    await seedChipContainers(prisma)
    expect(await prisma.chipContainer.count()).toBe(1)
    // El seed no crea cantidades, movimientos, arqueos ni reservas.
    expect(await prisma.chipInventoryBalance.count()).toBe(0)
    expect(await prisma.chipInventoryMovement.count()).toBe(0)
    expect(await prisma.chipStockCount.count()).toBe(0)
    expect(await prisma.chipReservation.count()).toBe(0)
  })

  it("la base impide un segundo maletín principal activo para el mismo juego", async () => {
    await expect(
      prisma.chipContainer.create({
        data: {
          code: "OTRO",
          name: "Otro",
          chipSetId: set25.id,
          isPrimary: true,
        },
      })
    ).rejects.toThrow()
  })

  it("la base impide existencias que mezclen juegos (FK compuesta)", async () => {
    const container25 = await prisma.chipContainer.findUniqueOrThrow({
      where: { code: "INVENTARIO-GENERAL" },
    })
    await expect(
      prisma.chipInventoryBalance.create({
        data: {
          chipSetId: set25.id,
          containerId: container25.id,
          denominationId: d10["100"],
          location: "CUSTODY",
          quantity: 1,
        },
      })
    ).rejects.toThrow()
  })
})

describe("inventario inicial", () => {
  it("se registra una sola vez para el inventario común; un juego inactivo no se opera", async () => {
    const actor = await asRole("CASHIER")
    const res = await initialize(
      set25.id,
      { "25": 200, "100": 100, "500": 20 },
      d25
    )
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({
      countType: "INITIAL",
      status: "CONFIRMED",
      countedTotal: "25000.00",
    })

    expect(await custody(d25["100"])).toMatchObject({
      custody: 100,
      reserved: 0,
    })
    expect(await custody(d10["100"])).toMatchObject({ custody: 0 }) // mismo valor, juego histórico
    const state = await prisma.chipSetInventoryState.findUniqueOrThrow({
      where: { chipSetId: set25.id },
    })
    expect(state).toMatchObject({ initializedById: actor.id })
    expect(await auditRows("CHIP_INITIAL_STOCK_CREATED")).toHaveLength(1)

    const again = await initialize(
      set25.id,
      { "25": 1, "100": 1, "500": 1 },
      d25
    )
    expect(again.status).toBe(422)

    const other = await initialize(
      set10.id,
      { "10": 300, "50": 40, "100": 10 },
      d10
    )
    expect(other.status).toBe(422)
    expect(other.json.error?.message).toContain("inventario general")
  })

  it("exige todas las denominaciones activas y cantidades enteras no negativas", async () => {
    await asRole("CASHIER")
    expect(
      (await initialize(set25.id, { "25": 10, "100": 10 }, d25)).status
    ).toBe(400)
    for (const quantity of [-1, 1.5, "10"]) {
      const res = await post(initialRoute.POST, {
        chipSetId: set25.id,
        lines: [
          { denominationId: d25["25"], quantity },
          { denominationId: d25["100"], quantity: 1 },
          { denominationId: d25["500"], quantity: 1 },
        ],
        idempotencyKey: key(),
      })
      expect(res.status).toBe(400)
    }
    // No se aceptan denominaciones de otro juego.
    const mixed = await post(initialRoute.POST, {
      chipSetId: set25.id,
      lines: [
        { denominationId: d25["25"], quantity: 1 },
        { denominationId: d25["100"], quantity: 1 },
        { denominationId: d25["500"], quantity: 1 },
        { denominationId: d10["10"], quantity: 1 },
      ],
      idempotencyKey: key(),
    })
    expect(mixed.status).toBe(422)
    expect(await prisma.chipInventoryMovement.count()).toBe(0)
  })

  it("dos inicializaciones simultáneas producen un solo inventario inicial", async () => {
    await asRole("CASHIER")
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        initialize(set25.id, { "25": 10, "100": 10, "500": 10 }, d25)
      )
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 422)).toHaveLength(3)
    expect(await custody(d25["25"])).toMatchObject({ custody: 10 })
    expect(
      await prisma.chipStockCount.count({
        where: { countType: "INITIAL", status: "CONFIRMED" },
      })
    ).toBe(1)
  })

  it("reintentar la misma solicitud no duplica el inventario", async () => {
    await asRole("CASHIER")
    const body = {
      chipSetId: set25.id,
      lines: [
        { denominationId: d25["25"], quantity: 5 },
        { denominationId: d25["100"], quantity: 5 },
        { denominationId: d25["500"], quantity: 5 },
      ],
      idempotencyKey: key(),
    }
    const first = await post(initialRoute.POST, body)
    const second = await post(initialRoute.POST, body)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect((second.json.data as { id: string }).id).toBe(
      (first.json.data as { id: string }).id
    )
    expect(await custody(d25["25"])).toMatchObject({ custody: 5 })
  })

  it("las operaciones exigen inventario inicializado", async () => {
    await asRole("CASHIER")
    const res = await post(entriesRoute.POST, {
      chipSetId: set25.id,
      lines: [{ denominationId: d25["25"], quantity: 5 }],
      reason: "Reposición",
      idempotencyKey: key(),
    })
    expect(res.status).toBe(422)
    expect(res.json.error?.message).toContain("pendiente de inicialización")
  })
})

describe("entradas, bajas y ajustes", () => {
  beforeEach(async () => {
    await asRole("SUPERADMIN")
    await initialize(set25.id, { "25": 50, "100": 50, "500": 10 }, d25)
  })

  it("una entrada actualiza saldo y libro en la misma operación, sin tocar la caja", async () => {
    const res = await post(entriesRoute.POST, {
      chipSetId: set25.id,
      lines: [
        { denominationId: d25["25"], quantity: 20 },
        { denominationId: d25["500"], quantity: 5 },
      ],
      reason: "Compra de fichas nuevas",
      idempotencyKey: key(),
    })
    expect(res.status).toBe(201)
    const op = res.json.data as {
      lines: { custodyBefore: number; custodyAfter: number }[]
      nominalTotal: string
    }
    expect(op.nominalTotal).toBe("3000.00")
    expect(await custody(d25["25"])).toMatchObject({ custody: 70 })
    expect(await custodyFromLedger(d25["25"])).toBe(70)
    expect(await auditRows("CHIP_STOCK_ENTRY")).toHaveLength(1)
  })

  it("entrada: motivo obligatorio, cantidad > 0, denominación del juego", async () => {
    for (const body of [
      {
        chipSetId: set25.id,
        lines: [{ denominationId: d25["25"], quantity: 5 }],
        idempotencyKey: key(),
      },
      {
        chipSetId: set25.id,
        lines: [{ denominationId: d25["25"], quantity: 0 }],
        reason: "X motivo",
        idempotencyKey: key(),
      },
    ]) {
      expect((await post(entriesRoute.POST, body)).status).toBe(400)
    }
    const foreign = await post(entriesRoute.POST, {
      chipSetId: set25.id,
      lines: [{ denominationId: d10["100"], quantity: 5 }],
      reason: "Mezcla",
      idempotencyKey: key(),
    })
    expect(foreign.status).toBe(422)
  })

  it("una baja no excede lo disponible y no deja cambios parciales si falla", async () => {
    const res = await post(withdrawalsRoute.POST, {
      chipSetId: set25.id,
      category: "DAMAGE",
      lines: [
        { denominationId: d25["25"], quantity: 10 },
        { denominationId: d25["500"], quantity: 11 }, // solo hay 10
      ],
      reason: "Fichas rotas",
      idempotencyKey: key(),
    })
    expect(res.status).toBe(422)
    // Nada cambió: ni la línea válida.
    expect(await custody(d25["25"])).toMatchObject({ custody: 50, retired: 0 })
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "STOCK_WITHDRAWAL" },
      })
    ).toBe(0)

    const ok = await post(withdrawalsRoute.POST, {
      chipSetId: set25.id,
      category: "DAMAGE",
      lines: [{ denominationId: d25["25"], quantity: 3 }],
      reason: "Fichas rotas",
      idempotencyKey: key(),
    })
    expect(ok.status).toBe(201)
    expect(await custody(d25["25"])).toMatchObject({ custody: 47, retired: 3 })
  })

  it.each(["SUPERADMIN", "PARTNER", "CASHIER"] as const)(
    "%s puede ajustar sin aprobación (motivo, saldo anterior y resultante)",
    async (role) => {
      const actor = await asRole(role)
      const res = await post(adjustmentsRoute.POST, {
        chipSetId: set25.id,
        denominationId: d25["100"],
        kind: "SHORTAGE",
        quantity: 2,
        reason: "Faltante detectado al cerrar",
        idempotencyKey: key(),
      })
      expect(res.status).toBe(201)
      const line = (
        res.json.data as {
          lines: { custodyBefore: number; custodyAfter: number }[]
        }
      ).lines[0]
      expect(line).toMatchObject({ custodyBefore: 50, custodyAfter: 48 })
      const [audit] = await auditRows("CHIP_INVENTORY_ADJUSTED")
      expect(audit).toMatchObject({ actorUserId: actor.id })
      expect(audit.metadata).toMatchObject({
        reason: "Faltante detectado al cerrar",
        custodyBefore: 50,
        custodyAfter: 48,
      })
    }
  )

  it("ajuste: motivo obligatorio, corrección con dirección y nunca negativo", async () => {
    const base = {
      chipSetId: set25.id,
      denominationId: d25["500"],
      idempotencyKey: key(),
    }
    expect(
      (
        await post(adjustmentsRoute.POST, {
          ...base,
          kind: "SURPLUS",
          quantity: 1,
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post(adjustmentsRoute.POST, {
          ...base,
          kind: "CORRECTION",
          quantity: 1,
          reason: "Corrección",
        })
      ).status
    ).toBe(400)
    const negative = await post(adjustmentsRoute.POST, {
      ...base,
      kind: "SHORTAGE",
      quantity: 11,
      reason: "Faltante grande",
    })
    expect(negative.status).toBe(422)
    const up = await post(adjustmentsRoute.POST, {
      ...base,
      idempotencyKey: key(),
      kind: "CORRECTION",
      direction: "INCREASE",
      quantity: 4,
      reason: "Error de captura",
    })
    expect(up.status).toBe(201)
    expect(await custody(d25["500"])).toMatchObject({ custody: 14 })
  })

  it("reintentos con la misma clave no duplican; misma clave con otros datos → 409", async () => {
    const body = {
      chipSetId: set25.id,
      lines: [{ denominationId: d25["25"], quantity: 7 }],
      reason: "Reposición",
      idempotencyKey: key(),
    }
    const results = await Promise.all([
      post(entriesRoute.POST, body),
      post(entriesRoute.POST, body),
      post(entriesRoute.POST, body),
    ])
    expect(results.map((r) => r.status)).toEqual([201, 201, 201])
    const ids = new Set(results.map((r) => (r.json.data as { id: string }).id))
    expect(ids.size).toBe(1)
    expect(
      results.filter((r) => (r.json.data as { replayed: boolean }).replayed)
    ).toHaveLength(2)
    expect(await custody(d25["25"])).toMatchObject({ custody: 57 })

    const tampered = await post(entriesRoute.POST, {
      ...body,
      lines: [{ denominationId: d25["25"], quantity: 70 }],
    })
    expect(tampered.status).toBe(409)
    expect(await custody(d25["25"])).toMatchObject({ custody: 57 })
  })

  it("concurrencia: dos entradas simultáneas no pierden actualizaciones", async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        post(entriesRoute.POST, {
          chipSetId: set25.id,
          lines: [{ denominationId: d25["25"], quantity: 5 }],
          reason: "Entrada concurrente",
          idempotencyKey: key(),
        })
      )
    )
    expect(await custody(d25["25"])).toMatchObject({ custody: 90 })
    expect(await custodyFromLedger(d25["25"])).toBe(90)
  })

  it("concurrencia: retiros simultáneos nunca dejan existencias negativas (50 → 40 y 30)", async () => {
    const withdraw = (quantity: number) =>
      post(withdrawalsRoute.POST, {
        chipSetId: set25.id,
        category: "OTHER",
        lines: [{ denominationId: d25["100"], quantity }],
        reason: "Retiro concurrente",
        idempotencyKey: key(),
      })
    const [a, b] = await Promise.all([withdraw(40), withdraw(30)])
    expect([a.status, b.status].sort()).toEqual([201, 422])
    const after = await custody(d25["100"])
    expect(after.custody).toBeGreaterThanOrEqual(0)
    expect([10, 20]).toContain(after.custody)
    expect(after.custody + after.retired).toBe(50)
    expect(await custodyFromLedger(d25["100"])).toBe(after.custody)
  })

  it("los movimientos confirmados son inmutables y no hay endpoint de borrado", async () => {
    const [movement] = await prisma.chipInventoryMovement.findMany({ take: 1 })
    await expect(
      prisma.chipInventoryMovement.update({
        where: { id: movement.id },
        data: { quantity: 999 },
      })
    ).rejects.toThrow()
    await expect(
      prisma.chipInventoryMovement.delete({ where: { id: movement.id } })
    ).rejects.toThrow()
    await expect(prisma.chipInventoryOperation.deleteMany({})).rejects.toThrow()
    expect("DELETE" in movementsRoute).toBe(false)
  })

  it("el historial filtra y pagina; la lectura no modifica inventario", async () => {
    const before = await prisma.chipInventoryMovement.count()
    const res = await call(movementsRoute.GET, {
      path: `/api/chip-inventory/movements?chipSetId=${set25.id}&type=INITIAL_STOCK&pageSize=2`,
    })
    const data = res.json.data as {
      items: { movementType: string; createdBy: { name: string } }[]
      total: number
      totalPages: number
    }
    expect(data.total).toBe(3)
    expect(data.items).toHaveLength(2)
    expect(data.totalPages).toBe(2)
    expect(data.items.every((m) => m.movementType === "INITIAL_STOCK")).toBe(
      true
    )
    await call(inventoryRoute.GET)
    await call(inventoryByIdRoute.GET, { params: { chipSetId: set25.id } })
    expect(await prisma.chipInventoryMovement.count()).toBe(before)
  })

  it("el inventario persiste: la vista por juego refleja la custodia y el valor nominal", async () => {
    const res = await call(inventoryByIdRoute.GET, {
      params: { chipSetId: set25.id },
    })
    expect(res.json.data).toMatchObject({
      initialized: true,
      container: { code: "INVENTARIO-GENERAL" },
      totals: {
        custody: 110,
        available: 110,
        reserved: 0,
        circulation: 0,
        custodyNominal: "11250.00",
      },
    })
  })
})

describe("arqueos y conciliación", () => {
  let countId: string

  beforeEach(async () => {
    await asRole("CASHIER")
    await initialize(set25.id, { "25": 100, "100": 100, "500": 10 }, d25)
    const created = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id },
    })
    countId = (created.json.data as { id: string }).id
  })

  async function capture(lines: Record<string, number>) {
    return call(countByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: countId },
      body: {
        lines: Object.entries(lines).map(([v, q]) => ({
          denominationId: d25[v],
          countedQuantity: q,
        })),
      },
    })
  }

  it("detecta diferencias por denominación (aunque el total nominal cuadre) sin ajustar al confirmar", async () => {
    // -4 × $25 = -$100 y +1 × $100 = +$100: total nominal 0, pero NO cuadra.
    await capture({ "25": 96, "100": 101, "500": 10 })
    const view = await call(countByIdRoute.GET, { params: { id: countId } })
    expect(
      (
        view.json.data as { details: { differenceQuantity: number }[] }
      ).details.map((d) => d.differenceQuantity)
    ).toEqual([-4, 1, 0])

    const confirmed = await call(confirmRoute.POST, {
      method: "POST",
      params: { id: countId },
      body: { idempotencyKey: key() },
    })
    expect(confirmed.json.data).toMatchObject({
      status: "CONFIRMED",
      reconciliationStatus: "PENDING",
      differenceTotal: "0.00",
    })
    // Confirmar NO ajusta inventario.
    expect(await custody(d25["25"])).toMatchObject({ custody: 100 })

    // Un arqueo confirmado es inmutable.
    expect((await capture({ "25": 1 })).status).toBe(422)
    await expect(
      prisma.chipStockCount.update({
        where: { id: countId },
        data: { notes: "x" },
      })
    ).rejects.toThrow()
  })

  it("concilia una sola vez, con motivo y referencia al arqueo", async () => {
    await capture({ "25": 98, "100": 100, "500": 11 })
    await call(confirmRoute.POST, {
      method: "POST",
      params: { id: countId },
      body: { idempotencyKey: key() },
    })

    expect(
      (
        await call(reconcileRoute.POST, {
          method: "POST",
          params: { id: countId },
          body: { idempotencyKey: key() },
        })
      ).status
    ).toBe(400)

    const body = {
      reason: "Faltan 2 fichas de $25 y sobra 1 de $500",
      idempotencyKey: key(),
    }
    const results = await Promise.all([
      call(reconcileRoute.POST, {
        method: "POST",
        params: { id: countId },
        body,
      }),
      call(reconcileRoute.POST, {
        method: "POST",
        params: { id: countId },
        body: { ...body, idempotencyKey: key() },
      }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(await custody(d25["25"])).toMatchObject({ custody: 98 })
    expect(await custody(d25["500"])).toMatchObject({ custody: 11 })
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "COUNT_RECONCILIATION" },
      })
    ).toBe(1)

    const count = await prisma.chipStockCount.findUniqueOrThrow({
      where: { id: countId },
    })
    expect(count.reconciliationStatus).toBe("RECONCILED")
    const adjustments = await prisma.chipInventoryMovement.findMany({
      where: { referenceId: countId },
    })
    expect(adjustments.map((m) => m.movementType)).toEqual([
      "INVENTORY_ADJUSTMENT",
      "INVENTORY_ADJUSTMENT",
    ])
    expect(await auditRows("CHIP_COUNT_RECONCILED")).toHaveLength(1)
  })

  it("no confirma un arqueo con esperado obsoleto; exige actualizar y volver a contar", async () => {
    await capture({ "25": 100, "100": 100, "500": 10 })
    await post(entriesRoute.POST, {
      chipSetId: set25.id,
      lines: [{ denominationId: d25["25"], quantity: 5 }],
      reason: "Entrada durante el conteo",
      idempotencyKey: key(),
    })
    const stale = await call(confirmRoute.POST, {
      method: "POST",
      params: { id: countId },
      body: { idempotencyKey: key() },
    })
    expect(stale.status).toBe(409)

    const refreshed = await call(countByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: countId },
      body: { refreshExpected: true },
    })
    const details = refreshed.json.data as {
      details: { expectedQuantity: number; countedQuantity: number | null }[]
      stale: boolean
    }
    expect(details.stale).toBe(false)
    expect(details.details[0]).toMatchObject({
      expectedQuantity: 105,
      countedQuantity: null,
    })

    // Sin capturar de nuevo no se puede confirmar.
    expect(
      (
        await call(confirmRoute.POST, {
          method: "POST",
          params: { id: countId },
          body: { idempotencyKey: key() },
        })
      ).status
    ).toBe(400)
    await capture({ "25": 105 })
    expect(
      (
        await call(confirmRoute.POST, {
          method: "POST",
          params: { id: countId },
          body: { idempotencyKey: key() },
        })
      ).json.data
    ).toMatchObject({
      status: "CONFIRMED",
      reconciliationStatus: "NOT_REQUIRED",
    })
  })

  it("el esperado es el VALOR nominal bajo custodia: incluye lo reservado y excluye lo entregado", async () => {
    await call(cancelRoute.POST, { method: "POST", params: { id: countId } })
    const actor = await createUser({ role: "CASHIER" })
    const sessionUser = { ...actor, role: "CASHIER" as const }
    const reserve = (amount: string, referenceId: string) =>
      reserveNominalAmount(sessionUser, {
        amount,
        referenceType: "TEST_PURCHASE",
        referenceId,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: key(),
      })
    await reserve("3000", "compra-1")
    const delivered = await reserve("1000", "compra-2")
    await confirmNominalChipDelivery(sessionUser, delivered.id, key())

    const created = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id },
    })
    // $17,500 iniciales − $1,000 entregados (los $3,000 reservados siguen ahí).
    expect(created.json.data).toMatchObject({
      expectedTotal: "16500.00",
      breakdownExact: false,
    })
    const detail = (
      created.json.data as {
        details: { denominationId: string; expectedQuantity: number }[]
      }
    ).details.find((d) => d.denominationId === d25["100"])
    // Sin desglose de la entrega: la cantidad por denominación es solo referencia.
    expect(detail?.expectedQuantity).toBe(100)
  })

  it("solo un borrador por juego", async () => {
    const second = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id },
    })
    expect(second.status).toBe(409)
  })
})

describe("inventario nominal: compras y recompras por importe (contratos internos)", () => {
  let actor: Parameters<typeof reserveNominalAmount>[0]
  let t25: string
  let t10: string

  beforeEach(async () => {
    await asRole("CASHIER")
    // $2,500 + $5,000 + $5,000 = $12,500 bajo custodia.
    await initialize(set25.id, { "25": 100, "100": 50, "500": 10 }, d25)
    const user = await createUser({ role: "CASHIER" })
    actor = { ...user, role: "CASHIER" }
    t25 = (
      await prisma.pokerTable.findUniqueOrThrow({
        where: { code: "TABLE_25_25" },
      })
    ).id
    t10 = (
      await prisma.pokerTable.findUniqueOrThrow({
        where: { code: "TABLE_10_10" },
      })
    ).id
  })

  const reserve = (amount: string, tableId?: string, playerId?: string) =>
    reserveNominalAmount(actor, {
      amount,
      tableId,
      sessionId: "SES-TEST",
      playerId,
      referenceType: "TEST_PURCHASE",
      referenceId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: key(),
    })
  const nominal = () => getAvailableNominalValue(set25.id)

  it("se compran $5,000 sin capturar denominaciones: se descuenta el valor una sola vez al entregar", async () => {
    const player = await createTestPlayer()
    const r = await reserve("5000", t25, player.id)
    // La reserva aparta valor sin descontar la custodia.
    expect(await nominal()).toMatchObject({
      custody: "12500.00",
      reserved: "5000.00",
      available: "7500.00",
    })
    await confirmNominalChipDelivery(actor, r.id, key())
    expect(await nominal()).toMatchObject({
      custody: "7500.00",
      reserved: "0.00",
      available: "7500.00",
      circulation: "5000.00",
      breakdownExact: false,
    })
    // Ningún desglose ficticio: la entrega no tiene renglones por denominación.
    expect(
      await prisma.chipInventoryMovement.count({
        where: { movementType: "CHIP_DELIVERY" },
      })
    ).toBe(0)
    expect(await prisma.chipReservationItem.count()).toBe(0)
    expect(await custody(d25["500"])).toMatchObject({ custody: 10 }) // composición de referencia intacta
    const move = await prisma.chipNominalMovement.findFirstOrThrow({
      where: { movementType: "CHIP_DELIVERY" },
    })
    expect(move).toMatchObject({
      tableId: t25,
      playerId: player.id,
      sessionId: "SES-TEST",
    })
    expect(move.amount.toFixed(2)).toBe("5000.00")
    // Ningún movimiento financiero.
    expect(await prisma.cashTransaction.count()).toBe(0)
  })

  it("las compras de ambas mesas consumen el mismo saldo y se rechaza el valor insuficiente", async () => {
    await reserve("5000", t25)
    await reserve("5000", t10)
    expect(await nominal()).toMatchObject({ available: "2500.00" })
    await expect(reserve("3000", t25)).rejects.toThrow(/insuficiente/)
    await expect(reserve("0", t25)).rejects.toThrow(/mayor que cero/)
  })

  it("concurrencia: reservas simultáneas de ambas mesas nunca dejan saldo negativo", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => reserve("3000", i % 2 ? t10 : t25))
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4)
    expect(await nominal()).toMatchObject({
      reserved: "12000.00",
      available: "500.00",
    })
  })

  it("la confirmación de entrega es idempotente (también en paralelo)", async () => {
    const r = await reserve("2000", t10)
    const [a, b] = await Promise.all([
      confirmNominalChipDelivery(actor, r.id, key()),
      confirmNominalChipDelivery(actor, r.id, key()),
    ])
    expect(a.id).toBe(b.id)
    expect(await nominal()).toMatchObject({
      custody: "10500.00",
      circulation: "2000.00",
    })
    expect(
      await prisma.chipNominalMovement.count({
        where: { movementType: "CHIP_DELIVERY" },
      })
    ).toBe(1)
  })

  it("cancelar libera la reserva una sola vez y ya no se puede entregar", async () => {
    const r = await reserve("4000", t25)
    await releaseNominalReservation(actor, r.id)
    expect(await nominal()).toMatchObject({
      reserved: "0.00",
      available: "12500.00",
    })
    expect((await releaseNominalReservation(actor, r.id)).replayed).toBe(true)
    await expect(
      confirmNominalChipDelivery(actor, r.id, key())
    ).rejects.toThrow(/no está activa/)
  })

  it("la devolución nominal (en otra mesa) regresa al mismo saldo, sin duplicar con reintento", async () => {
    await confirmNominalChipDelivery(
      actor,
      (await reserve("5000", t25)).id,
      key()
    )
    const body = {
      amount: "3000",
      tableId: t10,
      referenceType: "TEST_SETTLEMENT",
      referenceId: "liq-1",
      idempotencyKey: key(),
    }
    await confirmNominalChipReturn(actor, body)
    expect((await confirmNominalChipReturn(actor, body)).replayed).toBe(true)
    expect(await nominal()).toMatchObject({
      custody: "10500.00",
      circulation: "2000.00",
    })
    await expect(
      confirmNominalChipReturn(actor, {
        ...body,
        amount: "2500",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/circulación/)
    const ret = await prisma.chipNominalMovement.findFirstOrThrow({
      where: { movementType: "CHIP_RETURN" },
    })
    expect(ret.tableId).toBe(t10)
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "CHIP_CONVERSION" },
      })
    ).toBe(0)
  })

  it("arqueo tras entregas: compara el VALOR; si cuadra, la composición se actualiza a lo contado", async () => {
    await confirmNominalChipDelivery(
      actor,
      (await reserve("5000", t25)).id,
      key()
    )
    const created = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id },
    })
    const id = (created.json.data as { id: string }).id
    expect(created.json.data).toMatchObject({
      expectedTotal: "7500.00",
      breakdownExact: false,
    })
    // El cajero entregó las 10 de $500: físicamente quedan 25×100 + 100×50.
    await call(countByIdRoute.PATCH, {
      method: "PATCH",
      params: { id },
      body: {
        lines: [
          { denominationId: d25["25"], countedQuantity: 100 },
          { denominationId: d25["100"], countedQuantity: 50 },
          { denominationId: d25["500"], countedQuantity: 0 },
        ],
      },
    })
    const confirmed = await call(confirmRoute.POST, {
      method: "POST",
      params: { id },
      body: { idempotencyKey: key() },
    })
    expect(confirmed.json.data).toMatchObject({
      reconciliationStatus: "NOT_REQUIRED",
      differenceTotal: "0.00",
      countedTotal: "7500.00",
      current: true,
    })
    expect(await custody(d25["500"])).toMatchObject({ custody: 0 })
    expect(await nominal()).toMatchObject({
      custody: "7500.00",
      breakdownExact: true,
    })
    expect(
      await prisma.chipInventoryMovement.count({
        where: { movementType: "COMPOSITION_UPDATE" },
      })
    ).toBe(1)
    // La actualización de composición no cambió el valor.
    expect(
      await prisma.chipNominalMovement.count({
        where: { movementType: "INVENTORY_ADJUSTMENT" },
      })
    ).toBe(0)
  })

  it("arqueo con faltante de valor: exige conciliación y la aplica una sola vez", async () => {
    await confirmNominalChipDelivery(
      actor,
      (await reserve("5000", t25)).id,
      key()
    )
    const created = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id },
    })
    const id = (created.json.data as { id: string }).id
    await call(countByIdRoute.PATCH, {
      method: "PATCH",
      params: { id },
      body: {
        lines: [
          { denominationId: d25["25"], countedQuantity: 100 },
          { denominationId: d25["100"], countedQuantity: 40 },
          { denominationId: d25["500"], countedQuantity: 0 },
        ],
      },
    })
    const confirmed = await call(confirmRoute.POST, {
      method: "POST",
      params: { id },
      body: { idempotencyKey: key() },
    })
    expect(confirmed.json.data).toMatchObject({
      reconciliationStatus: "PENDING",
      differenceTotal: "-1000.00",
      current: false,
    })
    const body = {
      reason: "Faltan $1,000 tras recontar",
      idempotencyKey: key(),
    }
    const [a, b] = await Promise.all([
      call(reconcileRoute.POST, { method: "POST", params: { id }, body }),
      call(reconcileRoute.POST, { method: "POST", params: { id }, body }),
    ])
    expect([a.status, b.status].every((x) => x === 200 || x === 201)).toBe(true)
    expect(await nominal()).toMatchObject({
      custody: "6500.00",
      breakdownExact: true,
    })
    expect(await custody(d25["100"])).toMatchObject({ custody: 40 })
    const after = await call(countByIdRoute.GET, { params: { id } })
    expect(after.json.data).toMatchObject({
      reconciliationStatus: "RECONCILED",
      current: true,
    })
    // El libro nominal reconstruye el saldo.
    const moves = await prisma.chipNominalMovement.findMany()
    const rebuilt = moves.reduce(
      (acc, m) => acc.add(m.custodyAfter).sub(m.custodyBefore),
      new Prisma.Decimal(0)
    )
    expect(rebuilt.toFixed(2)).toBe("6500.00")
  })

  it("una entrada por denominación también incrementa el valor nominal", async () => {
    await post(entriesRoute.POST, {
      chipSetId: set25.id,
      lines: [{ denominationId: d25["500"], quantity: 2 }],
      reason: "Reposición",
      idempotencyKey: key(),
    })
    expect(await nominal()).toMatchObject({ custody: "13500.00" })
  })

  it("una baja no puede tomar el valor reservado para compras", async () => {
    await reserve("12000", t25)
    const res = await post(withdrawalsRoute.POST, {
      chipSetId: set25.id,
      category: "DAMAGE",
      lines: [{ denominationId: d25["500"], quantity: 2 }],
      reason: "Fichas rotas",
      idempotencyKey: key(),
    })
    expect(res.status).toBe(422)
    expect(await nominal()).toMatchObject({
      custody: "12500.00",
      reserved: "12000.00",
    })
  })

  it("las reservas vencidas se liberan de forma segura", async () => {
    await reserve("1000", t25)
    const r2 = await reserve("1000", t10)
    await prisma.chipReservation.update({
      where: { id: r2.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await expireReservations()).toBe(1)
    expect(await expireReservations()).toBe(0)
    expect(await nominal()).toMatchObject({ reserved: "1000.00" })
  })

  it("el historial nominal filtra por mesa; el tablero muestra un solo inventario", async () => {
    await confirmNominalChipDelivery(
      actor,
      (await reserve("500", t25)).id,
      key()
    )
    await confirmNominalChipDelivery(
      actor,
      (await reserve("700", t10)).id,
      key()
    )
    const res = await call(nominalMovementsRoute.GET, {
      path: `/api/chip-inventory/nominal-movements?tableId=${t10}`,
    })
    const items = (
      res.json.data as {
        items: { amount: string; table: { id: string } | null }[]
      }
    ).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ amount: "700.00", table: { id: t10 } })
    const inventory = await call(inventoryRoute.GET)
    expect(inventory.json.data as unknown[]).toHaveLength(1)
    expect(
      (inventory.json.data as { nominal: { circulation: string } }[])[0].nominal
        .circulation
    ).toBe("1200.00")
  })

  it("los ajustes sobre el inventario común conservan motivo, auditoría y valor", async () => {
    const res = await post(adjustmentsRoute.POST, {
      chipSetId: set25.id,
      denominationId: d25["100"],
      kind: "SHORTAGE",
      quantity: 2,
      reason: "Faltan dos fichas tras el conteo",
      idempotencyKey: key(),
    })
    expect(res.status).toBe(201)
    const op = await prisma.chipInventoryOperation.findFirstOrThrow({
      where: { type: "INVENTORY_ADJUSTMENT" },
    })
    expect(op.reason).toBe("Faltan dos fichas tras el conteo")
    expect(await auditRows("CHIP_INVENTORY_ADJUSTED")).toHaveLength(1)
    expect(await nominal()).toMatchObject({ custody: "12300.00" })
  })
})

describe("permisos y reglas del catálogo", () => {
  it("401 sin sesión", async () => {
    signOut()
    expect((await call(inventoryRoute.GET)).status).toBe(401)
    expect((await post(entriesRoute.POST, {})).status).toBe(401)
  })

  it("403 para un usuario con credencial temporal pendiente", async () => {
    const user = await createUser({ role: "CASHIER", mustChangePassword: true })
    signInAs(user)
    expect((await call(inventoryRoute.GET)).status).toBe(403)
    expect(
      (await initialize(set25.id, { "25": 1, "100": 1, "500": 1 }, d25)).status
    ).toBe(403)
  })

  it("no se cambia el valor de una denominación con movimientos ni se desactiva un juego con fichas", async () => {
    await asRole("SUPERADMIN")
    await initialize(set25.id, { "25": 10, "100": 10, "500": 10 }, d25)
    const res = await call(denominationByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: d25["25"] },
      body: { value: "30" },
    })
    expect(res.status).toBe(422)
    // Primero hay que liberar la mesa; aun así, con fichas no se desactiva.
    await prisma.pokerTable.updateMany({
      where: { defaultChipSetId: set25.id },
      data: { isActive: false },
    })
    const off = await call(chipSetStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: set25.id },
      body: { isActive: false },
    })
    expect(off.status).toBe(422)
  })

  it("no se crean arqueos de apertura/cierre desde la API (los creará el módulo de sesiones)", async () => {
    await asRole("CASHIER")
    await initialize(set25.id, { "25": 1, "100": 1, "500": 1 }, d25)
    const res = await call(countsRoute.POST, {
      method: "POST",
      body: { chipSetId: set25.id, countType: "OPENING" },
    })
    expect(res.status).toBe(400)
  })

  it("no existe ningún movimiento financiero asociado al inventario", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ~* '(cash_movement|payment_transaction|ledger_entr)'
    `
    expect(tables).toEqual([])
  })
})
