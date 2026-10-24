import "server-only"

import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { sharedChipSetId, type Db } from "@/modules/inventory/inventory.core"
import {
  circulationByPlayer,
  circulationFlows,
  dec,
  fmt,
  sessionChipReconciliation,
  ZERO,
} from "@/modules/closure/closure.math"

/**
 * Control de fichas EN CIRCULACIÓN (Módulo 12, regla crítica §11).
 *
 * La fuente de verdad es el libro nominal del Módulo 04
 * (`chip_nominal_movements`); `chip_set_inventory_states` es su proyección.
 * La circulación es GLOBAL y CONTINUA (inventario compartido entre sesiones):
 * nunca se reinicia al cerrar ni se reconstruye sumando cierres aislados.
 *
 * Una cifra en circulación NO es un faltante físico, ni dinero, ni deuda, ni
 * utilidad, ni prueba de que alguien tenga derecho a cobrar: es valor
 * nominal pendiente de retorno, canjeable solo con recepción física real.
 */

const flowSelect = {
  movementType: true,
  custodyBefore: true,
  custodyAfter: true,
  circulationBefore: true,
  circulationAfter: true,
  playerId: true,
} as const

/** Circulación y custodia globales: proyección + verificación contra el libro. */
export async function getGlobalChipPosition(db: Db = prisma) {
  const chipSetId = await sharedChipSetId(db)
  const [state, sums] = await Promise.all([
    db.chipSetInventoryState.findUnique({
      where: { chipSetId },
      select: {
        version: true,
        custodyNominal: true,
        reservedNominal: true,
        circulationNominal: true,
      },
    }),
    db.$queryRaw<{ custody: string | null; circulation: string | null }[]>`
      SELECT SUM("custodyAfter" - "custodyBefore")::text AS "custody",
             SUM("circulationAfter" - "circulationBefore")::text AS "circulation"
      FROM "chip_nominal_movements" WHERE "chipSetId" = ${chipSetId}
    `,
  ])
  const custody = dec(state?.custodyNominal)
  const circulation = dec(state?.circulationNominal)
  const ledgerCustody = dec(sums[0]?.custody ?? 0)
  const ledgerCirculation = dec(sums[0]?.circulation ?? 0)
  return {
    chipSetId,
    inventoryVersion: state?.version ?? 0,
    custody,
    reserved: dec(state?.reservedNominal),
    circulation,
    ledgerCustody,
    ledgerCirculation,
    /** La proyección coincide con el libro de movimientos. */
    ledgerConsistent:
      custody.equals(ledgerCustody) && circulation.equals(ledgerCirculation),
  }
}

/**
 * Fichas entregadas, devueltas y netas NO retornadas de una sesión (por su
 * libro nominal), más la atribución informativa por jugador y por mesa.
 */
export async function getSessionChipFlows(db: Db, sessionId: string) {
  const rows = await db.chipNominalMovement.findMany({
    where: { sessionId },
    select: { ...flowSelect, tableId: true },
  })
  const flows = circulationFlows(rows)
  const players = circulationByPlayer(rows)
  const names = await db.player.findMany({
    where: { id: { in: players.map((p) => p.playerId) } },
    select: { id: true, name: true },
  })
  const byTable = new Map<string, ReturnType<typeof circulationFlows>>()
  for (const tableId of new Set(rows.map((r) => r.tableId).filter(Boolean))) {
    byTable.set(
      tableId!,
      circulationFlows(rows.filter((r) => r.tableId === tableId))
    )
  }
  const tables = await db.pokerTable.findMany({
    where: { id: { in: [...byTable.keys()] } },
    select: { id: true, name: true },
  })
  return {
    delivered: flows.delivered,
    returned: flows.returned,
    netNotReturned: flows.net,
    byPlayer: players
      .map((p) => ({
        player: names.find((n) => n.id === p.playerId) ?? {
          id: p.playerId,
          name: "—",
        },
        delivered: fmt(p.delivered),
        returned: fmt(p.returned),
        net: fmt(p.net),
        /** Resultado INDIVIDUAL (devuelto − entregado): no es faltante. */
        result: fmt(p.returned.sub(p.delivered)),
      }))
      .sort(
        (a, b) =>
          dec(b.net).comparedTo(dec(a.net)) ||
          a.player.id.localeCompare(b.player.id)
      ),
    byTable: [...byTable.entries()]
      .map(([tableId, f]) => ({
        table: tables.find((t) => t.id === tableId) ?? {
          id: tableId,
          name: "—",
        },
        delivered: fmt(f.delivered),
        returned: fmt(f.returned),
      }))
      .sort((a, b) => a.table.name.localeCompare(b.table.name)),
  }
}

/**
 * Conciliación GLOBAL de fichas de la sesión (ambas mesas): entregado vs
 * devuelto, menos diferencias autorizadas, con su estado. Fuente única para
 * la prevalidación del cierre, la pantalla de pendientes y los reportes.
 */
export async function getSessionChipReconciliation(db: Db, sessionId: string) {
  const [flows, active, authorized, identified] = await Promise.all([
    getSessionChipFlows(db, sessionId),
    db.tableParticipation.count({ where: { sessionId, status: "ACTIVE" } }),
    db.sessionChipReconciliation.aggregate({
      where: { sessionId, kind: "UNRECOVERED_AUTHORIZED" },
      _sum: { amount: true },
    }),
    db.sessionChipReconciliation.aggregate({
      where: { sessionId, kind: "RETURN_IDENTIFIED_IN_COUNT" },
      _sum: { amount: true },
    }),
  ])
  const r = sessionChipReconciliation({
    delivered: flows.delivered,
    returned: flows.returned,
    authorizedUnrecovered: dec(authorized._sum.amount),
    activeParticipants: active,
  })
  return {
    ...r,
    activeParticipants: active,
    /** Ya incluido en `returned` (entrada nominal real registrada). */
    identifiedInCount: dec(identified._sum.amount),
    byPlayer: flows.byPlayer,
    byTable: flows.byTable,
  }
}

/**
 * CONTRATO para el canje POSTERIOR de fichas no retornadas (§12). Solo
 * EVALÚA; no registra entradas, obligaciones ni pagos. El canje completo
 * está implementado en el Módulo 16
 * (`src/modules/special-operations/redemption.service.ts`), que cumple:
 *   1. recibir físicamente las fichas y capturar su valor nominal real;
 *   2. registrar la entrada con `confirmNominalChipReturnInTx` (la base ya
 *      impide devolver más de lo que está en circulación) con una clave
 *      única por canje (nunca dos veces la misma devolución);
 *   3. crear su propia cuenta por pagar y desembolsos con los contratos del
 *      Módulo 11 (`recordSettlementPayoutInTx`, custodia o banco), sin
 *      reabrir la caja ni el inventario de la sesión original;
 *   4. ligar de forma INFORMATIVA la sesión original solo si se identifica
 *      con fundamento.
 * La circulación global NO prueba que una persona tenga derecho a cobrar:
 * es solo el máximo que podría regresar.
 */
export async function assessLateRedemption(amount: string, db: Db = prisma) {
  const position = await getGlobalChipPosition(db)
  const requested = dec(amount)
  return {
    requested: fmt(requested),
    globalCirculation: fmt(position.circulation),
    withinCirculation:
      requested.greaterThan(ZERO) &&
      requested.lessThanOrEqualTo(position.circulation),
    /** Sin recepción física no hay canje (este contrato no lo ejecuta). */
    requiresPhysicalReception: true as const,
    /** Se ejecuta en Operaciones especiales → Canjes (Módulo 16). */
    enabled: true as const,
    message:
      "El canje posterior se registra en Operaciones especiales: requiere validación del valor por un socio, recepción física y pagos reales. La circulación global no prueba el derecho a cobrar.",
  }
}

/**
 * Vista de fichas no retornadas de una sesión: tres cifras distintas que
 * nunca se mezclan (neto no retornado de la sesión, circulación global y
 * —en el arqueo— la diferencia física), más la atribución INFORMATIVA.
 */
export async function getOutstandingChips(sessionId: string) {
  const exists = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  })
  if (!exists) throw new NotFoundError("Sesión no encontrada")
  const [flows, global, rec] = await Promise.all([
    getSessionChipFlows(prisma, sessionId),
    getGlobalChipPosition(prisma),
    getSessionChipReconciliation(prisma, sessionId),
  ])
  return {
    session: {
      delivered: fmt(flows.delivered),
      returned: fmt(flows.returned),
      netNotReturned: fmt(flows.netNotReturned),
    },
    /** Conciliación GLOBAL de la sesión (ambas mesas). */
    reconciliation: {
      status: rec.status,
      authorizedUnrecovered: fmt(rec.authorizedUnrecovered),
      identifiedInCount: fmt(rec.identifiedInCount),
      difference: fmt(rec.difference),
      activeParticipants: rec.activeParticipants,
    },
    global: {
      circulation: fmt(global.circulation),
      custody: fmt(global.custody),
      ledgerConsistent: global.ledgerConsistent,
    },
    /** Lo que el historial registró a nombre de cada jugador: NO prueba posesión. */
    attributionByPlayer: flows.byPlayer,
    attributionByTable: flows.byTable,
    treatment: {
      physicalShortage: false,
      recognizedAsIncome: "0.00",
      payableCreated: false,
      note: "Ningún jugador se lleva fichas. El resultado individual (devuelto − entregado) no es un faltante: lo que un jugador pierde lo gana otro y regresa en su liquidación. Solo una diferencia GLOBAL con todos los jugadores terminados se investiga. Deudas y pagos pendientes son dinero, no fichas.",
    },
    lateRedemption: {
      enabled: false,
      requiresPhysicalReception: true,
    },
  }
}
