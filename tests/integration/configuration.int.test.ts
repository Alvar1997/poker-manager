import { beforeEach, describe, expect, it } from "vitest"

import * as bankRoute from "@/app/api/settings/bank-account/route"
import * as cashBoxRoute from "@/app/api/settings/cash-box/route"
import * as folioByIdRoute from "@/app/api/settings/folios/[id]/route"
import * as foliosRoute from "@/app/api/settings/folios/route"
import * as generalRoute from "@/app/api/settings/general/route"
import * as operationalRoute from "@/app/api/settings/operational/route"
import * as whatsappRoute from "@/app/api/settings/whatsapp/route"
import * as chipSetByIdRoute from "@/app/api/chip-sets/[id]/route"
import * as denominationsRoute from "@/app/api/chip-sets/[id]/denominations/route"
import * as chipSetStatusRoute from "@/app/api/chip-sets/[id]/status/route"
import * as chipSetsRoute from "@/app/api/chip-sets/route"
import * as denominationByIdRoute from "@/app/api/denominations/[id]/route"
import * as denominationStatusRoute from "@/app/api/denominations/[id]/status/route"
import * as paymentMethodByIdRoute from "@/app/api/payment-methods/[id]/route"
import * as paymentMethodsRoute from "@/app/api/payment-methods/route"
import * as tableByIdRoute from "@/app/api/tables/[id]/route"
import * as tableStatusRoute from "@/app/api/tables/[id]/status/route"
import * as tablesRoute from "@/app/api/tables/route"
import { prisma } from "@/lib/prisma"
import { seedConfiguration } from "@/modules/settings/configuration.seed"
import { issueFolio } from "@/modules/settings/folio.service"

import {
  auditRows,
  call,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"
import { ALL_TABLES } from "./tables"

beforeEach(resetDatabase)

async function asRole(role: "SUPERADMIN" | "PARTNER" | "CASHIER") {
  const user = await createUser({ role })
  signInAs(user)
  return user
}

async function chipSetByCode(code: string) {
  return prisma.chipSet.findUniqueOrThrow({ where: { code } })
}

describe("datos iniciales (seed)", () => {
  it("existe una sola caja central MAIN, sin saldo", async () => {
    const boxes = await prisma.cashBox.findMany()
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({
      code: "MAIN",
      name: "Caja Central",
      currency: "MXN",
      isActive: true,
    })
    expect(Object.keys(boxes[0])).not.toContain("balance")
  })

  it("la base impide una segunda caja (CHECK code = 'MAIN' y código único)", async () => {
    await expect(
      prisma.cashBox.create({ data: { code: "MESA_10", name: "Caja Mesa 10" } })
    ).rejects.toThrow()
    await expect(
      prisma.cashBox.create({ data: { code: "MAIN", name: "Otra" } })
    ).rejects.toThrow()
  })

  it("mesa 25/25 y mesa 10/10 comparten UN inventario físico de fichas", async () => {
    const t25 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
      include: { defaultChipSet: true },
    })
    const t10 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_10_10" },
      include: { defaultChipSet: true },
    })
    expect(t25.defaultChipSet.code).toBe("CHIPSET_MAIN")
    expect(t10.defaultChipSetId).toBe(t25.defaultChipSetId)
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
    // La base impide un segundo inventario activo.
    await expect(
      prisma.chipSet.create({ data: { code: "CHIPSET_OTRO", name: "Otro" } })
    ).rejects.toThrow()
    expect(t25.smallBlind.toFixed(2)).toBe("25.00")
    expect(t10.bigBlind.toFixed(2)).toBe("10.00")
  })

  it("no inventa denominaciones, cuentas, teléfonos ni tokens", async () => {
    expect(await prisma.chipDenomination.count()).toBe(0)

    const accounts = await prisma.paymentAccount.findMany()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      isPrimary: true,
      isActive: true,
      bankName: null,
      accountHolder: null,
      accountNumberEncrypted: null,
      clabeEncrypted: null,
    })

    const whatsapp = await prisma.whatsAppSettings.findUniqueOrThrow({
      where: { id: 1 },
    })
    expect(whatsapp).toMatchObject({
      configurationStatus: "PENDING_CONFIGURATION",
      enabled: false,
      senderPhone: null,
      phoneNumberId: null,
      businessAccountId: null,
      lastVerifiedAt: null,
    })
  })

  it("métodos de pago: efectivo, transferencia y tarjetas por terminal (sin MIXED ni CREDIT)", async () => {
    const methods = await prisma.paymentMethod.findMany({
      orderBy: { sortOrder: "asc" },
    })
    // Módulo 08: débito y crédito por terminal física. El crédito del
    // jugador sigue sin ser un método de pago.
    expect(methods.map((m) => m.code)).toEqual([
      "CASH",
      "BANK_TRANSFER",
      "CARD_DEBIT",
      "CARD_CREDIT",
    ])
  })

  it("es idempotente y no pisa lo editado", async () => {
    await prisma.cashBox.update({
      where: { code: "MAIN" },
      data: { name: "Caja Principal" },
    })
    const counts = async () =>
      Promise.all([
        prisma.businessSettings.count(),
        prisma.cashBox.count(),
        prisma.chipSet.count(),
        prisma.pokerTable.count(),
        prisma.paymentMethod.count(),
        prisma.paymentAccount.count(),
        prisma.folioSequence.count(),
        prisma.operationalSettings.count(),
        prisma.whatsAppSettings.count(),
        prisma.chipDenomination.count(),
      ])
    const before = await counts()
    expect(before).toEqual([1, 1, 1, 2, 4, 1, 13, 1, 1, 0]) // un solo inventario de fichas

    await seedConfiguration(prisma)
    await seedConfiguration(prisma)

    expect(await counts()).toEqual(before)
    expect(
      (await prisma.cashBox.findUniqueOrThrow({ where: { code: "MAIN" } })).name
    ).toBe("Caja Principal")
  })

  it("no existen tablas de movimientos, saldos ni existencias (ninguna operación financiera)", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `
    const names = rows
      .map((r) => r.table_name)
      .filter((n) => n !== "_prisma_migrations")
    expect(names.sort()).toEqual([...ALL_TABLES].sort())

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name ~* '(balance|saldo|quantity|stock|amount)'
        -- Desde el Módulo 04 existen cantidades FÍSICAS de fichas (chip_*),
        -- que no son dinero; ninguna otra tabla guarda saldos ni montos.
        AND table_name NOT LIKE 'chip\_%'
        -- Módulo 05: el libro financiero sí guarda importes y saldos.
        AND table_name NOT IN ('financial_account_balances', 'cash_transaction_entries',
                               'bank_transfer_verifications', 'cash_reconciliations',
                               'cash_reconciliation_details', 'operational_settings',
                               -- Módulo 06: evidencia de apertura con caja en $0 (CHECK = 0).
                               'session_openings',
                               -- Módulo 08: importes de compras, pagos, deudas y depósitos
                               -- de terminal (referencias al libro, nunca saldos editables).
                               'purchase_payments', 'purchase_credit_authorizations',
                               'purchase_deliveries', 'player_debts', 'card_terminal_settlements',
                               -- Módulo 09: importes HISTÓRICOS que vio el jugador al firmar.
                               'signature_snapshots',
                               -- Módulo 10: abonos, aplicaciones, fondos no aplicados y depósitos de
                               -- custodia (registros del libro; los saldos se derivan).
                               'receivable_payments', 'payment_allocations',
                               'unapplied_player_funds', 'administrative_cash_deposits',
                               -- Módulo 11: importes ACORDADOS de liquidaciones (inmutables tras la
                               -- recepción; debtBalanceSnapshot es una fotografía histórica),
                               -- cuentas por pagar y desembolsos (el pendiente se deriva) y
                               -- aportaciones documentadas a custodia.
                               'player_settlements', 'settlement_payables', 'settlement_payouts',
                               'administrative_cash_contributions',
                               -- Módulo 12: evidencias del cierre (diferencias de arqueo con su
                               -- esperado/contado, ajustes autorizados, retiro final) y
                               -- referencias a arqueos; ningún saldo editable.
                               'closure_discrepancies', 'closure_adjustment_authorizations',
                               'closure_cash_withdrawals', 'closure_approvals',
                               -- Módulo 15: importe INFORMATIVO del evento auditado y de la
                               -- solicitud de corrección (nunca un saldo ni un movimiento).
                               'audit_logs', 'correction_requests',
                               -- Módulo 16: importes de canjes, obligaciones y pagos especiales,
                               -- reversos y correcciones (hechos; los saldos se derivan).
                               'late_chip_redemptions', 'special_payables', 'special_payouts',
                               'purchase_reversals', 'settlement_corrections',
                               -- Módulo 17: porcentajes, importes de jugadas, anticipos, cortes
                               -- (snapshots), libro de reserva y regularizaciones (hechos
                               -- inmutables o con saldo DERIVADO; ninguno es un saldo editable).
                               'banking_agreement_versions', 'banking_percentage_segments',
                               'banking_percentage_change_requests', 'banking_games',
                               'banking_game_financial_sources', 'banking_game_adjustments',
                               'banking_advances', 'banking_cycle_closings',
                               'banking_reserve_movements', 'banking_reserve_withdrawals',
                               'banking_regularizations', 'banking_regularization_recoveries',
                               'banking_regularization_receipts',
                               -- Conciliación global de fichas: importe del hecho autorizado.
                               'session_chip_reconciliations',
                               -- Módulo 18: importes nominales de rake y propinas y la
                               -- diferencia registrada al cierre (hechos; nada se netea).
                               'rake_movements', 'rake_counts', 'staff_tip_counts',
                               'staff_tip_entries', 'session_chip_differences')
    `
    expect(columns).toEqual([])
  })
})

describe("permisos de configuración", () => {
  it("sin sesión → 401", async () => {
    signOut()
    expect((await call(generalRoute.GET)).status).toBe(401)
    expect((await call(tablesRoute.GET)).status).toBe(401)
  })

  it("PARTNER consulta toda la configuración no secreta", async () => {
    await asRole("PARTNER")
    for (const handler of [
      generalRoute.GET,
      cashBoxRoute.GET,
      bankRoute.GET,
      foliosRoute.GET,
      operationalRoute.GET,
      whatsappRoute.GET,
      tablesRoute.GET,
      chipSetsRoute.GET,
      paymentMethodsRoute.GET,
    ]) {
      expect((await call(handler)).status).toBe(200)
    }
  })

  it("PARTNER no modifica configuración crítica (403 y auditado)", async () => {
    await asRole("PARTNER")
    const set = await chipSetByCode("CHIPSET_MAIN")
    const table = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
    const folio = await prisma.folioSequence.findFirstOrThrow()
    const method = await prisma.paymentMethod.findFirstOrThrow()

    const attempts = [
      call(generalRoute.PATCH, {
        method: "PATCH",
        body: { businessName: "X" },
      }),
      call(cashBoxRoute.PATCH, { method: "PATCH", body: { name: "Caja X" } }),
      call(bankRoute.PATCH, { method: "PATCH", body: { bankName: "Banco" } }),
      call(tablesRoute.POST, {
        method: "POST",
        body: {
          code: "TABLE_X",
          name: "Mesa X",
          smallBlind: "5",
          bigBlind: "5",
          defaultChipSetId: set.id,
        },
      }),
      call(tableByIdRoute.PATCH, {
        method: "PATCH",
        params: { id: table.id },
        body: { name: "Y" },
      }),
      call(tableStatusRoute.PATCH, {
        method: "PATCH",
        params: { id: table.id },
        body: { isActive: false },
      }),
      call(chipSetsRoute.POST, {
        method: "POST",
        body: { code: "CHIPSET_X", name: "Juego X" },
      }),
      call(denominationsRoute.POST, {
        method: "POST",
        params: { id: set.id },
        body: { value: "25" },
      }),
      call(folioByIdRoute.PATCH, {
        method: "PATCH",
        params: { id: folio.id },
        body: { prefix: "X" },
      }),
      call(paymentMethodByIdRoute.PATCH, {
        method: "PATCH",
        params: { id: method.id },
        body: { isActive: false },
      }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403)
    }
    expect((await auditRows("AUTH_ACCESS_DENIED")).length).toBe(attempts.length)
    expect(
      (await prisma.businessSettings.findUniqueOrThrow({ where: { id: 1 } }))
        .businessName
    ).toBe("Poker Manager")
  })

  it("CASHIER consulta catálogos autorizados, solo activos", async () => {
    const admin = await asRole("SUPERADMIN")
    const t10 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_10_10" },
    })
    await call(tableStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: t10.id },
      body: { isActive: false },
    })
    void admin

    await asRole("CASHIER")
    for (const handler of [
      generalRoute.GET,
      operationalRoute.GET,
      chipSetsRoute.GET,
      paymentMethodsRoute.GET,
    ]) {
      expect((await call(handler)).status).toBe(200)
    }
    const tables = await call(tablesRoute.GET)
    expect(tables.status).toBe(200)
    expect((tables.json.data as { code: string }[]).map((t) => t.code)).toEqual(
      ["TABLE_25_25"]
    )
    expect(
      (await call(tableByIdRoute.GET, { params: { id: t10.id } })).status
    ).toBe(404)

    const set = await chipSetByCode("CHIPSET_MAIN")
    expect(
      (await call(denominationsRoute.GET, { params: { id: set.id } })).status
    ).toBe(200)
  })

  it("CASHIER no ve datos bancarios, folios, caja ni WhatsApp, ni modifica nada", async () => {
    await asRole("CASHIER")
    for (const handler of [
      bankRoute.GET,
      foliosRoute.GET,
      cashBoxRoute.GET,
      whatsappRoute.GET,
    ]) {
      expect((await call(handler)).status).toBe(403)
    }
    expect(
      (
        await call(generalRoute.PATCH, {
          method: "PATCH",
          body: { businessName: "X" },
        })
      ).status
    ).toBe(403)
  })
})

describe("configuración general y caja (SUPERADMIN)", () => {
  it("edita los datos generales y audita; moneda/zona horaria/id no son editables", async () => {
    await asRole("SUPERADMIN")
    const res = await call(generalRoute.PATCH, {
      method: "PATCH",
      body: { businessName: "Club Monterrey", timeFormat: "H24" },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      businessName: "Club Monterrey",
      timeFormat: "H24",
      currency: "MXN",
      timezone: "America/Monterrey",
    })
    const [audit] = await auditRows("SETTINGS_BUSINESS_UPDATED")
    expect(audit.metadata).toMatchObject({
      changes: {
        businessName: { from: "Poker Manager", to: "Club Monterrey" },
      },
    })

    for (const body of [
      { currency: "USD" },
      { timezone: "UTC" },
      { id: 2 },
      { updatedAt: "2020-01-01" },
    ]) {
      expect(
        (await call(generalRoute.PATCH, { method: "PATCH", body })).status
      ).toBe(400)
    }
    expect(await prisma.businessSettings.count()).toBe(1)
  })

  it("la base impide un segundo registro de configuración general", async () => {
    await expect(
      prisma.businessSettings.create({ data: { id: 2, businessName: "Otro" } })
    ).rejects.toThrow()
  })

  it("renombra la caja; código y moneda no son editables", async () => {
    await asRole("SUPERADMIN")
    expect(
      (
        await call(cashBoxRoute.PATCH, {
          method: "PATCH",
          body: { name: "Caja Principal" },
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(cashBoxRoute.PATCH, {
          method: "PATCH",
          body: { name: "X1", code: "OTRA" },
        })
      ).status
    ).toBe(400)
    expect(await auditRows("SETTINGS_CASH_BOX_UPDATED")).toHaveLength(1)
  })
})

describe("juegos de fichas y denominaciones", () => {
  it("solo hay un inventario activo: un juego nuevo nace inactivo y no puede activarse", async () => {
    await asRole("SUPERADMIN")
    const created = await call(chipSetsRoute.POST, {
      method: "POST",
      body: { code: "CHIPSET_FUTURO", name: "Juego futuro" },
    })
    expect(created.status).toBe(201)
    expect(created.json.data).toMatchObject({ isActive: false })
    const activate = await call(chipSetStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: (created.json.data as { id: string }).id },
      body: { isActive: true },
    })
    expect(activate.status).toBe(422)
    expect(activate.json.error?.message).toContain(
      "Solo puede haber un inventario"
    )
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
  })

  it("no permite denominaciones duplicadas en el mismo juego (409)", async () => {
    await asRole("SUPERADMIN")
    const set = await chipSetByCode("CHIPSET_MAIN")
    await call(denominationsRoute.POST, {
      method: "POST",
      params: { id: set.id },
      body: { value: "100" },
    })
    const dup = await call(denominationsRoute.POST, {
      method: "POST",
      params: { id: set.id },
      body: { value: "100.00" },
    })
    expect(dup.status).toBe(409)
    expect(await prisma.chipDenomination.count()).toBe(1)
  })

  it.each(["0", "0.00", "-5", "abc", "1.234", ""])(
    "rechaza el valor %j (debe ser > 0 con hasta 2 decimales)",
    async (value) => {
      await asRole("SUPERADMIN")
      const set = await chipSetByCode("CHIPSET_MAIN")
      const res = await call(denominationsRoute.POST, {
        method: "POST",
        params: { id: set.id },
        body: { value },
      })
      expect(res.status).toBe(400)
    }
  )

  it("rechaza montos como number (nunca Float) y la base impide valores ≤ 0", async () => {
    await asRole("SUPERADMIN")
    const set = await chipSetByCode("CHIPSET_MAIN")
    const res = await call(denominationsRoute.POST, {
      method: "POST",
      params: { id: set.id },
      body: { value: 25 },
    })
    expect(res.status).toBe(400)
    await expect(
      prisma.chipDenomination.create({
        data: { chipSetId: set.id, value: "0" },
      })
    ).rejects.toThrow()
  })

  it("edita, desactiva y reactiva una denominación sin borrarla", async () => {
    await asRole("SUPERADMIN")
    const set = await chipSetByCode("CHIPSET_MAIN")
    const created = await call(denominationsRoute.POST, {
      method: "POST",
      params: { id: set.id },
      body: { value: "5", name: "Cinco" },
    })
    const id = (created.json.data as { id: string }).id

    const edited = await call(denominationByIdRoute.PATCH, {
      method: "PATCH",
      params: { id },
      body: { color: "Rojo", value: "10" },
    })
    expect(edited.json.data).toMatchObject({ color: "Rojo", value: "10.00" })

    const off = await call(denominationStatusRoute.PATCH, {
      method: "PATCH",
      params: { id },
      body: { isActive: false },
    })
    expect(off.json.data).toMatchObject({ isActive: false })
    expect(await prisma.chipDenomination.count()).toBe(1)
    expect(await auditRows("CHIP_DENOMINATION_DEACTIVATED")).toHaveLength(1)

    expect("DELETE" in denominationByIdRoute).toBe(false)
  })

  it("crea juegos con código único e inmutable", async () => {
    await asRole("SUPERADMIN")
    const res = await call(chipSetsRoute.POST, {
      method: "POST",
      body: { code: "chipset_torneo", name: "Fichas Torneo" },
    })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({
      code: "CHIPSET_TORNEO",
      needsDenominations: true,
      isActive: false,
    })
    const id = (res.json.data as { id: string }).id

    expect(
      (
        await call(chipSetsRoute.POST, {
          method: "POST",
          body: { code: "CHIPSET_TORNEO", name: "Otro" },
        })
      ).status
    ).toBe(409)
    expect(
      (
        await call(chipSetByIdRoute.PATCH, {
          method: "PATCH",
          params: { id },
          body: { code: "OTRO" },
        })
      ).status
    ).toBe(400)
  })

  it("no desactiva un juego asignado a una mesa activa", async () => {
    await asRole("SUPERADMIN")
    const set = await chipSetByCode("CHIPSET_MAIN")
    const res = await call(chipSetStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: set.id },
      body: { isActive: false },
    })
    expect(res.status).toBe(422)
  })
})

describe("mesas", () => {
  it("SUPERADMIN crea una mesa que usa el inventario compartido, sin crear cajas", async () => {
    await asRole("SUPERADMIN")
    const shared = await chipSetByCode("CHIPSET_MAIN")
    const res = await call(tablesRoute.POST, {
      method: "POST",
      body: {
        code: "TABLE_50_50",
        name: "Mesa 50/50",
        smallBlind: "50",
        bigBlind: "100",
        defaultChipSetId: shared.id,
      },
    })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({
      code: "TABLE_50_50",
      smallBlind: "50.00",
      bigBlind: "100.00",
      readyForSession: false,
      pendingRequirements: [
        "El juego de fichas no tiene denominaciones activas",
      ],
    })
    expect(await prisma.cashBox.count()).toBe(1)
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
    expect(await auditRows("TABLE_CREATED")).toHaveLength(1)
  })

  it("varias mesas activas comparten el mismo inventario físico", async () => {
    await asRole("SUPERADMIN")
    const shared = await chipSetByCode("CHIPSET_MAIN")
    const res = await call(tablesRoute.POST, {
      method: "POST",
      body: {
        code: "TABLE_OTRA",
        name: "Otra",
        smallBlind: "5",
        bigBlind: "5",
        defaultChipSetId: shared.id,
      },
    })
    expect(res.status).toBe(201)
    expect(
      await prisma.pokerTable.count({
        where: { isActive: true, defaultChipSetId: shared.id },
      })
    ).toBe(3)
  })

  it("valida ciegas (> 0, grande ≥ chica) y no acepta juegos inactivos o inexistentes", async () => {
    await asRole("SUPERADMIN")
    const t25 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })

    expect(
      (
        await call(tableByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: t25.id },
          body: { bigBlind: "10" },
        })
      ).status
    ).toBe(422)
    expect(
      (
        await call(tableByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: t25.id },
          body: { smallBlind: "0" },
        })
      ).status
    ).toBe(400)

    const created = await call(chipSetsRoute.POST, {
      method: "POST",
      body: { code: "CHIPSET_VIEJO", name: "Viejo" },
    })
    const oldId = (created.json.data as { id: string }).id
    await call(chipSetStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: oldId },
      body: { isActive: false },
    })
    expect(
      (
        await call(tableByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: t25.id },
          body: { defaultChipSetId: oldId },
        })
      ).status
    ).toBe(422)
    expect(
      (
        await call(tableByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: t25.id },
          body: { defaultChipSetId: "noexiste" },
        })
      ).status
    ).toBe(422)
  })

  it("edita ciegas con auditoría (antes/después) y desactiva sin borrar", async () => {
    await asRole("SUPERADMIN")
    const t10 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_10_10" },
    })
    const res = await call(tableByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: t10.id },
      body: { smallBlind: "10", bigBlind: "20" },
    })
    expect(res.json.data).toMatchObject({
      smallBlind: "10.00",
      bigBlind: "20.00",
    })
    const [audit] = await auditRows("TABLE_UPDATED")
    expect(audit.metadata).toMatchObject({
      changes: { bigBlind: { from: "10.00", to: "20.00" } },
    })

    const off = await call(tableStatusRoute.PATCH, {
      method: "PATCH",
      params: { id: t10.id },
      body: { isActive: false },
    })
    expect(off.json.data).toMatchObject({ isActive: false })
    expect(await prisma.pokerTable.count()).toBe(2)
    expect("DELETE" in tableByIdRoute).toBe(false)
  })

  it("una mesa queda lista para sesión al tener denominaciones activas", async () => {
    await asRole("SUPERADMIN")
    const set = await chipSetByCode("CHIPSET_MAIN")
    await call(denominationsRoute.POST, {
      method: "POST",
      params: { id: set.id },
      body: { value: "25" },
    })
    const t25 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
    const res = await call(tableByIdRoute.GET, { params: { id: t25.id } })
    expect(res.json.data).toMatchObject({
      readyForSession: true,
      pendingRequirements: [],
    })
  })
})

describe("métodos de pago", () => {
  it("SUPERADMIN renombra y desactiva, pero siempre queda uno activo", async () => {
    await asRole("SUPERADMIN")
    const cash = await prisma.paymentMethod.findUniqueOrThrow({
      where: { code: "CASH" },
    })
    const others = await prisma.paymentMethod.findMany({
      where: { code: { not: "CASH" } },
    })
    for (const other of others) {
      expect(
        (
          await call(paymentMethodByIdRoute.PATCH, {
            method: "PATCH",
            params: { id: other.id },
            body: { isActive: false },
          })
        ).status
      ).toBe(200)
    }
    expect(
      (
        await call(paymentMethodByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: cash.id },
          body: { isActive: false },
        })
      ).status
    ).toBe(422)
    expect(
      (
        await call(paymentMethodByIdRoute.PATCH, {
          method: "PATCH",
          params: { id: cash.id },
          body: { code: "MIXED" },
        })
      ).status
    ).toBe(400)
  })
})

describe("cuenta bancaria única", () => {
  const CLABE = "002010077777777771" // CLABE sintética de prueba con dígito de control válido

  it("la base impide dos cuentas activas y principales", async () => {
    await expect(
      prisma.paymentAccount.create({ data: { name: "Otra", isPrimary: true } })
    ).rejects.toThrow()
  })

  it("captura datos cifrados y solo expone los últimos 4 dígitos", async () => {
    await asRole("SUPERADMIN")
    const res = await call(bankRoute.PATCH, {
      method: "PATCH",
      body: {
        bankName: "Banco de Prueba",
        accountHolder: "Titular de Prueba",
        clabe: CLABE,
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      clabeMasked: "•••• 7771",
      isConfigured: true,
    })
    expect(res.text).not.toContain(CLABE)
    expect(res.text).not.toMatch(/Encrypted/)

    const stored = await prisma.paymentAccount.findFirstOrThrow({
      where: { isPrimary: true },
    })
    expect(stored.clabeEncrypted).not.toContain(CLABE)
    const audits = await auditRows()
    expect(JSON.stringify(audits)).not.toContain(CLABE)
  })

  it("rechaza CLABE con dígito de control incorrecto", async () => {
    await asRole("SUPERADMIN")
    const res = await call(bankRoute.PATCH, {
      method: "PATCH",
      body: { clabe: "002010077777777772" },
    })
    expect(res.status).toBe(400)
  })

  it("cambiar los números de una cuenta capturada conserva la anterior (historial)", async () => {
    await asRole("SUPERADMIN")
    await call(bankRoute.PATCH, {
      method: "PATCH",
      body: { accountNumber: "1234567890" },
    })
    const first = await prisma.paymentAccount.findFirstOrThrow({
      where: { isPrimary: true },
    })

    const res = await call(bankRoute.PATCH, {
      method: "PATCH",
      body: { accountNumber: "9876543210" },
    })
    expect(res.json.data).toMatchObject({
      accountNumberMasked: "•••• 3210",
      previousAccounts: 1,
    })

    const all = await prisma.paymentAccount.findMany()
    expect(all).toHaveLength(2)
    expect(all.filter((a) => a.isActive && a.isPrimary)).toHaveLength(1)
    expect(all.find((a) => a.id === first.id)).toMatchObject({
      isActive: false,
      isPrimary: false,
    })
    expect(await auditRows("BANK_ACCOUNT_REPLACED")).toHaveLength(1)
  })

  it("no acepta campos de credenciales bancarias", async () => {
    await asRole("SUPERADMIN")
    for (const body of [
      { password: "x" },
      { token: "x" },
      { isPrimary: false },
    ]) {
      expect(
        (await call(bankRoute.PATCH, { method: "PATCH", body })).status
      ).toBe(400)
    }
  })
})

describe("folios", () => {
  it("vista previa y edición del formato antes de emitir", async () => {
    await asRole("SUPERADMIN")
    const list = await call(foliosRoute.GET)
    const folios = list.json.data as {
      id: string
      documentType: string
      preview: string
      locked: boolean
    }[]
    expect(folios).toHaveLength(13) // Módulos 15–16: COR-, INC-, CAN-, REV-, AJL-, PES-
    // Sesiones: formato fijo S-0001-AAAAMMDD (fecha operativa al crear).
    const session = folios.find((f) => f.documentType === "SESSION")!
    expect(session).toMatchObject({
      preview: "S-0001-AAAAMMDD",
      locked: false,
    })
    const fixed = await call(folioByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: session.id },
      body: { prefix: "ses", padding: 6 },
    })
    expect(fixed.status).toBe(422)

    const purchase = folios.find((f) => f.documentType === "PURCHASE")!
    expect(purchase.preview).toBe("CMP-000001")
    const res = await call(folioByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: purchase.id },
      body: { prefix: "cmp", padding: 4 },
    })
    expect(res.json.data).toMatchObject({ preview: "CMP-0001" })
    expect(await auditRows("FOLIO_SEQUENCE_UPDATED")).toHaveLength(1)
  })

  it("emite folios únicos y consecutivos bajo concurrencia", async () => {
    const issued = await Promise.all(
      Array.from({ length: 25 }, () => issueFolio(prisma, "PURCHASE"))
    )
    expect(new Set(issued).size).toBe(25)
    expect([...issued].sort()).toEqual(
      Array.from(
        { length: 25 },
        (_, i) => `CMP-${String(i + 1).padStart(6, "0")}`
      )
    )
  })

  it("tras emitir, el formato queda bloqueado (no se reutilizan ni reinician folios)", async () => {
    await issueFolio(prisma, "SETTLEMENT")
    await asRole("SUPERADMIN")
    const seq = await prisma.folioSequence.findUniqueOrThrow({
      where: { documentType: "SETTLEMENT" },
    })
    const res = await call(folioByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: seq.id },
      body: { nextNumber: 1 },
    })
    expect(res.status).toBe(422)
    expect(await issueFolio(prisma, "SETTLEMENT")).toBe("LIQ-000002")
  })
})

describe("WhatsApp pendiente y políticas", () => {
  it("permanece sin configurar y el módulo funciona sin teléfono", async () => {
    await asRole("SUPERADMIN")
    const res = await call(whatsappRoute.GET)
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      provider: "META_CLOUD_API",
      configurationStatus: "PENDING_CONFIGURATION",
      enabled: false,
      senderPhone: null,
      templatesStatus: "PENDING",
      lastVerifiedAt: null,
      credentialsPresent: false,
    })
    expect((res.json.data as { notice: string }).notice).toContain(
      "No se necesitan datos reales para finalizar el Módulo 02"
    )
    expect("POST" in whatsappRoute).toBe(false)
  })

  it("la base impide habilitar WhatsApp sin configurar", async () => {
    await expect(
      prisma.whatsAppSettings.update({
        where: { id: 1 },
        data: { enabled: true },
      })
    ).rejects.toThrow()
  })

  it("expone las políticas de apertura en $0 y retiro total, y las reglas fijas", async () => {
    await asRole("CASHIER")
    const res = await call(operationalRoute.GET)
    const data = res.json.data as {
      initialCashPolicy: string
      closingCashPolicy: string
      rules: { id: string }[]
    }
    expect(data.initialCashPolicy).toBe("ZERO_OPENING_BALANCE")
    expect(data.closingCashPolicy).toBe("FULL_WITHDRAWAL")
    expect(data.rules).toHaveLength(24)
    expect("PATCH" in operationalRoute).toBe(false)
  })
})
