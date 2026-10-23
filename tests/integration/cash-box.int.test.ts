import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as confirmTransferRoute from "@/app/api/cash-box/bank-transfers/[id]/confirm/route"
import * as rejectTransferRoute from "@/app/api/cash-box/bank-transfers/[id]/reject/route"
import * as contributionsRoute from "@/app/api/cash-box/contributions/route"
import * as movementsRoute from "@/app/api/cash-box/movements/route"
import * as reverseRoute from "@/app/api/cash-box/movements/[id]/reverse/route"
import * as overviewRoute from "@/app/api/cash-box/route"
import * as withdrawalsRoute from "@/app/api/cash-box/withdrawals/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { registerPendingBankTransferInTx } from "@/modules/cash/bank-transfer.service"
import { seedFinancialAccounts } from "@/modules/cash/cash.seed"
import {
  getBalances,
  getFlowTotals,
  registerCashDeposit,
  registerContribution,
  registerWithdrawal,
  reverseTransaction,
  withdrawAllCashForClosingInTx,
} from "@/modules/cash/cash.service"
import { cashBalanceOf, cashTx } from "@/modules/cash/ledger"
import {
  recordPlayerPaymentInTx,
  recordSettlementPayoutInTx,
} from "@/modules/cash/payment-contracts"
import {
  adjustCashReconciliation,
  confirmCashReconciliation,
  createCashReconciliation,
} from "@/modules/cash/reconciliation.service"
import {
  fixtureSessionGateway,
  type SessionStatus,
} from "@/modules/cash/session-gateway"

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
type Actor = Awaited<ReturnType<typeof actorFor>>

async function actorFor(role: Role = "CASHIER") {
  const u = await createUser({ role })
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
  }
}

const sessions: Record<string, SessionStatus> = {
  S1: "OPEN",
  S2: "OPEN",
  P1: "PREPARATION",
  C1: "CLOSING",
  X1: "CLOSED",
}
const deps = { sessions: fixtureSessionGateway(sessions) }
const key = () => randomUUID()
const D = (v: string) => new Prisma.Decimal(v)

let actor: Actor

beforeEach(async () => {
  await resetDatabase()
  actor = await actorFor("CASHIER")
})

const contribute = (sessionId: string, amount: string, k = key()) =>
  registerContribution(
    actor,
    {
      sessionId,
      amount,
      contributorName: "Socio Uno",
      reason: "Fondos para pagar liquidación",
      idempotencyKey: k,
    },
    {},
    deps
  )

const withdraw = (
  sessionId: string,
  amount: string,
  reason = "Entrega al propietario",
  k = key()
) =>
  registerWithdrawal(
    actor,
    {
      sessionId,
      amount,
      destination: "OWNER_CUSTODY",
      recipientName: "Propietario",
      reason,
      idempotencyKey: k,
    },
    {},
    deps
  )

async function cash(sessionId: string) {
  return (await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)
}

/** Reconstruye el efectivo de una sesión desde el libro (fuente auditable). */
async function cashFromLedger(sessionId: string) {
  const entries = await prisma.cashTransactionEntry.findMany({
    where: { scopeKey: sessionId, account: { kind: "CASH_ON_HAND" } },
  })
  return entries
    .reduce(
      (acc, e) =>
        e.direction === "DEBIT" ? acc.add(e.amount) : acc.sub(e.amount),
      D("0")
    )
    .toFixed(2)
}

async function pendingTransfer(
  amount: string,
  referenceId = randomUUID(),
  bankReference: string | null = null
) {
  return cashTx((tx) =>
    registerPendingBankTransferInTx(tx, actor, {
      declaredAmount: D(amount),
      creditAccountKind: "PLAYER_PURCHASES",
      referenceType: "ChipPurchase",
      referenceId,
      bankReference,
      idempotencyKey: key(),
    })
  )
}

describe("caja central única y cuentas", () => {
  it("una sola caja, cuentas sembradas una vez (idempotente) y sin saldos ni movimientos", async () => {
    expect(await prisma.cashBox.count()).toBe(1)
    await seedFinancialAccounts(prisma)
    await seedFinancialAccounts(prisma)
    const accounts = await prisma.financialAccount.findMany()
    // + por liquidar (Módulo 08), custodia administrativa y no aplicados
    // (Módulo 10) y participaciones de bancaje (Módulo 17, cuenta técnica).
    expect(accounts).toHaveLength(13)
    expect(new Set(accounts.map((a) => a.cashBoxId)).size).toBe(1)
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(await prisma.financialAccountBalance.count()).toBe(0)
    expect(await prisma.bankTransferVerification.count()).toBe(0)
  })

  it("la política es apertura en $0 sin fondo ni arrastre, y la base impide cambiarla", async () => {
    const s = await prisma.operationalSettings.findUniqueOrThrow({
      where: { id: 1 },
    })
    expect(s).toMatchObject({
      initialCashPolicy: "ZERO_OPENING_BALANCE",
      closingCashPolicy: "FULL_WITHDRAWAL",
      requireOpeningCashFund: false,
      carryCashToNextSession: false,
      allowNegativeCashBalance: false,
    })
    expect(s.openingCashBalance.toFixed(2)).toBe("0.00")
    await expect(
      prisma.operationalSettings.update({
        where: { id: 1 },
        data: { openingCashBalance: "500" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.operationalSettings.update({
        where: { id: 1 },
        data: { allowNegativeCashBalance: true },
      })
    ).rejects.toThrow()
  })

  it("no existe ningún tipo de gasto operativo en el catálogo de la base", async () => {
    const types = await prisma.$queryRaw<
      { v: string }[]
    >`SELECT unnest(enum_range(NULL::"CashTransactionType"))::text AS v`
    const destinations = await prisma.$queryRaw<
      { v: string }[]
    >`SELECT unnest(enum_range(NULL::"CashWithdrawalDestination"))::text AS v`
    for (const v of [...types, ...destinations].map((r) => r.v)) {
      expect(v).not.toMatch(/EXPENSE|GASTO|OTHER/)
    }
  })
})

describe("efectivo por sesión: apertura en cero, sin arrastre, sin negativos", () => {
  it("una sesión nueva inicia en $0.00 y no hereda efectivo de otra", async () => {
    expect(await cash("S1")).toBe("0.00")
    await contribute("S1", "1000")
    expect(await cash("S1")).toBe("1000.00")
    expect(await cash("S2")).toBe("0.00")
  })

  it("aportación incrementa, retiro disminuye; ambos auditados y sin tocar otras cuentas de dinero", async () => {
    await contribute("S1", "1000")
    await withdraw("S1", "300")
    expect(await cash("S1")).toBe("700.00")
    expect(await cashFromLedger("S1")).toBe("700.00")
    expect(await auditRows("CASH_CONTRIBUTION_CREATED")).toHaveLength(1)
    expect(await auditRows("CASH_WITHDRAWAL_CREATED")).toHaveLength(1)
    const flows = await getFlowTotals()
    expect(flows).toMatchObject({
      contributions: "1000.00",
      withdrawals: "300.00",
      cashCollections: "0.00",
      bankCollectionsConfirmed: "0.00",
    })
  })

  it("rechaza retiros mayores al disponible indicando el faltante exacto", async () => {
    await contribute("S1", "1000")
    await expect(withdraw("S1", "1500")).rejects.toThrow(/Faltan \$500\.00/)
    expect(await cash("S1")).toBe("1000.00")
  })

  it("concurrencia: dos retiros simultáneos del mismo efectivo nunca dejan saldo negativo", async () => {
    await contribute("S1", "1000")
    const results = await Promise.allSettled([
      withdraw("S1", "700"),
      withdraw("S1", "600"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const balance = await cash("S1")
    expect(["300.00", "400.00"]).toContain(balance)
    expect(await cashFromLedger("S1")).toBe(balance)
  })

  it("concurrencia: muchas aportaciones simultáneas en sesiones nuevas no fallan ni pierden actualizaciones", async () => {
    // La primera operación de cada sesión crea su fila de saldo: las
    // creaciones simultáneas no deben chocar (regresión: 23505 en la PK).
    const ids = Array.from({ length: 8 }, (_, i) => `R${i}`)
    const gw = {
      sessions: fixtureSessionGateway(
        Object.fromEntries(ids.map((id) => [id, "OPEN" as const]))
      ),
    }
    for (const sessionId of ids) {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          registerContribution(
            actor,
            {
              sessionId,
              amount: "100",
              contributorName: "Socio Uno",
              reason: "Fondos",
              idempotencyKey: key(),
            },
            {},
            gw
          )
        )
      )
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
      expect(await cash(sessionId)).toBe("2000.00")
      expect(await cashFromLedger(sessionId)).toBe("2000.00")
    }
  })

  it("precisión decimal: 3 × $0.10 = $0.30 exactos", async () => {
    for (let i = 0; i < 3; i++) await contribute("S1", "0.10")
    expect(await cash("S1")).toBe("0.30")
  })

  it("reintentos con la misma clave no duplican; misma clave con otros datos → 409", async () => {
    const k = key()
    const results = await Promise.all([
      contribute("S1", "500", k),
      contribute("S1", "500", k),
      contribute("S1", "500", k),
    ])
    expect(new Set(results.map((r) => r.id)).size).toBe(1)
    expect(results.filter((r) => r.replayed)).toHaveLength(2)
    expect(await cash("S1")).toBe("500.00")
    await expect(contribute("S1", "900", k)).rejects.toThrow(/datos distintos/)
  })

  it("los movimientos y sus partidas son atómicos y siempre cuadran", async () => {
    await contribute("S1", "200")
    const before = await prisma.cashTransactionEntry.count()
    await expect(withdraw("S1", "999")).rejects.toThrow()
    expect(await prisma.cashTransactionEntry.count()).toBe(before)
    // La base rechaza una transacción descuadrada aunque el código fallara.
    const tx = await prisma.cashTransaction.findFirstOrThrow()
    const cashAccount = await prisma.financialAccount.findUniqueOrThrow({
      where: { kind: "CASH_ON_HAND" },
    })
    await expect(
      prisma.$transaction(async (t) => {
        const created = await t.cashTransaction.create({
          data: {
            folio: "X-1",
            transactionType: "CASH_CONTRIBUTION",
            cashBoxId: tx.cashBoxId,
            reason: "x",
            idempotencyKey: key(),
            requestHash: "x",
          },
        })
        await t.cashTransactionEntry.create({
          data: {
            transactionId: created.id,
            accountId: cashAccount.id,
            direction: "DEBIT",
            amount: "10",
            scopeKey: "S1",
          },
        })
      })
    ).rejects.toThrow()
  })

  it("los movimientos confirmados son inmutables", async () => {
    const r = await contribute("S1", "100")
    await expect(
      prisma.cashTransaction.update({
        where: { id: r.id },
        data: { reason: "otra" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.cashTransactionEntry.updateMany({
        where: { transactionId: r.id },
        data: { amount: "1" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.cashTransaction.delete({ where: { id: r.id } })
    ).rejects.toThrow()
  })

  it("no se registran gastos operativos (ni disfrazados de retiro)", async () => {
    await contribute("S1", "1000")
    await expect(
      withdraw("S1", "100", "Compra de comida y bebidas")
    ).rejects.toThrow(/gastos operativos/)
    signInAs(await createUser({ role: "CASHIER" }))
    const res = await call(withdrawalsRoute.POST, {
      method: "POST",
      body: {
        sessionId: "S1",
        amount: "100",
        destination: "EXPENSE",
        recipientName: "Tienda",
        reason: "Insumos",
        idempotencyKey: key(),
      },
    })
    expect(res.status).toBe(400)
    expect(await cash("S1")).toBe("1000.00")
  })
})

describe("sin sesión no hay dinero operativo", () => {
  it("las rutas de efectivo responden 422 sin sesión abierta (no se inventa una sesión)", async () => {
    signInAs(await createUser({ role: "SUPERADMIN" }))
    const res = await call(contributionsRoute.POST, {
      method: "POST",
      body: {
        sessionId: "S1",
        amount: "100",
        contributorName: "Socio",
        reason: "Aportación",
        idempotencyKey: key(),
      },
    })
    expect(res.status).toBe(422)
    expect(res.json.error?.message).toContain(
      "No hay una sesión operativa abierta"
    )
    expect(await prisma.cashTransaction.count()).toBe(0)
    const overview = await call(overviewRoute.GET)
    expect(overview.json.data).toMatchObject({
      session: null,
      cashOnHand: null,
    })
  })

  it("una sesión que no está abierta no admite aportaciones ni retiros", async () => {
    for (const s of ["P1", "C1", "X1", "NOEXISTE"]) {
      await expect(contribute(s, "100")).rejects.toThrow()
    }
  })
})

describe("transferencias bancarias (verificación manual)", () => {
  it("una pendiente no es cobro; confirmar registra el cobro una sola vez", async () => {
    const t = await pendingTransfer("1500")
    expect((await getFlowTotals()).bankCollectionsConfirmed).toBe("0.00")
    expect((await getFlowTotals()).pendingTransfers).toMatchObject({
      count: 1,
      amount: "1500.00",
    })

    const verifier = await createUser({ role: "CASHIER" })
    signInAs(verifier)
    const body = { verifiedInBank: true }
    const results = await Promise.all([
      call(confirmTransferRoute.POST, {
        method: "POST",
        params: { id: t.id },
        body,
      }),
      call(confirmTransferRoute.POST, {
        method: "POST",
        params: { id: t.id },
        body,
      }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "BANK_TRANSFER_RECEIPT" },
      })
    ).toBe(1)
    const confirmed = await prisma.bankTransferVerification.findUniqueOrThrow({
      where: { id: t.id },
    })
    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      verifiedById: verifier.id,
    })
    expect(confirmed.confirmedAmount?.toFixed(2)).toBe("1500.00")
    expect((await getBalances(deps)).bankKnownNet).toBe("1500.00")
    expect(await auditRows("BANK_TRANSFER_CONFIRMED")).toHaveLength(1)
  })

  it.each(["CASHIER", "PARTNER", "SUPERADMIN"] as const)(
    "%s puede confirmar manualmente",
    async (role) => {
      const t = await pendingTransfer("100")
      signInAs(await createUser({ role }))
      const res = await call(confirmTransferRoute.POST, {
        method: "POST",
        params: { id: t.id },
        body: { verifiedInBank: true },
      })
      expect(res.status).toBe(200)
    }
  )

  it("exige declarar la verificación en el banco y explicar diferencias de importe", async () => {
    const t = await pendingTransfer("1000")
    signInAs(await createUser({ role: "CASHIER" }))
    expect(
      (
        await call(confirmTransferRoute.POST, {
          method: "POST",
          params: { id: t.id },
          body: {},
        })
      ).status
    ).toBe(400)
    expect(
      (
        await call(confirmTransferRoute.POST, {
          method: "POST",
          params: { id: t.id },
          body: { verifiedInBank: true, confirmedAmount: "900" },
        })
      ).status
    ).toBe(422)
    const ok = await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: t.id },
      body: {
        verifiedInBank: true,
        confirmedAmount: "900",
        notes: "El banco acreditó $900",
      },
    })
    expect(ok.json.data).toMatchObject({
      declaredAmount: "1000.00",
      confirmedAmount: "900.00",
    })
  })

  it("rechazar no genera entrada y no se puede confirmar después", async () => {
    const t = await pendingTransfer("800")
    signInAs(await createUser({ role: "PARTNER" }))
    const res = await call(rejectTransferRoute.POST, {
      method: "POST",
      params: { id: t.id },
      body: { reason: "No aparece en el estado de cuenta" },
    })
    expect(res.json.data).toMatchObject({ status: "REJECTED" })
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(
      (
        await call(confirmTransferRoute.POST, {
          method: "POST",
          params: { id: t.id },
          body: { verifiedInBank: true },
        })
      ).status
    ).toBe(422)
  })

  it("advierte un posible duplicado (misma cuenta, referencia e importe) y exige reconocerlo", async () => {
    const a = await pendingTransfer("500", randomUUID(), "REF-123")
    const b = await pendingTransfer("500", randomUUID(), "REF-123")
    signInAs(await createUser({ role: "CASHIER" }))
    await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: a.id },
      body: { verifiedInBank: true },
    })
    const dup = await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: b.id },
      body: { verifiedInBank: true },
    })
    expect(dup.status).toBe(409)
    const ack = await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: b.id },
      body: {
        verifiedInBank: true,
        acknowledgePossibleDuplicate: true,
        notes: "Dos pagos distintos del mismo jugador",
      },
    })
    expect(ack.status).toBe(200)
  })

  it("la cuenta bancaria conserva su historial entre sesiones", async () => {
    const t = await pendingTransfer("700")
    signInAs(await createUser({ role: "CASHIER" }))
    await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: t.id },
      body: { verifiedInBank: true },
    })
    await contribute("S2", "50")
    expect((await getBalances(deps)).bankKnownNet).toBe("700.00")
    expect(await cash("S2")).toBe("50.00")
  })
})

describe("traslados, reversos y conciliación", () => {
  it("depósito al banco: el efectivo pasa a tránsito y luego al banco sin duplicar dinero", async () => {
    await contribute("S1", "3000")
    const deposit = await registerCashDeposit(
      actor,
      {
        sessionId: "S1",
        amount: "2000",
        depositedBy: "Cajero",
        reason: "Depósito al banco",
        idempotencyKey: key(),
      },
      {},
      deps
    )
    let b = await getBalances(deps)
    expect(await cash("S1")).toBe("1000.00")
    expect(b.cashInTransit).toBe("2000.00")
    expect(b.bankKnownNet).toBe("0.00")

    signInAs(await createUser({ role: "CASHIER" }))
    await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: deposit.bankTransferId },
      body: { verifiedInBank: true },
    })
    b = await getBalances(deps)
    expect(b.cashInTransit).toBe("0.00")
    expect(b.bankKnownNet).toBe("2000.00")
    // El traslado no es cobro ni ingreso.
    expect((await getFlowTotals()).bankCollectionsConfirmed).toBe("0.00")
  })

  it("un depósito rechazado devuelve el efectivo a la caja", async () => {
    await contribute("S1", "1000")
    const deposit = await registerCashDeposit(
      actor,
      {
        sessionId: "S1",
        amount: "400",
        depositedBy: "Cajero",
        reason: "Depósito",
        idempotencyKey: key(),
      },
      {},
      deps
    )
    const { rejectBankTransfer } =
      await import("@/modules/cash/bank-transfer.service")
    await rejectBankTransfer(
      actor,
      deposit.bankTransferId,
      { reason: "No apareció en el banco" },
      {},
      deps
    )
    expect(await cash("S1")).toBe("1000.00")
    expect((await getBalances(deps)).cashInTransit).toBe("0.00")
  })

  it("los reversos conservan el original, no se duplican y respetan los saldos", async () => {
    const c = await contribute("S1", "500")
    const r1 = await reverseTransaction(
      actor,
      c.id,
      { reason: "Aportación registrada por error", idempotencyKey: key() },
      {},
      deps
    )
    expect(await cash("S1")).toBe("0.00")
    await expect(
      reverseTransaction(
        actor,
        c.id,
        { reason: "Otra vez", idempotencyKey: key() },
        {},
        deps
      )
    ).rejects.toThrow(/ya fue revertido/)
    const original = await prisma.cashTransaction.findUniqueOrThrow({
      where: { id: c.id },
      include: { reversedBy: true },
    })
    expect(original.reversedBy?.id).toBe(r1.id)
    expect(await auditRows("CASH_MOVEMENT_REVERSED")).toHaveLength(1)

    // Revertir un retiro cuando ya no hay efectivo… repone; revertir una aportación ya gastada no deja negativo.
    const c2 = await contribute("S1", "300")
    await withdraw("S1", "300")
    await expect(
      reverseTransaction(
        actor,
        c2.id,
        { reason: "Error", idempotencyKey: key() },
        {},
        deps
      )
    ).rejects.toThrow(/Fondos insuficientes/)
  })

  it("el reverso por ruta responde con el folio nuevo y no se repite", async () => {
    const t = await pendingTransfer("200")
    signInAs(await createUser({ role: "SUPERADMIN" }))
    await call(confirmTransferRoute.POST, {
      method: "POST",
      params: { id: t.id },
      body: { verifiedInBank: true },
    })
    const receipt = await prisma.cashTransaction.findFirstOrThrow({
      where: { transactionType: "BANK_TRANSFER_RECEIPT" },
    })
    const body = {
      reason: "Transferencia acreditada por error del banco",
      idempotencyKey: key(),
    }
    const a = await call(reverseRoute.POST, {
      method: "POST",
      params: { id: receipt.id },
      body,
    })
    const b = await call(reverseRoute.POST, {
      method: "POST",
      params: { id: receipt.id },
      body,
    })
    expect(a.status).toBe(201)
    expect((b.json.data as { id: string }).id).toBe(
      (a.json.data as { id: string }).id
    )
    expect((await getBalances(deps)).bankKnownNet).toBe("0.00")
  })

  it("arqueo de control: diferencia con explicación, ajuste explícito y único", async () => {
    await contribute("S1", "1000")
    const rec = await createCashReconciliation(
      actor,
      { sessionId: "S1", reconciliationType: "CONTROL", countedAmount: "950" },
      {},
      deps
    )
    expect(rec).toMatchObject({
      expectedAmount: "1000.00",
      countedAmount: "950.00",
      status: "DRAFT",
    })
    expect(await cash("S1")).toBe("1000.00") // contar no cambia el saldo
    await expect(
      confirmCashReconciliation(actor, rec.id, {}, {}, deps)
    ).rejects.toThrow(/explica/)
    const confirmed = await confirmCashReconciliation(
      actor,
      rec.id,
      { explanation: "Faltan $50 tras recontar" },
      {},
      deps
    )
    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      differenceStatus: "PENDING",
      differenceAmount: "-50.00",
    })

    const input = { reason: "Faltante confirmado", idempotencyKey: key() }
    await Promise.all([
      adjustCashReconciliation(actor, rec.id, input, {}, deps),
      adjustCashReconciliation(
        actor,
        rec.id,
        { ...input, idempotencyKey: key() },
        {},
        deps
      ),
    ])
    expect(await cash("S1")).toBe("950.00")
    expect(
      await prisma.cashTransaction.count({
        where: { transactionType: "CASH_RECONCILIATION_ADJUSTMENT" },
      })
    ).toBe(1)
  })

  it("no confirma un arqueo con esperado obsoleto", async () => {
    await contribute("S1", "1000")
    const rec = await createCashReconciliation(
      actor,
      { sessionId: "S1", reconciliationType: "CONTROL", countedAmount: "1000" },
      {},
      deps
    )
    await contribute("S1", "10")
    await expect(
      confirmCashReconciliation(actor, rec.id, {}, {}, deps)
    ).rejects.toThrow(/cambió/)
  })

  it("cierre: tras arqueo de cierre sin diferencias, el retiro total deja la caja en $0", async () => {
    await contribute("S1", "1200")
    sessions.S1 = "CLOSING"
    try {
      const rec = await createCashReconciliation(
        actor,
        {
          sessionId: "S1",
          reconciliationType: "CLOSING",
          countedAmount: "1200",
        },
        {},
        deps
      )
      await confirmCashReconciliation(actor, rec.id, {}, {}, deps)
      const result = await cashTx((tx) =>
        withdrawAllCashForClosingInTx(
          tx,
          actor,
          {
            sessionId: "S1",
            recipientName: "Propietario",
            idempotencyKey: key(),
          },
          {},
          deps
        )
      )
      expect(result.amount).toBe("1200.00")
      expect(await cash("S1")).toBe("0.00")
    } finally {
      sessions.S1 = "OPEN"
    }
  })
})

// La apertura (arqueo de fichas compartido + caja en $0) se prueba con
// sesiones reales en tests/integration/sessions.int.test.ts (Módulo 06).

describe("contratos de compras, créditos y liquidaciones", () => {
  it("pago mixto: solo el efectivo entra; la transferencia queda pendiente; el crédito no es dinero", async () => {
    const player = await createTestPlayer()
    const purchaseId = randomUUID()
    const result = await cashTx((tx) =>
      recordPlayerPaymentInTx(
        tx,
        actor,
        {
          origin: "PURCHASE",
          referenceId: purchaseId,
          sessionId: "S1",
          playerId: player.id,
          total: "3000",
          components: [
            { method: "CASH", amount: "1000" },
            { method: "BANK_TRANSFER", amount: "1500" },
            { method: "CREDIT", amount: "500" },
          ],
          idempotencyKey: key(),
        },
        {},
        deps
      )
    )
    expect(result).toMatchObject({
      cashReceived: "1000.00",
      bankPending: "1500.00",
      creditAmount: "500.00",
    })
    expect(await cash("S1")).toBe("1000.00")
    expect((await getBalances(deps)).bankKnownNet).toBe("0.00")
    const entries = await prisma.cashTransactionEntry.findMany()
    expect(entries.reduce((a, e) => a.add(e.amount), D("0")).toFixed(2)).toBe(
      "2000.00"
    ) // 1000 débito + 1000 crédito; nada por el crédito

    // La misma compra no puede cobrarse dos veces.
    await expect(
      cashTx((tx) =>
        recordPlayerPaymentInTx(
          tx,
          actor,
          {
            origin: "PURCHASE",
            referenceId: purchaseId,
            sessionId: "S1",
            playerId: player.id,
            total: "1000",
            components: [{ method: "CASH", amount: "1000" }],
            idempotencyKey: key(),
          },
          {},
          deps
        )
      )
    ).rejects.toThrow()
    expect(await cash("S1")).toBe("1000.00")
  })

  it("las dos mesas cobran en la MISMA caja de la sesión, cada cobro una sola vez y con su mesa", async () => {
    const player = await createTestPlayer()
    const tables = await prisma.pokerTable.findMany({
      orderBy: { name: "asc" },
    })
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      await cashTx((tx) =>
        recordPlayerPaymentInTx(
          tx,
          actor,
          {
            origin: "PURCHASE",
            referenceId: randomUUID(),
            sessionId: "S1",
            tableId: table.id,
            playerId: player.id,
            total: "500",
            components: [{ method: "CASH", amount: "500" }],
            idempotencyKey: key(),
          },
          {},
          deps
        )
      )
    }
    expect(await cash("S1")).toBe("1000.00")
    const payments = await prisma.cashTransaction.findMany({
      where: { transactionType: "PURCHASE_PAYMENT" },
    })
    expect(new Set(payments.map((p) => p.tableId))).toEqual(
      new Set(tables.map((t) => t.id))
    )
    expect(new Set(payments.map((p) => p.cashBoxId)).size).toBe(1)
  })

  it("los componentes no pueden exceder ni quedar por debajo del importe", async () => {
    const player = await createTestPlayer()
    for (const components of [
      [{ method: "CASH" as const, amount: "2000" }],
      [{ method: "CASH" as const, amount: "3500" }],
      [
        { method: "CASH" as const, amount: "1000" },
        { method: "CASH" as const, amount: "2000" },
      ],
    ]) {
      await expect(
        cashTx((tx) =>
          recordPlayerPaymentInTx(
            tx,
            actor,
            {
              origin: "PURCHASE",
              referenceId: randomUUID(),
              sessionId: "S1",
              playerId: player.id,
              total: "3000",
              components,
              idempotencyKey: key(),
            },
            {},
            deps
          )
        )
      ).rejects.toThrow()
    }
  })

  it("liquidación: cada desembolso es un asiento único y nunca excede la caja (la compensación no pasa por aquí)", async () => {
    const player = await createTestPlayer()
    await contribute("S1", "1000")
    const payout = (amount: string, extra: Record<string, unknown> = {}) =>
      cashTx((tx) =>
        recordSettlementPayoutInTx(
          tx,
          actor,
          {
            payoutId: randomUUID(),
            settlementId: randomUUID(),
            settlementFolio: "LIQ-TEST",
            funding: "SESSION_CASH",
            sessionId: "S1",
            playerId: player.id,
            amount: new Prisma.Decimal(amount),
            idempotencyKey: key(),
            ...extra,
          },
          {},
          deps
        )
      )
    await expect(payout("1500")).rejects.toThrow(/Faltan \$500\.00/)
    const before = await prisma.cashTransaction.count()
    await expect(payout("0")).rejects.toThrow(/mayor que cero/)
    expect(await prisma.cashTransaction.count()).toBe(before)

    const retry = { idempotencyKey: key(), payoutId: randomUUID() }
    const first = await payout("800", retry)
    const again = await payout("800", retry)
    expect(again.transactionId).toBe(first.transactionId)
    expect(await cash("S1")).toBe("200.00")
    const tx = await prisma.cashTransaction.findUniqueOrThrow({
      where: { id: first.transactionId },
    })
    expect(tx).toMatchObject({
      transactionType: "PLAYER_SETTLEMENT",
      referenceType: "SettlementPayout",
    })
  })
})

describe("permisos", () => {
  it("401 sin sesión, 403 con credencial temporal pendiente", async () => {
    signOut()
    expect((await call(overviewRoute.GET)).status).toBe(401)
    expect((await call(movementsRoute.GET)).status).toBe(401)
    signInAs(await createUser({ role: "CASHIER", mustChangePassword: true }))
    expect((await call(overviewRoute.GET)).status).toBe(403)
  })

  it("el historial filtra por tipo y folio y no expone escritura genérica", async () => {
    await contribute("S1", "100")
    await withdraw("S1", "40")
    signInAs(await createUser({ role: "CASHIER" }))
    const res = await call(movementsRoute.GET, {
      path: "/api/cash-box/movements?type=CASH_WITHDRAWAL",
    })
    const data = res.json.data as {
      items: { type: string; folio: string; amount: string }[]
    }
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({
      type: "CASH_WITHDRAWAL",
      amount: "40.00",
    })
    const byFolio = await call(movementsRoute.GET, {
      path: `/api/cash-box/movements?folio=${data.items[0].folio}`,
    })
    expect((byFolio.json.data as { total: number }).total).toBe(1)
    expect("POST" in movementsRoute).toBe(false)
  })
})
