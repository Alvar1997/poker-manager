import "server-only"

import ExcelJS from "exceljs"

import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAuditSafe } from "@/modules/audit/audit.service"
import { addTable } from "@/modules/reports/xlsx.workbook"

import {
  ADVANCE_SOURCE,
  CLOSING_SOURCE,
  effectiveResult,
  payoutTotals,
  WITHDRAWAL_SOURCE,
} from "./banking-core"
import { listBankedPlayers } from "./banking-query.service"
import { dec, fmt, reserveBalance } from "./banking.math"

/**
 * Reporte PRIVADO de bancaje (Módulo 17). Exportación EXCLUSIVA XLSX con la
 * misma infraestructura del Módulo 14 (anti-inyección de fórmulas, formato
 * MXN numérico) y auditoría `BANKING_REPORT_EXPORTED` (módulo restringido).
 * Separa importes CONTABLES (resultados, participaciones, reservas,
 * pérdidas) de movimientos REALES de dinero (pagos ejecutados).
 */

export const BANKING_XLSX_NAME = "PokerManager_Bancaje.xlsx"

export async function buildBankingXlsx(
  actor: { id: string; name: string },
  ctx: { requestId?: string } = {}
) {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Poker Manager"
  wb.created = new Date()
  const players = await listBankedPlayers()
  addTable(
    wb,
    "Jugadores",
    [
      { header: "Jugador", type: "text", value: (r) => r.player.name },
      { header: "Acuerdo", type: "text", value: (r) => r.status },
      { header: "% jugador", type: "text", value: (r) => r.playerPercent },
      { header: "% casa", type: "text", value: (r) => r.housePercent },
      { header: "Ciclo actual", type: "int", value: (r) => r.cycle?.number },
      {
        header: "Jugadas confirmadas",
        type: "int",
        value: (r) => r.cycle?.confirmed,
      },
      { header: "Reserva (contable)", type: "money", value: (r) => r.reserve },
      {
        header: "Pérdida por recuperar",
        type: "money",
        value: (r) => r.pendingLoss,
      },
    ],
    players,
    { title: "Jugadores bancados (privado)" }
  )
  const games = await prisma.bankingGame.findMany({
    orderBy: [{ playerId: "asc" }, { startedAt: "asc" }],
    include: {
      player: { select: { name: true } },
      cycle: { select: { number: true } },
      session: { select: { folio: true, businessDate: true } },
      adjustments: { select: { amount: true } },
      sources: { select: { nominalAmount: true } },
    },
  })
  addTable(
    wb,
    "Jugadas",
    [
      { header: "Jugador", type: "text", value: (g) => g.player.name },
      { header: "Ciclo", type: "int", value: (g) => g.cycle.number },
      { header: "Jugada", type: "int", value: (g) => g.gameNumber },
      { header: "Sesión", type: "text", value: (g) => g.session.folio },
      {
        header: "Fecha operativa",
        type: "text",
        value: (g) => g.session.businessDate.toISOString().slice(0, 10),
      },
      { header: "Estado", type: "text", value: (g) => g.status },
      {
        header: "Financiado",
        type: "money",
        value: (g) =>
          fmt(g.sources.reduce((a, s) => a.add(dec(s.nominalAmount)), dec(0))),
      },
      {
        header: "Devuelto",
        type: "money",
        value: (g) => (g.returnedNominal ? fmt(dec(g.returnedNominal)) : null),
      },
      {
        header: "Resultado bruto",
        type: "money",
        value: (g) => (g.grossResult ? fmt(dec(g.grossResult)) : null),
      },
      {
        header: "Resultado con ajustes",
        type: "money",
        value: (g) => (g.grossResult ? fmt(effectiveResult(g)) : null),
      },
    ],
    games,
    { title: "Jugadas (resultado económico; no es dinero)" }
  )
  const closings = await prisma.bankingCycleClosing.findMany({
    where: { status: "APPROVED" },
    orderBy: { decidedAt: "asc" },
    include: {
      cycle: { select: { number: true, player: { select: { name: true } } } },
      decidedBy: { select: { name: true } },
    },
  })
  addTable(
    wb,
    "Cortes",
    [
      { header: "Jugador", type: "text", value: (c) => c.cycle.player.name },
      { header: "Ciclo", type: "int", value: (c) => c.cycle.number },
      {
        header: "Resultado bruto",
        type: "money",
        value: (c) => fmt(dec(c.grossTotal)),
      },
      {
        header: "Pérdida anterior",
        type: "money",
        value: (c) => fmt(dec(c.previousCarriedLoss)),
      },
      {
        header: "Reserva aplicada",
        type: "money",
        value: (c) => fmt(dec(c.reserveConsumed)),
      },
      {
        header: "Participación jugador",
        type: "money",
        value: (c) => fmt(dec(c.playerShare)),
      },
      {
        header: "Participación casa",
        type: "money",
        value: (c) => fmt(dec(c.houseShare)),
      },
      {
        header: "Anticipos pagados",
        type: "money",
        value: (c) => fmt(dec(c.advancesPaid)),
      },
      {
        header: "Excedente",
        type: "money",
        value: (c) => fmt(dec(c.excessAdvance)),
      },
      {
        header: "A reserva",
        type: "money",
        value: (c) => fmt(dec(c.reserveAmount)),
      },
      {
        header: "Reconocido para pago",
        type: "money",
        value: (c) => fmt(dec(c.payAmount)),
      },
      {
        header: "Pérdida arrastrada",
        type: "money",
        value: (c) => fmt(dec(c.carriedLossOut)),
      },
      { header: "Aprobó", type: "text", value: (c) => c.decidedBy?.name },
      { header: "Aprobado", type: "datetime", value: (c) => c.decidedAt },
    ],
    closings,
    { title: "Cortes aprobados (importes contables)" }
  )
  const payables = await prisma.specialPayable.findMany({
    where: {
      kind: {
        in: [
          "BANKING_ADVANCE",
          "BANKING_CYCLE_PAYOUT",
          "BANKING_RESERVE_WITHDRAWAL",
        ],
      },
    },
    orderBy: { createdAt: "asc" },
    include: { payouts: true, player: { select: { name: true } } },
  })
  const KIND: Record<string, string> = {
    [ADVANCE_SOURCE]: "Anticipo",
    [CLOSING_SOURCE]: "Pago de corte",
    [WITHDRAWAL_SOURCE]: "Retiro de reserva",
  }
  addTable(
    wb,
    "Pagos reales",
    [
      { header: "Jugador", type: "text", value: (p) => p.player?.name },
      {
        header: "Concepto",
        type: "text",
        value: (p) => KIND[p.sourceType] ?? p.kind,
      },
      {
        header: "Obligación",
        type: "money",
        value: (p) => fmt(dec(p.originalAmount)),
      },
      {
        header: "Pagado (ejecutado)",
        type: "money",
        value: (p) => fmt(payoutTotals([p]).executed),
      },
      {
        header: "En trámite",
        type: "money",
        value: (p) => fmt(payoutTotals([p]).inTransit),
      },
      {
        header: "Pendiente",
        type: "money",
        value: (p) => fmt(payoutTotals([p]).unpaid),
      },
      { header: "Registrada", type: "datetime", value: (p) => p.createdAt },
    ],
    payables,
    { title: "Movimientos REALES de dinero (desembolsos)" }
  )
  const movements = await prisma.bankingReserveMovement.findMany({
    orderBy: { createdAt: "asc" },
    include: { player: { select: { name: true } } },
  })
  addTable(
    wb,
    "Reserva",
    [
      { header: "Jugador", type: "text", value: (m) => m.player.name },
      { header: "Movimiento", type: "text", value: (m) => m.kind },
      {
        header: "Importe (+/−)",
        type: "money",
        value: (m) =>
          fmt(reserveBalance([{ kind: m.kind, amount: dec(m.amount) }])),
      },
      { header: "Nota", type: "text", value: (m) => m.notes },
      { header: "Fecha", type: "datetime", value: (m) => m.createdAt },
    ],
    movements,
    { title: "Libro de reserva (contable; no es dinero en caja)" }
  )
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  const rows =
    players.length +
    games.length +
    closings.length +
    payables.length +
    movements.length
  await recordAuditSafe({
    action: AUDIT_ACTIONS.BANKING_REPORT_EXPORTED,
    entityType: "Report",
    entityId: "banking",
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { format: "XLSX", rows, bytes: buffer.length },
  })
  return { buffer, fileName: BANKING_XLSX_NAME, rows }
}
