import "server-only"

import { Prisma, type PrismaClient } from "@/generated/prisma/client"

type AnyDb = PrismaClient | Prisma.TransactionClient
import { getGlobalChipPosition } from "@/modules/closure/chip-circulation.service"
import type { ClosureReportContent } from "@/modules/closure/closure-report.content"
import {
  getCreditSummary,
  loadCreditFacts,
} from "@/modules/reports/credit-report.service"
import { buildCreditTree, dec } from "@/modules/reports/report.math"
import type {
  CheckDefinition,
  CheckResult,
  IntegrityStatusValue,
  SeverityValue,
} from "@/modules/integrity/integrity.math"

/**
 * Comprobaciones de integridad (Módulo 15). TODAS son lecturas: ninguna
 * escribe, repara ni crea movimientos. Reciben el cliente de base para
 * poder correr también contra una base RESTAURADA en aislamiento.
 *
 * Distinciones obligatorias: una obligación pendiente (por cobrar o por
 * pagar) y las fichas en circulación son estados LEGÍTIMOS (INFO), no
 * errores; una transferencia pendiente no es un cobro.
 */

type Db = AnyDb

const MAX_ROWS = 50

function rows<T>(
  code: string,
  category: string,
  status: IntegrityStatusValue,
  severity: SeverityValue,
  list: T[],
  map: (
    r: T
  ) => Omit<CheckResult, "checkCode" | "category" | "status" | "severity">
): CheckResult[] {
  return list.slice(0, MAX_ROWS).map((r) => ({
    checkCode: code,
    category,
    status,
    severity,
    ...map(r),
  }))
}

export function integrityChecks(db: Db): CheckDefinition[] {
  const q = <T>(sql: Prisma.Sql) => db.$queryRaw<T[]>(sql)
  const def = (
    code: string,
    category: string,
    title: string,
    run: () => Promise<CheckResult[]>
  ): CheckDefinition => ({ code, category, title, run })

  return [
    // ── CAJA ──────────────────────────────────────────────────────────
    def(
      "CASH_SINGLE_BOX",
      "CASH",
      "Una única caja central activa",
      async () => {
        const [r] = await q<{ n: bigint }>(
          Prisma.sql`SELECT COUNT(*) AS n FROM "cash_boxes" WHERE "isActive"`
        )
        return Number(r.n) === 1
          ? []
          : [
              {
                checkCode: "CASH_SINGLE_BOX",
                category: "CASH",
                status: "ERROR",
                severity: "HIGH",
                expected: "1",
                actual: String(r.n),
                explanation:
                  "Debe existir exactamente una caja central activa.",
              },
            ]
      }
    ),
    def("CASH_OPENING_ZERO", "CASH", "Toda sesión abre con $0.00", async () => {
      const list = await q<{ sessionId: string; amount: string }>(Prisma.sql`
        SELECT "sessionId", "openingCashAmount"::text AS amount
        FROM "session_openings" WHERE "openingCashAmount" <> 0`)
      return rows("CASH_OPENING_ZERO", "CASH", "ERROR", "HIGH", list, (r) => ({
        entityType: "PokerSession",
        entityId: r.sessionId,
        expected: "0.00",
        actual: r.amount,
        explanation: "La apertura registró efectivo distinto de $0.00.",
      }))
    }),
    def(
      "CASH_TX_BALANCED",
      "CASH",
      "Cada movimiento cuadra en partida doble",
      async () => {
        const list = await q<{
          id: string
          folio: string
          debit: string
          credit: string
        }>(Prisma.sql`
          SELECT t."id", t."folio",
            COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'DEBIT'), 0)::text AS debit,
            COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'CREDIT'), 0)::text AS credit
          FROM "cash_transactions" t JOIN "cash_transaction_entries" e ON e."transactionId" = t."id"
          GROUP BY t."id", t."folio"
          HAVING COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'DEBIT'), 0)
              <> COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'CREDIT'), 0)`)
        return rows(
          "CASH_TX_BALANCED",
          "CASH",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "CashTransaction",
            entityId: r.id,
            expected: r.debit,
            actual: r.credit,
            difference: dec(r.debit).sub(dec(r.credit)).toFixed(2),
            explanation: `El movimiento ${r.folio} no cuadra (débitos ≠ créditos).`,
          })
        )
      }
    ),
    def(
      "CASH_PROJECTION_MATCHES_LEDGER",
      "CASH",
      "Saldos proyectados = libro de partidas",
      async () => {
        const list = await q<{
          kind: string
          scopeKey: string
          projected: string
          ledger: string
        }>(Prisma.sql`
          SELECT a."kind"::text AS kind, b."scopeKey", b."balance"::text AS projected,
            COALESCE((SELECT SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END)
              FROM "cash_transaction_entries" e WHERE e."accountId" = b."accountId" AND e."scopeKey" = b."scopeKey"), 0)::text AS ledger
          FROM "financial_account_balances" b JOIN "financial_accounts" a ON a."id" = b."accountId"
          WHERE b."balance" <> COALESCE((SELECT SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END)
              FROM "cash_transaction_entries" e WHERE e."accountId" = b."accountId" AND e."scopeKey" = b."scopeKey"), 0)`)
        return rows(
          "CASH_PROJECTION_MATCHES_LEDGER",
          "CASH",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "FinancialAccountBalance",
            entityId: `${r.kind}:${r.scopeKey}`,
            expected: dec(r.ledger).toFixed(2),
            actual: dec(r.projected).toFixed(2),
            difference: dec(r.projected).sub(dec(r.ledger)).toFixed(2),
            explanation: `El saldo proyectado de ${r.kind} (${r.scopeKey}) no coincide con la suma de sus partidas.`,
          })
        )
      }
    ),
    def(
      "CASH_NO_NEGATIVE",
      "CASH",
      "Sin saldos negativos no permitidos",
      async () => {
        const list = await q<{
          kind: string
          scopeKey: string
          balance: string
        }>(Prisma.sql`
        SELECT a."kind"::text AS kind, b."scopeKey", b."balance"::text AS balance
        FROM "financial_account_balances" b JOIN "financial_accounts" a ON a."id" = b."accountId"
        WHERE b."nonNegative" AND b."balance" < 0`)
        return rows(
          "CASH_NO_NEGATIVE",
          "CASH",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "FinancialAccountBalance",
            entityId: `${r.kind}:${r.scopeKey}`,
            expected: "≥ 0.00",
            actual: dec(r.balance).toFixed(2),
            explanation: `${r.kind} quedó en negativo.`,
          })
        )
      }
    ),
    def(
      "CASH_CLOSED_FINAL_ZERO",
      "CASH",
      "Caja final en $0.00 en sesiones cerradas",
      async () => {
        const list = await q<{
          id: string
          folio: string
          balance: string
        }>(Prisma.sql`
          SELECT s."id", s."folio", b."balance"::text AS balance
          FROM "poker_sessions" s
          JOIN "financial_account_balances" b ON b."scopeKey" = s."id"
          JOIN "financial_accounts" a ON a."id" = b."accountId" AND a."kind" = 'CASH_ON_HAND'
          WHERE s."status" = 'CLOSED' AND b."balance" <> 0`)
        return rows(
          "CASH_CLOSED_FINAL_ZERO",
          "CASH",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "PokerSession",
            entityId: r.id,
            expected: "0.00",
            actual: dec(r.balance).toFixed(2),
            explanation: `La sesión ${r.folio} está cerrada con efectivo en caja (debió retirarse completo).`,
          })
        )
      }
    ),
    def(
      "CASH_CLOSED_NO_LATER_ENTRIES",
      "CASH",
      "Sin movimientos de efectivo posteriores al cierre",
      async () => {
        const list = await q<{
          id: string
          folio: string
          txFolio: string
        }>(Prisma.sql`
          SELECT s."id", s."folio", t."folio" AS "txFolio"
          FROM "poker_sessions" s
          JOIN "cash_transaction_entries" e ON e."scopeKey" = s."id"
          JOIN "financial_accounts" a ON a."id" = e."accountId" AND a."kind" = 'CASH_ON_HAND'
          JOIN "cash_transactions" t ON t."id" = e."transactionId"
          WHERE s."status" IN ('CLOSED', 'CANCELLED') AND s."closedAt" IS NOT NULL AND t."createdAt" > s."closedAt"`)
        return rows(
          "CASH_CLOSED_NO_LATER_ENTRIES",
          "CASH",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "PokerSession",
            entityId: r.id,
            explanation: `La caja cerrada de ${r.folio} recibió el movimiento ${r.txFolio} después del cierre.`,
            references: { transaction: r.txFolio },
          })
        )
      }
    ),
    def(
      "CASH_CLOSING_WITHDRAWAL_CONSISTENT",
      "CASH",
      "Retiro final = salida de efectivo registrada",
      async () => {
        const list = await q<{
          id: string
          sessionId: string
          amount: string
          booked: string
        }>(Prisma.sql`
          SELECT w."id", w."sessionId", w."amount"::text AS amount,
            COALESCE((SELECT SUM(e."amount") FROM "cash_transaction_entries" e
              JOIN "financial_accounts" a ON a."id" = e."accountId" AND a."kind" = 'CASH_ON_HAND'
              WHERE e."transactionId" = w."cashTransactionId" AND e."direction" = 'CREDIT'), 0)::text AS booked
          FROM "closure_cash_withdrawals" w
          WHERE w."amount" <> COALESCE((SELECT SUM(e."amount") FROM "cash_transaction_entries" e
              JOIN "financial_accounts" a ON a."id" = e."accountId" AND a."kind" = 'CASH_ON_HAND'
              WHERE e."transactionId" = w."cashTransactionId" AND e."direction" = 'CREDIT'), 0)`)
        return rows(
          "CASH_CLOSING_WITHDRAWAL_CONSISTENT",
          "CASH",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "PokerSession",
            entityId: r.sessionId,
            expected: dec(r.amount).toFixed(2),
            actual: dec(r.booked).toFixed(2),
            explanation:
              "El retiro final declarado no coincide con la salida de efectivo del libro.",
          })
        )
      }
    ),
    def(
      "CASH_DUPLICATE_SOURCE",
      "CASH",
      "Sin movimientos duplicados por reintentos",
      async () => {
        const list = await q<{
          referenceType: string
          referenceId: string
          type: string
          n: bigint
        }>(Prisma.sql`
          SELECT "referenceType", "referenceId", "transactionType"::text AS type, COUNT(*) AS n
          FROM "cash_transactions"
          WHERE "referenceId" IS NOT NULL AND "transactionType" <> 'REVERSAL'
          GROUP BY "referenceType", "referenceId", "transactionType" HAVING COUNT(*) > 1`)
        return rows(
          "CASH_DUPLICATE_SOURCE",
          "CASH",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: r.referenceType,
            entityId: r.referenceId,
            expected: "1",
            actual: String(r.n),
            explanation: `La operación ${r.referenceType} tiene ${r.n} asientos ${r.type} (posible doble registro).`,
          })
        )
      }
    ),

    // ── COMPRAS ───────────────────────────────────────────────────────
    def(
      "PURCHASE_DELIVERY_ONCE",
      "PURCHASES",
      "Compra confirmada ⇔ una entrega",
      async () => {
        const list = await q<{
          id: string
          folio: string
          status: string
          deliveries: bigint
        }>(Prisma.sql`
          SELECT p."id", p."folio", p."status"::text AS status,
            (SELECT COUNT(*) FROM "purchase_deliveries" d WHERE d."purchaseId" = p."id") AS deliveries
          FROM "chip_purchases" p
          WHERE (p."status" IN ('CONFIRMED', 'REVERSED') AND NOT EXISTS (SELECT 1 FROM "purchase_deliveries" d WHERE d."purchaseId" = p."id"))
             OR (p."status" NOT IN ('CONFIRMED', 'REVERSED') AND EXISTS (SELECT 1 FROM "purchase_deliveries" d WHERE d."purchaseId" = p."id"))`)
        return rows(
          "PURCHASE_DELIVERY_ONCE",
          "PURCHASES",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            actual: `${r.status} con ${r.deliveries} entrega(s)`,
            explanation: `La compra ${r.folio} tiene un estado incoherente con su entrega.`,
          })
        )
      }
    ),
    def(
      "PURCHASE_NOMINAL_OUT",
      "PURCHASES",
      "Salida nominal del inventario = valor de la compra",
      async () => {
        const list = await q<{
          id: string
          folio: string
          nominal: string
          delivered: string
          moved: string
        }>(Prisma.sql`
          SELECT p."id", p."folio", p."nominalAmount"::text AS nominal, d."nominalAmount"::text AS delivered,
            COALESCE((SELECT SUM(m."circulationAfter" - m."circulationBefore") FROM "chip_nominal_movements" m
              WHERE m."operationId" = d."inventoryOperationId"), 0)::text AS moved
          FROM "chip_purchases" p JOIN "purchase_deliveries" d ON d."purchaseId" = p."id"
          WHERE p."nominalAmount" <> d."nominalAmount"
             OR p."nominalAmount" <> COALESCE((SELECT SUM(m."circulationAfter" - m."circulationBefore") FROM "chip_nominal_movements" m
              WHERE m."operationId" = d."inventoryOperationId"), 0)`)
        return rows(
          "PURCHASE_NOMINAL_OUT",
          "PURCHASES",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            expected: dec(r.nominal).toFixed(2),
            actual: dec(r.moved).toFixed(2),
            difference: dec(r.moved).sub(dec(r.nominal)).toFixed(2),
            explanation: `La entrega de ${r.folio} no movió exactamente su valor nominal al inventario (entrega ${dec(r.delivered).toFixed(2)}).`,
          })
        )
      }
    ),
    def(
      "PURCHASE_CREDIT_HAS_DEBT",
      "PURCHASES",
      "Crédito al entregar ⇔ obligación del mismo importe",
      async () => {
        const list = await q<{
          id: string
          folio: string
          outstanding: string
          debt: string | null
        }>(Prisma.sql`
          SELECT p."id", p."folio", d."outstandingAmount"::text AS outstanding, pd."originalAmount"::text AS debt
          FROM "chip_purchases" p JOIN "purchase_deliveries" d ON d."purchaseId" = p."id"
          LEFT JOIN "player_debts" pd ON pd."purchaseId" = p."id"
          WHERE (d."outstandingAmount" > 0 AND (pd."id" IS NULL OR pd."originalAmount" <> d."outstandingAmount"))
             OR (d."outstandingAmount" = 0 AND pd."id" IS NOT NULL)`)
        return rows(
          "PURCHASE_CREDIT_HAS_DEBT",
          "PURCHASES",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            expected: dec(r.outstanding).toFixed(2),
            actual: r.debt === null ? "sin obligación" : dec(r.debt).toFixed(2),
            explanation: `El crédito de ${r.folio} no está respaldado por su obligación exacta.`,
          })
        )
      }
    ),
    def(
      "PURCHASE_CREDIT_PARTNER",
      "PURCHASES",
      "Crédito autorizado por un socio (PARTNER)",
      async () => {
        const list = await q<{
          id: string
          folio: string
          role: string
        }>(Prisma.sql`
          SELECT p."id", p."folio", u."role"::text AS role
          FROM "player_debts" pd JOIN "chip_purchases" p ON p."id" = pd."purchaseId"
          JOIN "purchase_credit_authorizations" a ON a."id" = pd."authorizationId"
          JOIN "users" u ON u."id" = a."authorizedByPartnerId"
          WHERE u."role" <> 'PARTNER'`)
        return rows(
          "PURCHASE_CREDIT_PARTNER",
          "PURCHASES",
          "WARNING",
          "MEDIUM",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            expected: "PARTNER",
            actual: r.role,
            explanation: `El autorizador del crédito de ${r.folio} no tiene hoy rol de socio (pudo cambiar de rol después).`,
          })
        )
      }
    ),
    def(
      "PURCHASE_CREDIT_SIGNATURE",
      "PURCHASES",
      "Firma válida en toda compra con crédito",
      async () => {
        const list = await q<{
          id: string
          folio: string
          status: string | null
        }>(Prisma.sql`
          SELECT p."id", p."folio", sg."status"::text AS status
          FROM "player_debts" pd JOIN "chip_purchases" p ON p."id" = pd."purchaseId"
          JOIN "purchase_deliveries" d ON d."purchaseId" = p."id"
          LEFT JOIN "purchase_signatures" sg ON sg."id" = d."signatureId"
          WHERE sg."id" IS NULL OR sg."status" <> 'VALID' OR sg."purchaseId" <> p."id"`)
        return rows(
          "PURCHASE_CREDIT_SIGNATURE",
          "PURCHASES",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            expected: "Firma VALID de la compra",
            actual: r.status ?? "sin firma",
            explanation: `La compra a crédito ${r.folio} se confirmó sin su firma válida.`,
          })
        )
      }
    ),
    def(
      "PURCHASE_SNAPSHOT_CONSISTENT",
      "PURCHASES",
      "Snapshot firmado coincide con la compra y la obligación",
      async () => {
        const list = await q<{
          id: string
          folio: string
          snap: string
          debt: string
        }>(Prisma.sql`
          SELECT p."id", p."folio", sn."outstandingCreditAmount"::text AS snap, pd."originalAmount"::text AS debt
          FROM "player_debts" pd JOIN "chip_purchases" p ON p."id" = pd."purchaseId"
          JOIN "purchase_deliveries" d ON d."purchaseId" = p."id"
          JOIN "purchase_signatures" sg ON sg."id" = d."signatureId"
          JOIN "signature_snapshots" sn ON sn."id" = sg."snapshotId"
          WHERE sn."purchaseId" <> p."id" OR sn."nominalAmount" <> p."nominalAmount"
             OR sn."outstandingCreditAmount" <> pd."originalAmount"`)
        return rows(
          "PURCHASE_SNAPSHOT_CONSISTENT",
          "PURCHASES",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            expected: dec(r.debt).toFixed(2),
            actual: dec(r.snap).toFixed(2),
            explanation: `Lo firmado en ${r.folio} no coincide con la compra u obligación registradas.`,
          })
        )
      }
    ),
    def(
      "PURCHASE_STATUS_COHERENT",
      "PURCHASES",
      "Estados de compra coherentes con sus fechas",
      async () => {
        const list = await q<{
          id: string
          folio: string
          status: string
        }>(Prisma.sql`
          SELECT "id", "folio", "status"::text AS status FROM "chip_purchases"
          WHERE ("status" = 'CONFIRMED' AND "confirmedAt" IS NULL)
             OR ("status" = 'CANCELLED' AND "cancelledAt" IS NULL)`)
        return rows(
          "PURCHASE_STATUS_COHERENT",
          "PURCHASES",
          "WARNING",
          "LOW",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            actual: r.status,
            explanation: `La compra ${r.folio} no tiene la fecha de su estado.`,
          })
        )
      }
    ),

    // ── DEUDAS Y ABONOS ───────────────────────────────────────────────
    def(
      "DEBT_ORIGIN",
      "DEBTS",
      "Obligación conserva sesión, mesa y jugador de su compra",
      async () => {
        const list = await q<{ id: string; folio: string }>(Prisma.sql`
          SELECT pd."id", p."folio" FROM "player_debts" pd JOIN "chip_purchases" p ON p."id" = pd."purchaseId"
          WHERE pd."sessionId" <> p."sessionId" OR pd."tableId" <> p."tableId" OR pd."playerId" <> p."playerId"`)
        return rows("DEBT_ORIGIN", "DEBTS", "ERROR", "CRITICAL", list, (r) => ({
          entityType: "PlayerDebt",
          entityId: r.id,
          explanation: `La obligación de ${r.folio} no conserva la sesión, mesa o jugador de su compra.`,
        }))
      }
    ),
    def("DEBT_POSITIVE_ORIGINAL", "DEBTS", "Crédito original > 0", async () => {
      const list = await q<{ id: string; amount: string }>(Prisma.sql`
        SELECT "id", "originalAmount"::text AS amount FROM "player_debts" WHERE "originalAmount" <= 0`)
      return rows(
        "DEBT_POSITIVE_ORIGINAL",
        "DEBTS",
        "ERROR",
        "HIGH",
        list,
        (r) => ({
          entityType: "PlayerDebt",
          entityId: r.id,
          expected: "> 0.00",
          actual: dec(r.amount).toFixed(2),
          explanation: "Obligación con crédito original no positivo.",
        })
      )
    }),
    def(
      "DEBT_NOT_OVERAPPLIED",
      "DEBTS",
      "Aplicaciones netas entre 0 y la obligación",
      async () => {
        const list = await q<{
          id: string
          original: string
          applied: string
        }>(Prisma.sql`
          SELECT pd."id", pd."originalAmount"::text AS original,
            COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0)::text AS applied
          FROM "player_debts" pd LEFT JOIN "payment_allocations" a ON a."receivableId" = pd."id"
          GROUP BY pd."id"
          HAVING COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0) > pd."originalAmount"
              OR COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0) < 0`)
        return rows(
          "DEBT_NOT_OVERAPPLIED",
          "DEBTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "PlayerDebt",
            entityId: r.id,
            expected: `0.00 – ${dec(r.original).toFixed(2)}`,
            actual: dec(r.applied).toFixed(2),
            explanation:
              "Las aplicaciones de la deuda exceden la obligación (o son negativas).",
          })
        )
      }
    ),
    def(
      "DEBT_TREE_CONSISTENT",
      "DEBTS",
      "Desglose jugador → sesión → compra cuadra con la deuda global",
      async () => {
        const facts = await loadCreditFacts({}, db)
        const tree = buildCreditTree(facts.debts, facts.allocations)
        const out: CheckResult[] = []
        let global = dec(0)
        for (const p of tree) {
          let sessions = dec(0)
          for (const sNode of p.sessions) {
            const debts = sNode.debts.reduce(
              (acc, d) => acc.add(dec(d.balance)),
              dec(0)
            )
            if (!debts.equals(dec(sNode.balance)))
              out.push({
                checkCode: "DEBT_TREE_CONSISTENT",
                category: "DEBTS",
                status: "ERROR",
                severity: "CRITICAL",
                entityType: "PokerSession",
                entityId: sNode.session.id,
                expected: debts.toFixed(2),
                actual: dec(sNode.balance).toFixed(2),
                explanation: `Las compras de ${p.player.name} en ${sNode.session.folio} no suman el saldo de la sesión.`,
              })
            sessions = sessions.add(dec(sNode.balance))
          }
          if (!sessions.equals(dec(p.balance)))
            out.push({
              checkCode: "DEBT_TREE_CONSISTENT",
              category: "DEBTS",
              status: "ERROR",
              severity: "CRITICAL",
              entityType: "Player",
              entityId: p.player.id,
              expected: sessions.toFixed(2),
              actual: dec(p.balance).toFixed(2),
              explanation: `Las sesiones de ${p.player.name} no suman su deuda global.`,
            })
          global = global.add(dec(p.balance))
        }
        const summary = await getCreditSummary({ page: 1, pageSize: 25 }, db)
        if (!global.equals(dec(summary.balance)))
          out.push({
            checkCode: "DEBT_TREE_CONSISTENT",
            category: "DEBTS",
            status: "ERROR",
            severity: "CRITICAL",
            expected: global.toFixed(2),
            actual: dec(summary.balance).toFixed(2),
            explanation:
              "La suma por jugador no coincide con el agregado global de deudas.",
          })
        return out
      }
    ),
    def(
      "DEBT_HISTORICAL_SNAPSHOT",
      "DEBTS",
      "Deuda al cierre del comprobante = reconstrucción del libro",
      async () => {
        const reports = await db.closureReport.findMany({
          select: { sessionId: true, folio: true, content: true },
        })
        if (reports.length === 0) return []
        const facts = await loadCreditFacts(
          { sessionId: { in: reports.map((r) => r.sessionId) } },
          db
        )
        const tree = buildCreditTree(facts.debts, facts.allocations)
        const atClose = new Map<string, Prisma.Decimal>()
        for (const p of tree)
          for (const sNode of p.sessions)
            atClose.set(
              sNode.session.id,
              (atClose.get(sNode.session.id) ?? dec(0)).add(
                dec(sNode.atClosure?.balanceAtClosure ?? "0")
              )
            )
        const out: CheckResult[] = []
        for (const r of reports) {
          const snap = dec(
            (r.content as ClosureReportContent).credits?.outstanding ?? 0
          )
          const rebuilt = atClose.get(r.sessionId) ?? dec(0)
          if (!snap.equals(rebuilt))
            out.push({
              checkCode: "DEBT_HISTORICAL_SNAPSHOT",
              category: "DEBTS",
              status: "WARNING",
              severity: "MEDIUM",
              entityType: "PokerSession",
              entityId: r.sessionId,
              expected: snap.toFixed(2),
              actual: rebuilt.toFixed(2),
              difference: rebuilt.sub(snap).toFixed(2),
              explanation: `El comprobante ${r.folio} registra una deuda al cierre distinta a la reconstruida (posible abono concurrente al cierre). El comprobante no se modifica.`,
            })
        }
        return out
      }
    ),
    def(
      "PAYMENT_NOT_OVERAPPLIED",
      "DEBTS",
      "Un abono no aplica más que lo recibido",
      async () => {
        const list = await q<{
          id: string
          folio: string
          amount: string
          applied: string
        }>(Prisma.sql`
          SELECT rp."id", rp."folio", rp."amount"::text AS amount,
            COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0)::text AS applied
          FROM "receivable_payments" rp LEFT JOIN "payment_allocations" a ON a."receivablePaymentId" = rp."id"
          GROUP BY rp."id"
          HAVING COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0) > rp."amount"`)
        return rows(
          "PAYMENT_NOT_OVERAPPLIED",
          "DEBTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ReceivablePayment",
            entityId: r.id,
            expected: `≤ ${dec(r.amount).toFixed(2)}`,
            actual: dec(r.applied).toFixed(2),
            explanation: `El abono ${r.folio} aplicó más de lo recibido.`,
          })
        )
      }
    ),
    def(
      "PAYMENT_FIFO_ORDER",
      "DEBTS",
      "Abonos generales aplicados de la deuda más antigua a la más reciente",
      async () => {
        const list = await q<{ paymentId: string; folio: string }>(Prisma.sql`
          SELECT DISTINCT a."receivablePaymentId" AS "paymentId", rp."folio"
          FROM "payment_allocations" a
          JOIN "payment_allocations" b ON b."receivablePaymentId" = a."receivablePaymentId"
            AND b."kind" = 'APPLICATION' AND b."allocationOrder" > a."allocationOrder"
          JOIN "player_debts" da ON da."id" = a."receivableId"
          JOIN "player_debts" db ON db."id" = b."receivableId"
          JOIN "receivable_payments" rp ON rp."id" = a."receivablePaymentId"
          WHERE a."kind" = 'APPLICATION' AND a."source" = 'RECEIVABLE_PAYMENT'
            AND (da."createdAt", da."id") > (db."createdAt", db."id")`)
        return rows(
          "PAYMENT_FIFO_ORDER",
          "DEBTS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "ReceivablePayment",
            entityId: r.paymentId,
            explanation: `El abono ${r.folio} no siguió el orden FIFO (aplicó a una deuda más reciente antes que a una más antigua).`,
          })
        )
      }
    ),
    def(
      "PAYMENT_LINKED_SAME_PURCHASE",
      "DEBTS",
      "Pagos vinculados conservan su compra original",
      async () => {
        const list = await q<{ id: string }>(Prisma.sql`
          SELECT a."id" FROM "payment_allocations" a
          JOIN "purchase_payments" pp ON pp."id" = a."purchasePaymentId"
          JOIN "player_debts" pd ON pd."id" = a."receivableId"
          WHERE a."source" = 'PURCHASE_PAYMENT' AND pp."purchaseId" <> pd."purchaseId"`)
        return rows(
          "PAYMENT_LINKED_SAME_PURCHASE",
          "DEBTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "PaymentAllocation",
            entityId: r.id,
            explanation:
              "Un pago vinculado se aplicó a la deuda de OTRA compra.",
          })
        )
      }
    ),
    def(
      "PAYMENT_POSSIBLE_DUPLICATE",
      "DEBTS",
      "Sin abonos duplicados",
      async () => {
        const list = await q<{
          a: string
          b: string
          fa: string
          fb: string
        }>(Prisma.sql`
          SELECT x."id" AS a, y."id" AS b, x."folio" AS fa, y."folio" AS fb
          FROM "receivable_payments" x JOIN "receivable_payments" y
            ON x."playerId" = y."playerId" AND x."amount" = y."amount" AND x."method" = y."method"
           AND x."createdById" = y."createdById" AND x."id" < y."id"
           AND ABS(EXTRACT(EPOCH FROM (y."createdAt" - x."createdAt"))) < 60
          WHERE x."status" = 'CONFIRMED' AND y."status" = 'CONFIRMED'`)
        return rows(
          "PAYMENT_POSSIBLE_DUPLICATE",
          "DEBTS",
          "WARNING",
          "MEDIUM",
          list,
          (r) => ({
            entityType: "ReceivablePayment",
            entityId: r.b,
            explanation: `Los abonos ${r.fa} y ${r.fb} son idénticos y con menos de un minuto de diferencia: revisa si es un duplicado.`,
            references: { first: r.a, second: r.b },
          })
        )
      }
    ),
    def(
      "OFFSET_NO_MONEY",
      "DEBTS",
      "Compensaciones sin movimiento monetario",
      async () => {
        const list = await q<{ id: string }>(Prisma.sql`
          SELECT "id" FROM "payment_allocations"
          WHERE "source" = 'CHIP_SETTLEMENT_OFFSET'
            AND ("receivablePaymentId" IS NOT NULL OR "purchasePaymentId" IS NOT NULL OR "settlementId" IS NULL)`)
        return rows("OFFSET_NO_MONEY", "DEBTS", "ERROR", "HIGH", list, (r) => ({
          entityType: "PaymentAllocation",
          entityId: r.id,
          explanation:
            "Una compensación con fichas está ligada a un pago de dinero o no tiene liquidación.",
        }))
      }
    ),
    def(
      "REVERSAL_CONSISTENT",
      "DEBTS",
      "Reversos de aplicaciones correctos",
      async () => {
        const bad = await q<{ id: string }>(Prisma.sql`
          SELECT r."id" FROM "payment_allocations" r
          LEFT JOIN "payment_allocations" o ON o."id" = r."reversesAllocationId"
          WHERE r."kind" = 'REVERSAL'
            AND (o."id" IS NULL OR o."kind" <> 'APPLICATION' OR o."amount" <> r."amount" OR o."receivableId" <> r."receivableId")`)
        const reversed = await q<{
          id: string
          folio: string
          net: string
        }>(Prisma.sql`
          SELECT rp."id", rp."folio",
            COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0)::text AS net
          FROM "receivable_payments" rp LEFT JOIN "payment_allocations" a ON a."receivablePaymentId" = rp."id"
          WHERE rp."status" = 'REVERSED' GROUP BY rp."id"
          HAVING COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0) <> 0`)
        return [
          ...rows(
            "REVERSAL_CONSISTENT",
            "DEBTS",
            "ERROR",
            "HIGH",
            bad,
            (r) => ({
              entityType: "PaymentAllocation",
              entityId: r.id,
              explanation:
                "Un reverso no corresponde exactamente a una aplicación original.",
            })
          ),
          ...rows(
            "REVERSAL_CONSISTENT",
            "DEBTS",
            "ERROR",
            "HIGH",
            reversed,
            (r) => ({
              entityType: "ReceivablePayment",
              entityId: r.id,
              expected: "0.00",
              actual: dec(r.net).toFixed(2),
              explanation: `El abono revertido ${r.folio} conserva aplicaciones netas.`,
            })
          ),
        ]
      }
    ),
    def(
      "RECEIVABLES_PENDING_INFO",
      "DEBTS",
      "Deudas pendientes (estado legítimo)",
      async () => {
        const summary = await getCreditSummary({ page: 1, pageSize: 25 }, db)
        return [
          {
            checkCode: "RECEIVABLES_PENDING_INFO",
            category: "DEBTS",
            status: "OK",
            severity: "INFO",
            actual: summary.balance,
            explanation: `${summary.playersWithBalance} jugador(es) deben $${summary.balance}. Una deuda pendiente NO es un error de integridad.`,
          },
        ]
      }
    ),

    // ── LIQUIDACIONES ─────────────────────────────────────────────────
    def(
      "SETTLEMENT_SIGNATURE",
      "SETTLEMENTS",
      "Toda liquidación recibida tiene firma válida",
      async () => {
        const list = await q<{ id: string; folio: string }>(Prisma.sql`
          SELECT s."id", s."folio" FROM "player_settlements" s
          WHERE s."status" IN ('PENDING_PAYOUT', 'COMPLETED', 'REVERSED')
            AND NOT EXISTS (SELECT 1 FROM "settlement_signatures" g WHERE g."settlementId" = s."id" AND g."status" = 'VALID')`)
        return rows(
          "SETTLEMENT_SIGNATURE",
          "SETTLEMENTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "PlayerSettlement",
            entityId: r.id,
            explanation: `La liquidación ${r.folio} se recibió sin firma válida.`,
          })
        )
      }
    ),
    def(
      "SETTLEMENT_RETURN_ONCE",
      "SETTLEMENTS",
      "Entrada nominal registrada una sola vez y por el importe devuelto",
      async () => {
        const list = await q<{
          id: string
          folio: string
          returned: string
          moved: string | null
        }>(Prisma.sql`
          SELECT s."id", s."folio", s."returnedNominalAmount"::text AS returned,
            (SELECT SUM(m."circulationBefore" - m."circulationAfter") FROM "chip_nominal_movements" m
              WHERE m."operationId" = s."chipReturnOperationId")::text AS moved
          FROM "player_settlements" s
          WHERE s."status" IN ('PENDING_PAYOUT', 'COMPLETED')
            AND ((s."returnedNominalAmount" > 0 AND (s."chipReturnOperationId" IS NULL
                  OR COALESCE((SELECT SUM(m."circulationBefore" - m."circulationAfter") FROM "chip_nominal_movements" m
                     WHERE m."operationId" = s."chipReturnOperationId"), 0) <> s."returnedNominalAmount"))
              OR (s."returnedNominalAmount" = 0 AND s."chipReturnOperationId" IS NOT NULL))`)
        return rows(
          "SETTLEMENT_RETURN_ONCE",
          "SETTLEMENTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "PlayerSettlement",
            entityId: r.id,
            expected: dec(r.returned).toFixed(2),
            actual: r.moved === null ? "sin entrada" : dec(r.moved).toFixed(2),
            explanation: `La recepción de ${r.folio} no registró exactamente una entrada por el valor devuelto.`,
          })
        )
      }
    ),
    def(
      "SETTLEMENT_OFFSET_MATCH",
      "SETTLEMENTS",
      "Compensación = aplicaciones FIFO de la liquidación",
      async () => {
        const list = await q<{
          id: string
          folio: string
          offset: string
          applied: string
        }>(Prisma.sql`
          SELECT s."id", s."folio", COALESCE(s."offsetAmount", 0)::text AS "offset",
            COALESCE((SELECT SUM(a."amount") FROM "payment_allocations" a
              WHERE a."settlementId" = s."id" AND a."kind" = 'APPLICATION' AND a."source" = 'CHIP_SETTLEMENT_OFFSET'), 0)::text AS applied
          FROM "player_settlements" s
          WHERE s."status" IN ('PENDING_PAYOUT', 'COMPLETED', 'REVERSED')
            AND COALESCE(s."offsetAmount", 0) <> COALESCE((SELECT SUM(a."amount") FROM "payment_allocations" a
              WHERE a."settlementId" = s."id" AND a."kind" = 'APPLICATION' AND a."source" = 'CHIP_SETTLEMENT_OFFSET'), 0)`)
        return rows(
          "SETTLEMENT_OFFSET_MATCH",
          "SETTLEMENTS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "PlayerSettlement",
            entityId: r.id,
            expected: dec(r.offset).toFixed(2),
            actual: dec(r.applied).toFixed(2),
            explanation: `La compensación de ${r.folio} no coincide con sus aplicaciones FIFO.`,
          })
        )
      }
    ),
    def(
      "PAYABLE_DERIVED",
      "SETTLEMENTS",
      "Cuenta por pagar = pago neto de la liquidación",
      async () => {
        const list = await q<{
          id: string
          folio: string
          net: string | null
          payable: string | null
        }>(Prisma.sql`
          SELECT s."id", s."folio", s."netPayoutAmount"::text AS net, p."originalAmount"::text AS payable
          FROM "player_settlements" s LEFT JOIN "settlement_payables" p ON p."settlementId" = s."id"
          WHERE s."status" IN ('PENDING_PAYOUT', 'COMPLETED')
            -- El Módulo 11 crea la cuenta por pagar SIEMPRE, también por $0
            -- (sin movimiento ficticio): debe existir y coincidir con el neto.
            AND (p."id" IS NULL OR p."originalAmount" <> COALESCE(s."netPayoutAmount", 0))`)
        return rows(
          "PAYABLE_DERIVED",
          "SETTLEMENTS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "PlayerSettlement",
            entityId: r.id,
            expected: dec(r.net).toFixed(2),
            actual:
              r.payable === null
                ? "sin cuenta por pagar"
                : dec(r.payable).toFixed(2),
            explanation: `La obligación por pagar de ${r.folio} no coincide con su pago neto.`,
          })
        )
      }
    ),
    def(
      "PAYOUT_NOT_EXCEED",
      "SETTLEMENTS",
      "Pagos ejecutados no exceden la obligación (sin pagos duplicados)",
      async () => {
        const list = await q<{
          id: string
          original: string
          executed: string
        }>(Prisma.sql`
          SELECT p."id", p."originalAmount"::text AS original,
            COALESCE(SUM(x."amount") FILTER (WHERE x."status" = 'EXECUTED'), 0)::text AS executed
          FROM "settlement_payables" p LEFT JOIN "settlement_payouts" x ON x."payableId" = p."id"
          GROUP BY p."id"
          HAVING COALESCE(SUM(x."amount") FILTER (WHERE x."status" = 'EXECUTED'), 0) > p."originalAmount"`)
        return rows(
          "PAYOUT_NOT_EXCEED",
          "SETTLEMENTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "SettlementPayable",
            entityId: r.id,
            expected: `≤ ${dec(r.original).toFixed(2)}`,
            actual: dec(r.executed).toFixed(2),
            difference: dec(r.executed).sub(dec(r.original)).toFixed(2),
            explanation:
              "Se pagó al jugador más que su obligación (pago duplicado).",
          })
        )
      }
    ),
    def(
      "PAYOUT_EXECUTED_HAS_TX",
      "SETTLEMENTS",
      "Pagos ejecutados con asiento; pendientes sin asiento",
      async () => {
        const list = await q<{
          id: string
          status: string
          method: string
        }>(Prisma.sql`
          SELECT "id", "status"::text AS status, "method"::text AS method FROM "settlement_payouts"
          WHERE ("status" = 'EXECUTED' AND "financialTransactionId" IS NULL)
             OR ("status" <> 'EXECUTED' AND "financialTransactionId" IS NOT NULL)`)
        return rows(
          "PAYOUT_EXECUTED_HAS_TX",
          "SETTLEMENTS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "SettlementPayout",
            entityId: r.id,
            actual: `${r.method} ${r.status}`,
            explanation:
              "Un pago al jugador no corresponde con su asiento financiero (una transferencia pendiente no es pago ejecutado).",
          })
        )
      }
    ),
    def(
      "PARTICIPATION_SETTLEMENT_STATE",
      "SETTLEMENTS",
      "Estados SETTLING / SETTLED coherentes con lo pagado",
      async () => {
        const list = await q<{
          id: string
          status: string
          pending: string
        }>(Prisma.sql`
          SELECT tp."id", tp."status"::text AS status,
            (p."originalAmount" - COALESCE((SELECT SUM(x."amount") FROM "settlement_payouts" x
              WHERE x."payableId" = p."id" AND x."status" = 'EXECUTED'), 0))::text AS pending
          FROM "table_participations" tp
          JOIN "settlement_payables" p ON p."settlementId" = tp."settlementId" AND p."status" <> 'VOIDED'
          WHERE (tp."status" = 'SETTLED' AND p."originalAmount" > COALESCE((SELECT SUM(x."amount") FROM "settlement_payouts" x
              WHERE x."payableId" = p."id" AND x."status" = 'EXECUTED'), 0))`)
        return rows(
          "PARTICIPATION_SETTLEMENT_STATE",
          "SETTLEMENTS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "TableParticipation",
            entityId: r.id,
            actual: `${r.status} con $${dec(r.pending).toFixed(2)} por pagar`,
            explanation:
              "Una participación figura como SETTLED aunque aún se le debe dinero al jugador.",
          })
        )
      }
    ),
    def(
      "PAYABLES_PENDING_INFO",
      "SETTLEMENTS",
      "Obligaciones por pagar pendientes (estado legítimo)",
      async () => {
        const [r] = await q<{ n: bigint; pending: string | null }>(Prisma.sql`
          SELECT COUNT(*) FILTER (WHERE p."originalAmount" > COALESCE(x."executed", 0)) AS n,
            SUM(p."originalAmount" - COALESCE(x."executed", 0))::text AS pending
          FROM "settlement_payables" p LEFT JOIN (
            SELECT "payableId", SUM("amount") FILTER (WHERE "status" = 'EXECUTED') AS executed
            FROM "settlement_payouts" GROUP BY "payableId") x ON x."payableId" = p."id"
          WHERE p."status" <> 'VOIDED'`)
        return [
          {
            checkCode: "PAYABLES_PENDING_INFO",
            category: "SETTLEMENTS",
            status: "OK",
            severity: "INFO",
            actual: dec(r.pending).toFixed(2),
            explanation: `${r.n} obligación(es) pendientes por pagar a jugadores. Es un estado legítimo, no un error.`,
          },
        ]
      }
    ),

    // ── INVENTARIO ────────────────────────────────────────────────────
    def(
      "INV_SINGLE_SET",
      "INVENTORY",
      "Un único inventario compartido activo",
      async () => {
        const [r] = await q<{ n: bigint }>(
          Prisma.sql`SELECT COUNT(*) AS n FROM "chip_sets" WHERE "isActive"`
        )
        return Number(r.n) === 1
          ? []
          : [
              {
                checkCode: "INV_SINGLE_SET",
                category: "INVENTORY",
                status: "ERROR",
                severity: "HIGH",
                expected: "1",
                actual: String(r.n),
                explanation:
                  "Debe existir un solo inventario compartido (sin inventarios por mesa).",
              },
            ]
      }
    ),
    def(
      "INV_NO_TABLE_STOCK",
      "INVENTORY",
      "Sin existencias en inventarios por mesa (inactivos)",
      async () => {
        const list = await q<{ code: string; qty: bigint }>(Prisma.sql`
          SELECT cs."code", SUM(b."quantity") AS qty FROM "chip_inventory_balances" b
          JOIN "chip_sets" cs ON cs."id" = b."chipSetId"
          WHERE NOT cs."isActive" GROUP BY cs."code" HAVING SUM(b."quantity") > 0`)
        return rows(
          "INV_NO_TABLE_STOCK",
          "INVENTORY",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "ChipSet",
            entityId: r.code,
            actual: String(r.qty),
            explanation: `El juego inactivo ${r.code} conserva existencias.`,
          })
        )
      }
    ),
    def(
      "INV_PROJECTION_LEDGER",
      "INVENTORY",
      "Custodia y circulación = libro nominal",
      async () => {
        const p = await getGlobalChipPosition(db)
        return p.ledgerConsistent
          ? []
          : [
              {
                checkCode: "INV_PROJECTION_LEDGER",
                category: "INVENTORY",
                status: "ERROR",
                severity: "CRITICAL",
                entityType: "ChipSet",
                entityId: p.chipSetId,
                expected: `custodia ${p.ledgerCustody.toFixed(2)} · circulación ${p.ledgerCirculation.toFixed(2)}`,
                actual: `custodia ${p.custody.toFixed(2)} · circulación ${p.circulation.toFixed(2)}`,
                explanation:
                  "La proyección del inventario no coincide con su libro de movimientos nominales.",
              },
            ]
      }
    ),
    def(
      "INV_NON_NEGATIVE",
      "INVENTORY",
      "Inventario nominal posible (sin negativos)",
      async () => {
        const list = await q<{
          chipSetId: string
          c: string
          r: string
          x: string
        }>(Prisma.sql`
          SELECT "chipSetId", "custodyNominal"::text AS c, "reservedNominal"::text AS r, "circulationNominal"::text AS x
          FROM "chip_set_inventory_states"
          WHERE "custodyNominal" < 0 OR "reservedNominal" < 0 OR "circulationNominal" < 0 OR "reservedNominal" > "custodyNominal"`)
        return rows(
          "INV_NON_NEGATIVE",
          "INVENTORY",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "ChipSet",
            entityId: r.chipSetId,
            actual: `custodia ${r.c} · reservado ${r.r} · circulación ${r.x}`,
            explanation:
              "Inventario nominal imposible (negativo o reservado mayor que la custodia).",
          })
        )
      }
    ),
    def(
      "INV_COUNT_DIFF_RECORDED",
      "INVENTORY",
      "Diferencias de arqueo registradas",
      async () => {
        const list = await q<{ id: string; diff: string }>(Prisma.sql`
          SELECT "id", "differenceTotal"::text AS diff FROM "chip_stock_counts"
          WHERE "status" = 'CONFIRMED' AND "differenceTotal" <> 0 AND "reconciliationStatus" = 'NOT_REQUIRED'`)
        return rows(
          "INV_COUNT_DIFF_RECORDED",
          "INVENTORY",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "ChipStockCount",
            entityId: r.id,
            actual: dec(r.diff).toFixed(2),
            explanation:
              "Un arqueo con diferencia física quedó marcado como «sin diferencia».",
          })
        )
      }
    ),
    def(
      "INV_PHYSICAL_DIFFERENCE_PENDING",
      "INVENTORY",
      "Faltantes físicos reales pendientes de resolver",
      async () => {
        const list = await q<{ id: string; diff: string }>(Prisma.sql`
          SELECT "id", "differenceTotal"::text AS diff FROM "chip_stock_counts"
          WHERE "status" = 'CONFIRMED' AND "reconciliationStatus" = 'PENDING'`)
        return rows(
          "INV_PHYSICAL_DIFFERENCE_PENDING",
          "INVENTORY",
          "WARNING",
          "MEDIUM",
          list,
          (r) => ({
            entityType: "ChipStockCount",
            entityId: r.id,
            actual: dec(r.diff).toFixed(2),
            explanation:
              "Diferencia FÍSICA de arqueo sin conciliar (A: faltante/sobrante real). No incluye fichas en circulación.",
          })
        )
      }
    ),
    def(
      "INV_CIRCULATION_INFO",
      "INVENTORY",
      "Fichas en circulación (estado legítimo)",
      async () => {
        const p = await getGlobalChipPosition(db)
        return [
          {
            checkCode: "INV_CIRCULATION_INFO",
            category: "INVENTORY",
            status: "OK",
            severity: "INFO",
            actual: p.circulation.toFixed(2),
            explanation:
              "Valor nominal fuera de custodia (B: legítimamente en circulación). No es faltante físico ni utilidad.",
          },
        ]
      }
    ),

    // ── BANCO Y TERMINAL ──────────────────────────────────────────────
    def(
      "BANK_CONFIRMED_HAS_TX",
      "BANK",
      "Transferencias verificadas con asiento; pendientes y rechazadas sin asiento",
      async () => {
        const list = await q<{
          id: string
          status: string
          tx: string | null
        }>(Prisma.sql`
          SELECT "id", "status"::text AS status, "transactionId" AS tx FROM "bank_transfer_verifications"
          WHERE ("status" = 'CONFIRMED' AND "transactionId" IS NULL)
             OR ("status" <> 'CONFIRMED' AND "transactionId" IS NOT NULL)`)
        return rows(
          "BANK_CONFIRMED_HAS_TX",
          "BANK",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "BankTransferVerification",
            entityId: r.id,
            actual: `${r.status} ${r.tx ? "con asiento" : "sin asiento"}`,
            explanation:
              "Una transferencia pendiente o rechazada no puede contarse como cobro, y una verificada debe tener su asiento.",
          })
        )
      }
    ),
    def(
      "BANK_PENDING_INFO",
      "BANK",
      "Transferencias por verificar (estado legítimo)",
      async () => {
        const [r] = await q<{ n: bigint; amount: string | null }>(Prisma.sql`
          SELECT COUNT(*) AS n, SUM("declaredAmount")::text AS amount
          FROM "bank_transfer_verifications" WHERE "status" = 'PENDING_VERIFICATION'`)
        return [
          {
            checkCode: "BANK_PENDING_INFO",
            category: "BANK",
            status: "OK",
            severity: "INFO",
            actual: dec(r.amount).toFixed(2),
            explanation: `${r.n} transferencia(s) por verificar. No son cobro hasta su verificación manual.`,
          },
        ]
      }
    ),
    def(
      "CARD_NO_DOUBLE_RECOGNITION",
      "BANK",
      "Depósito de terminal sin reconocer la venta otra vez",
      async () => {
        const list = await q<{ id: string; folio: string }>(Prisma.sql`
          SELECT DISTINCT t."id", t."folio" FROM "cash_transactions" t
          JOIN "cash_transaction_entries" e ON e."transactionId" = t."id"
          JOIN "financial_accounts" a ON a."id" = e."accountId"
          WHERE t."transactionType" = 'CARD_TERMINAL_SETTLEMENT'
            AND a."kind" IN ('PLAYER_PURCHASES', 'PLAYER_DEBT_PAYMENTS')`)
        return rows(
          "CARD_NO_DOUBLE_RECOGNITION",
          "BANK",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "CashTransaction",
            entityId: r.id,
            explanation: `El depósito de terminal ${r.folio} volvió a reconocer la venta (doble ingreso).`,
          })
        )
      }
    ),

    // ── OPERACIONES ESPECIALES (Módulo 16) ────────────────────────────
    def(
      "SPECIAL_PAYOUT_LEDGER",
      "SPECIAL_OPERATIONS",
      "Pago especial EJECUTADO ⇔ un asiento real por su importe",
      async () => {
        const list = await q<{
          id: string
          folio: string
          problem: string
        }>(Prisma.sql`
          SELECT x."id", x."folio", 'executed-without-entry' AS problem
          FROM "special_payouts" x
          WHERE x."status" = 'EXECUTED' AND NOT EXISTS (
            SELECT 1 FROM "cash_transactions" t
            JOIN "cash_transaction_entries" e ON e."transactionId" = t."id" AND e."direction" = 'CREDIT'
            WHERE t."id" = x."financialTransactionId" AND t."referenceType" = 'SpecialPayout'
              AND t."referenceId" = x."id" AND e."amount" = x."amount")
          UNION ALL
          SELECT t."id", t."folio", 'entry-without-executed-payout' AS problem
          FROM "cash_transactions" t
          WHERE t."referenceType" = 'SpecialPayout' AND t."transactionType" <> 'REVERSAL'
            AND NOT EXISTS (SELECT 1 FROM "special_payouts" x
              WHERE x."id" = t."referenceId" AND x."status" = 'EXECUTED' AND x."financialTransactionId" = t."id")`)
        return rows(
          "SPECIAL_PAYOUT_LEDGER",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType:
              r.problem === "executed-without-entry"
                ? "SpecialPayout"
                : "CashTransaction",
            entityId: r.id,
            explanation:
              r.problem === "executed-without-entry"
                ? `El pago especial ${r.folio} figura como pagado sin su asiento real.`
                : `El asiento ${r.folio} paga una operación especial que no está ejecutada (posible doble pago).`,
          })
        )
      }
    ),
    def(
      "SPECIAL_PAYABLE_STATE",
      "SPECIAL_OPERATIONS",
      "Obligaciones especiales: nunca pagadas de más y estado coherente",
      async () => {
        const list = await q<{
          id: string
          kind: string
          status: string
          original: Prisma.Decimal
          executed: Prisma.Decimal
          committed: Prisma.Decimal
        }>(Prisma.sql`
          SELECT p."id", p."kind"::text AS kind, p."status"::text AS status, p."originalAmount" AS original,
            COALESCE(SUM(x."amount") FILTER (WHERE x."status" = 'EXECUTED'), 0) AS executed,
            COALESCE(SUM(x."amount") FILTER (WHERE x."status" IN ('EXECUTED', 'PENDING')), 0) AS committed
          FROM "special_payables" p LEFT JOIN "special_payouts" x ON x."payableId" = p."id"
          GROUP BY p."id"
          HAVING COALESCE(SUM(x."amount") FILTER (WHERE x."status" IN ('EXECUTED', 'PENDING')), 0) > p."originalAmount"
             OR (p."status" = 'PAID') <> (COALESCE(SUM(x."amount") FILTER (WHERE x."status" = 'EXECUTED'), 0) >= p."originalAmount")`)
        return rows(
          "SPECIAL_PAYABLE_STATE",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "SpecialPayable",
            entityId: r.id,
            expected: dec(r.original).toFixed(2),
            actual: dec(r.executed).toFixed(2),
            explanation: `La obligación (${r.kind}) está en ${r.status} con $${dec(r.executed).toFixed(2)} pagados y $${dec(r.committed).toFixed(2)} comprometidos de $${dec(r.original).toFixed(2)}.`,
          })
        )
      }
    ),
    def(
      "REDEMPTION_ENTRY_ONCE",
      "SPECIAL_OPERATIONS",
      "Canje recibido ⇔ una entrada nominal y una obligación por lo aceptado",
      async () => {
        const list = await q<{ id: string; folio: string }>(Prisma.sql`
          SELECT r."id", r."folio" FROM "late_chip_redemptions" r
          WHERE r."chipOperationId" IS NOT NULL AND (
            (SELECT COALESCE(SUM(m."amount"), 0) FROM "chip_nominal_movements" m
              WHERE m."referenceType" = 'LateChipRedemption' AND m."referenceId" = r."id") <> r."acceptedNominal"
            OR NOT EXISTS (SELECT 1 FROM "special_payables" p
              WHERE p."kind" = 'REDEMPTION' AND p."sourceId" = r."id" AND p."originalAmount" = r."acceptedNominal"))
          UNION ALL
          SELECT r."id", r."folio" FROM "late_chip_redemptions" r
          WHERE r."chipOperationId" IS NULL AND EXISTS (SELECT 1 FROM "chip_nominal_movements" m
              WHERE m."referenceType" = 'LateChipRedemption' AND m."referenceId" = r."id")`)
        return rows(
          "REDEMPTION_ENTRY_ONCE",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "LateChipRedemption",
            entityId: r.id,
            explanation: `El canje ${r.folio} no cuadra entre la entrada de fichas, lo aceptado y su obligación.`,
          })
        )
      }
    ),
    def(
      "PURCHASE_REVERSAL_CONSISTENT",
      "SPECIAL_OPERATIONS",
      "Compra revertida ⇔ devolución física completa, extinción y reembolso que cuadran",
      async () => {
        const list = await q<{
          id: string
          folio: string
          problem: string
        }>(Prisma.sql`
          SELECT p."id", p."folio", 'reversed-without-record' AS problem FROM "chip_purchases" p
          WHERE p."status" = 'REVERSED' AND NOT EXISTS (SELECT 1 FROM "purchase_reversals" r WHERE r."purchaseId" = p."id")
          UNION ALL
          SELECT r."id", r."folio", 'amounts' AS problem
          FROM "purchase_reversals" r JOIN "chip_purchases" p ON p."id" = r."purchaseId"
          WHERE p."status" <> 'REVERSED'
             OR r."returnedNominal" <> p."nominalAmount"
             OR r."extinguishedAmount" + r."refundAmount" <> p."nominalAmount"
             OR (SELECT COALESCE(SUM(m."amount"), 0) FROM "chip_nominal_movements" m
                 WHERE m."referenceType" = 'PurchaseReversal' AND m."referenceId" = p."id") <> p."nominalAmount"
             OR (SELECT COALESCE(SUM(a."amount"), 0) FROM "payment_allocations" a
                 WHERE a."purchaseReversalId" = r."id") <> r."extinguishedAmount"
             OR (r."refundAmount" > 0 AND NOT EXISTS (SELECT 1 FROM "special_payables" sp
                 WHERE sp."kind" = 'PURCHASE_REFUND' AND sp."sourceId" = r."id" AND sp."originalAmount" = r."refundAmount"))`)
        return rows(
          "PURCHASE_REVERSAL_CONSISTENT",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType:
              r.problem === "amounts" ? "PurchaseReversal" : "ChipPurchase",
            entityId: r.id,
            explanation:
              r.problem === "amounts"
                ? `El reverso ${r.folio} no cuadra (fichas devueltas, extinción y reembolso deben sumar el valor de la compra).`
                : `La compra ${r.folio} figura revertida sin un reverso ejecutado.`,
          })
        )
      }
    ),
    def(
      "SETTLEMENT_CORRECTION_CONSISTENT",
      "SPECIAL_OPERATIONS",
      "Corrección de liquidación ⇔ obligación nueva (y contraasientos si revierte compensación)",
      async () => {
        const list = await q<{ id: string; folio: string }>(Prisma.sql`
          SELECT c."id", c."folio" FROM "settlement_corrections" c
          WHERE NOT EXISTS (SELECT 1 FROM "special_payables" p
              WHERE p."kind" = 'SETTLEMENT_ADJUSTMENT' AND p."sourceId" = c."id" AND p."originalAmount" = c."amount")
             OR NOT EXISTS (SELECT 1 FROM "special_operation_evidence" e
              WHERE e."sourceType" = 'SettlementCorrection' AND e."sourceId" = c."id")
             OR (c."kind" = 'OFFSET_REVERSAL' AND (SELECT COALESCE(SUM(a."amount"), 0) FROM "payment_allocations" a
              WHERE a."settlementId" = c."settlementId" AND a."kind" = 'REVERSAL') <> c."amount")`)
        return rows(
          "SETTLEMENT_CORRECTION_CONSISTENT",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "SettlementCorrection",
            entityId: r.id,
            explanation: `La corrección ${r.folio} no tiene su obligación, su firma o sus contraasientos completos.`,
          })
        )
      }
    ),
    def(
      "UNAPPLIED_REFUND_WITHIN",
      "SPECIAL_OPERATIONS",
      "Devolución de fondos no aplicados = importe realmente recibido",
      async () => {
        const list = await q<{ id: string }>(Prisma.sql`
          SELECT p."id" FROM "special_payables" p
          JOIN "unapplied_player_funds" u ON u."id" = p."sourceId"
          WHERE p."kind" = 'UNAPPLIED_REFUND' AND p."originalAmount" <> u."amount"`)
        return rows(
          "UNAPPLIED_REFUND_WITHIN",
          "SPECIAL_OPERATIONS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "SpecialPayable",
            entityId: r.id,
            explanation:
              "La devolución registrada no coincide con el importe realmente recibido y no aplicado.",
          })
        )
      }
    ),
    def(
      "SPECIAL_PAYABLES_PENDING_INFO",
      "SPECIAL_OPERATIONS",
      "Obligaciones especiales pendientes (estado legítimo)",
      async () => {
        const [r] = await q<{
          n: bigint
          amount: Prisma.Decimal | null
        }>(Prisma.sql`
          SELECT COUNT(*) AS n, SUM(p."originalAmount" - COALESCE((SELECT SUM(x."amount") FROM "special_payouts" x
            WHERE x."payableId" = p."id" AND x."status" = 'EXECUTED'), 0)) AS amount
          FROM "special_payables" p WHERE p."status" <> 'PAID'`)
        return [
          {
            checkCode: "SPECIAL_PAYABLES_PENDING_INFO",
            category: "SPECIAL_OPERATIONS",
            status: "OK",
            severity: "INFO",
            actual: dec(r.amount ?? 0).toFixed(2),
            explanation: `${r.n} obligación(es) especial(es) por pagar ($${dec(r.amount ?? 0).toFixed(2)}). Una obligación pendiente NO es un error.`,
          },
        ]
      }
    ),

    // ── EVIDENCIAS Y AUDITORÍA ────────────────────────────────────────
    def(
      "EVIDENCE_INTEGRITY",
      "EVIDENCE",
      "Evidencias privadas íntegras (SHA-256)",
      async () => {
        const list = await q<{ id: string; problem: string }>(Prisma.sql`
          SELECT f."id",
            CASE WHEN b."storageKey" IS NULL THEN 'missing'
                 WHEN encode(sha256(b."bytes"), 'hex') <> f."sha256" THEN 'hash'
                 ELSE 'size' END AS problem
          FROM "stored_files" f LEFT JOIN "evidence_blobs" b ON b."storageKey" = f."storageKey"
          WHERE f."status" = 'ACTIVE' AND f."driver" = 'postgres'
            AND (b."storageKey" IS NULL OR encode(sha256(b."bytes"), 'hex') <> f."sha256" OR octet_length(b."bytes") <> f."sizeBytes")`)
        return rows(
          "EVIDENCE_INTEGRITY",
          "EVIDENCE",
          "ERROR",
          "CRITICAL",
          list,
          (r) => ({
            entityType: "StoredFile",
            entityId: r.id,
            actual: r.problem,
            explanation:
              r.problem === "missing"
                ? "Falta el archivo privado de una evidencia activa."
                : "Alteración detectada: el contenido de la evidencia no coincide con su huella registrada.",
          })
        )
      }
    ),
    // ── CONCILIACIÓN GLOBAL DE FICHAS (corrección transversal) ─────────
    def(
      "SESSION_NOMINAL_BALANCE",
      "INVENTORY",
      "Sesiones cerradas: entregado = devuelto (+ diferencias autorizadas)",
      async () => {
        const list = await q<{
          id: string
          folio: string
          diff: string
        }>(Prisma.sql`
          SELECT s."id", s."folio",
            (COALESCE((SELECT SUM(m."circulationAfter" - m."circulationBefore") FROM "chip_nominal_movements" m WHERE m."sessionId" = s."id"), 0)
             - COALESCE((SELECT SUM(r."amount") FROM "session_chip_reconciliations" r
                 WHERE r."sessionId" = s."id" AND r."kind" = 'UNRECOVERED_AUTHORIZED'), 0))::text AS diff
          FROM "poker_sessions" s
          WHERE s."status" = 'CLOSED'
            AND COALESCE((SELECT SUM(m."circulationAfter" - m."circulationBefore") FROM "chip_nominal_movements" m WHERE m."sessionId" = s."id"), 0)
             - COALESCE((SELECT SUM(r."amount") FROM "session_chip_reconciliations" r
                 WHERE r."sessionId" = s."id" AND r."kind" = 'UNRECOVERED_AUTHORIZED'), 0) <> 0`)
        return rows(
          "SESSION_NOMINAL_BALANCE",
          "INVENTORY",
          "WARNING",
          "MEDIUM",
          list,
          (r) => ({
            entityType: "PokerSession",
            entityId: r.id,
            expected: "0.00",
            actual: dec(r.diff).toFixed(2),
            explanation: `La sesión ${r.folio} cerró con una diferencia nominal sin conciliar (${dec(r.diff).toFixed(2)}): requiere revisión (cierres anteriores a la conciliación global). No se corrige automáticamente.`,
          })
        )
      }
    ),
    // ── REGISTROS ADMINISTRATIVOS (Módulo 17, privado) ────────────────
    // Textos NEUTROS: el diagnóstico general no revela quién está bancado.
    def(
      "ADMIN_FUNDED_PURCHASES",
      "ADMINISTRATIVE_RECORDS",
      "Entregas administrativas: sin cobros ni deuda y ligadas a su registro",
      async () => {
        const list = await q<{
          id: string
          folio: string
          problem: string
        }>(Prisma.sql`
          SELECT p."id", p."folio", 'without-record' AS problem FROM "chip_purchases" p
          WHERE p."fundingSource" = 'HOUSE' AND p."status" = 'CONFIRMED'
            AND NOT EXISTS (SELECT 1 FROM "banking_game_financial_sources" s WHERE s."purchaseId" = p."id")
          UNION ALL
          SELECT p."id", p."folio", 'with-money' AS problem FROM "chip_purchases" p
          WHERE p."fundingSource" = 'HOUSE'
            AND (EXISTS (SELECT 1 FROM "purchase_payments" x WHERE x."purchaseId" = p."id")
              OR EXISTS (SELECT 1 FROM "player_debts" d WHERE d."purchaseId" = p."id"))`)
        return rows(
          "ADMIN_FUNDED_PURCHASES",
          "ADMINISTRATIVE_RECORDS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "ChipPurchase",
            entityId: r.id,
            explanation:
              r.problem === "without-record"
                ? `La entrega ${r.folio} no está ligada a su registro administrativo.`
                : `La entrega administrativa ${r.folio} tiene cobros o deuda (no debería).`,
          })
        )
      }
    ),
    def(
      "ADMIN_RECORD_RESULTS",
      "ADMINISTRATIVE_RECORDS",
      "Registros administrativos: resultado = devuelto − entregado y retorno físico único",
      async () => {
        const list = await q<{ id: string }>(Prisma.sql`
          SELECT g."id" FROM "banking_games" g
          WHERE g."status" IN ('CONFIRMED', 'UNDER_CORRECTION')
            AND (g."financedNominal" <> COALESCE((SELECT SUM(s."nominalAmount") FROM "banking_game_financial_sources" s WHERE s."gameId" = g."id"), 0)
              OR g."grossResult" <> g."returnedNominal" - g."financedNominal"
              OR (g."returnedNominal" > 0 AND (SELECT COUNT(*) FROM "chip_inventory_operations" o
                    WHERE o."referenceType" = 'BankingGame' AND o."referenceId" = g."id") <> 1))`)
        return rows(
          "ADMIN_RECORD_RESULTS",
          "ADMINISTRATIVE_RECORDS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "AdministrativeRecord",
            entityId: r.id,
            explanation:
              "Un registro administrativo conciliado no cuadra con sus entregas o su devolución física.",
          })
        )
      }
    ),
    def(
      "ADMIN_RESERVE_NONNEGATIVE",
      "ADMINISTRATIVE_RECORDS",
      "Saldos contables administrativos nunca negativos",
      async () => {
        const list = await q<{ playerId: string }>(Prisma.sql`
          SELECT m."playerId" FROM "banking_reserve_movements" m GROUP BY m."playerId"
          HAVING SUM(CASE WHEN m."kind" IN ('CREATED', 'RELEASED_FROM_WITHDRAWAL') THEN m."amount" ELSE -m."amount" END) < 0`)
        return rows(
          "ADMIN_RESERVE_NONNEGATIVE",
          "ADMINISTRATIVE_RECORDS",
          "ERROR",
          "HIGH",
          list,
          (r) => ({
            entityType: "AdministrativeRecord",
            entityId: r.playerId,
            explanation: "Un saldo contable administrativo quedó negativo.",
          })
        )
      }
    ),
    def(
      "AUDIT_APPEND_ONLY",
      "AUDIT",
      "Auditoría protegida contra edición y borrado",
      async () => {
        const list = await q<{ tgname: string }>(Prisma.sql`
          SELECT t."tgname" FROM pg_trigger t JOIN pg_class c ON c."oid" = t."tgrelid"
          WHERE c."relname" = 'audit_logs' AND NOT t."tgisinternal" AND t."tgenabled" <> 'D'`)
        return list.length > 0
          ? []
          : [
              {
                checkCode: "AUDIT_APPEND_ONLY",
                category: "AUDIT",
                status: "ERROR",
                severity: "CRITICAL",
                entityType: "Table",
                entityId: "audit_logs",
                explanation:
                  "No existe (o está deshabilitado) el trigger que impide editar o borrar la auditoría.",
              },
            ]
      }
    ),
  ]
}
