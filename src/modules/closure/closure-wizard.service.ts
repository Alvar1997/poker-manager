import "server-only"

import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { buildClosurePreview } from "@/modules/closure/closure.data"
import { getTableRake } from "@/modules/rake/rake.service"
import {
  getSessionTips,
  getTipsReviewState,
} from "@/modules/staff-tips/tips.service"

import {
  differenceText,
  firstOpenStep,
  stepStatus,
  WIZARD_STEPS,
  wizardProgress,
  type WizardStepId,
  type WizardTask,
} from "./closure-wizard.math"

/**
 * Asistente de cierre en 6 pasos. NO es un cierre paralelo: lee los MISMOS
 * datos y reglas del Módulo 12/18 (`buildClosurePreview`, rake, propinas) y
 * traduce cada pendiente a una tarea con su ruta real para resolverlo. El
 * cierre definitivo sigue siendo `confirmClosure`, que revalida todo.
 */

const S = (id: string) => `/dashboard/sesiones/${id}`

export async function getClosureWizard(sessionId: string) {
  const session = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      folio: true,
      status: true,
      openedAt: true,
      businessDate: true,
      isHistorical: true,
      operatedOpenedAt: true,
    },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const [
    preview,
    participations,
    settlements,
    purchases,
    tables,
    tips,
    review,
    progress,
  ] = await Promise.all([
    buildClosurePreview(prisma, sessionId),
    prisma.tableParticipation.findMany({
      where: { sessionId },
      select: {
        id: true,
        status: true,
        playerId: true,
        player: { select: { name: true } },
        sessionTable: {
          select: { tableId: true, table: { select: { name: true } } },
        },
      },
    }),
    prisma.playerSettlement.findMany({
      where: { sessionId },
      select: {
        id: true,
        status: true,
        exitKind: true,
        participationId: true,
        player: { select: { name: true } },
      },
    }),
    prisma.chipPurchase.findMany({
      where: { sessionId, status: { in: ["DRAFT", "READY_FOR_DELIVERY"] } },
      select: { id: true, folio: true, player: { select: { name: true } } },
    }),
    prisma.sessionTable.findMany({
      where: { sessionId, cycles: { some: {} } },
      select: { tableId: true },
    }),
    getSessionTips(sessionId),
    getTipsReviewState(prisma, sessionId),
    prisma.sessionClosureProgress.findUnique({ where: { sessionId } }),
  ])
  const live = session.status === "OPEN" || session.status === "CLOSING"
  const closing = session.status === "CLOSING"
  const noActivity = preview.precheck.kind === "NO_ACTIVITY"

  // ── Paso 1: jugadores ────────────────────────────────────────────────
  const players: WizardTask[] = []
  for (const p of participations.filter((x) => x.status === "ACTIVE"))
    players.push({
      code: "PLAYER_SETTLEMENT_MISSING",
      severity: "BLOCKING",
      title: `${p.player.name} sigue jugando`,
      detail: `${p.sessionTable.table.name}: liquida su cashout o registra OUT.`,
      entity: { type: "TableParticipation", id: p.id },
      href: `${S(sessionId)}/mesas/${p.sessionTable.tableId}`,
      actionLabel: "Liquidar jugador",
    })
  for (const s of settlements) {
    if (s.status === "DRAFT")
      players.push({
        code: "PLAYER_SIGNATURE_MISSING",
        severity: "BLOCKING",
        title: `${s.player.name}: falta la firma`,
        detail: "La liquidación está preparada; el jugador debe firmar.",
        entity: { type: "PlayerSettlement", id: s.id },
        href: `/dashboard/liquidaciones/${s.id}/firma`,
        actionLabel: "Capturar firma",
      })
    else if (s.status === "READY_FOR_CONFIRMATION")
      players.push({
        code: "PLAYER_RECEPTION_MISSING",
        severity: "BLOCKING",
        title: `${s.player.name}: falta confirmar la recepción`,
        detail: "Firmado; confirma las fichas recibidas (o el $0 del OUT).",
        entity: { type: "PlayerSettlement", id: s.id },
        href: `/dashboard/liquidaciones/${s.id}/firma`,
        actionLabel: "Confirmar recepción",
      })
  }
  for (const p of purchases)
    players.push({
      code: "PURCHASE_NOT_DELIVERED",
      severity: "BLOCKING",
      title: `Compra ${p.folio} de ${p.player.name} sin entregar`,
      detail: "Confírmala o cancélala antes de cerrar.",
      entity: { type: "ChipPurchase", id: p.id },
      href: `/dashboard/compras/${p.id}`,
      actionLabel: "Revisar compra",
    })
  const playerIds = new Set(participations.map((p) => p.playerId))
  const pendingPlayers = new Set(
    participations.filter((p) => p.status === "ACTIVE").map((p) => p.playerId)
  )
  const received = settlements.filter(
    (s) => s.status === "PENDING_PAYOUT" || s.status === "COMPLETED"
  )
  const playersInfo = {
    total: playerIds.size,
    finished: playerIds.size - pendingPlayers.size,
    pending: pendingPlayers.size,
    outs: received.filter((s) => s.exitKind === "OUT").length,
    cashouts: received.filter((s) => s.exitKind === "CASHOUT").length,
    awaitingPayout: settlements.filter((s) => s.status === "PENDING_PAYOUT")
      .length,
  }

  // ── Paso 2: mesas y rake ─────────────────────────────────────────────
  const rakeViews = await Promise.all(
    tables.map((t) => getTableRake(sessionId, t.tableId))
  )
  const tableTasks: WizardTask[] = []
  const tableInfo = rakeViews.map((v) => {
    const open = v.cycles.some((c) => c.status === "OPEN")
    const rakeHref = `${S(sessionId)}/mesas/${v.table.id}/rake`
    if (open)
      tableTasks.push({
        code: "TABLE_OPEN",
        severity: "BLOCKING",
        title: `${v.table.name} sigue abierta`,
        detail: "Ciérrala cuando no tenga jugadores activos.",
        entity: { type: "PokerTable", id: v.table.id },
        href: `${S(sessionId)}/mesas/${v.table.id}`,
        actionLabel: "Cerrar mesa",
      })
    for (const c of v.cycles) {
      if (c.rakeStatus === "COUNT_PENDING")
        tableTasks.push({
          code: "RAKE_COUNT_MISSING",
          severity: "BLOCKING",
          title: `${v.table.name} (ciclo #${c.cycleNumber}): falta contar el rake`,
          detail: "Cuenta el recipiente (si estaba vacío, confirma $0).",
          entity: { type: "SessionTableCycle", id: c.id },
          href: rakeHref,
          actionLabel: "Contar rake",
        })
      if (c.rakeStatus === "DIFFERENCE")
        tableTasks.push({
          code: "RAKE_DIFFERENCE",
          severity: "WARNING",
          title: `${v.table.name} (ciclo #${c.cycleNumber}): el conteo no coincide con lo registrado`,
          detail: `Diferencia $${c.difference}. Si fue un error de captura, corrígelo; si no, se conserva.`,
          entity: { type: "SessionTableCycle", id: c.id },
          href: rakeHref,
          actionLabel: "Revisar rake",
        })
    }
    return {
      tableId: v.table.id,
      name: v.table.name,
      mode: v.table.rakeMode,
      open,
      rake: v.totals.recognized,
      href: rakeHref,
      movements: v.cycles.reduce((a, c) => a + c.movementCount, 0),
    }
  })

  // ── Paso 3: propinas ─────────────────────────────────────────────────
  const tipTasks: WizardTask[] = []
  for (const s of tips.staff.filter((x) => x.state !== "CONFIRMED"))
    tipTasks.push({
      code: "STAFF_TIP_UNCONFIRMED",
      severity: "BLOCKING",
      title: `${s.staff.name}: falta confirmar su conteo`,
      detail:
        s.state === "DRAFT"
          ? "Tiene un borrador sin confirmar."
          : "Captura su importe (o $0).",
      entity: { type: "SessionStaff", id: s.id },
      href: null,
    })
  const tipsRequired = !noActivity || tips.staff.length > 0
  if (tipsRequired && !review.reviewed)
    tipTasks.push({
      code: "STAFF_TIPS_REVIEW_MISSING",
      severity: "BLOCKING",
      title: review.stale
        ? "Las propinas cambiaron: vuelve a confirmar que el conteo está completo"
        : "Confirma que el conteo del staff está completo",
      detail: "También si no hubo propinas ($0).",
      href: null,
    })

  // ── Paso 4: arqueo físico global ─────────────────────────────────────
  const inv = preview.inventory
  const countTasks: WizardTask[] = []
  if (!closing && live)
    countTasks.push({
      code: "CLOSING_NOT_STARTED",
      severity: "BLOCKING",
      title: "Inicia el cierre para contar las fichas",
      detail:
        "Requiere mesas cerradas y jugadores terminados. Al iniciar se bloquean compras, mesas y liquidaciones nuevas.",
      href: null,
    })
  else if (closing && !noActivity) {
    if (!inv.count || inv.count.status !== "CONFIRMED")
      countTasks.push({
        code: "CHIP_COUNT_MISSING",
        severity: "BLOCKING",
        title: "Falta el arqueo físico global de fichas",
        href: `${S(sessionId)}/cierre/inventario`,
        actionLabel: "Contar fichas",
      })
    else if (!inv.count.current)
      countTasks.push({
        code: "CHIP_COUNT_STALE",
        severity: "BLOCKING",
        title: "Hubo movimientos de fichas después del arqueo",
        detail:
          "Vuelve a contar (el arqueo anterior se conserva como evidencia).",
        href: `${S(sessionId)}/cierre/inventario`,
        actionLabel: "Volver a contar",
      })
    else if (
      inv.position.physicalDifference &&
      /[1-9]/.test(inv.position.physicalDifference) &&
      inv.count.reconciliationStatus === "PENDING"
    )
      countTasks.push({
        code: "CHIP_PHYSICAL_DIFFERENCE",
        severity: "WARNING",
        title: `Diferencia física: ${differenceText(inv.position.physicalDifference, "physical")!.text}`,
        detail:
          "Puedes recontar o documentarla en el paso 5 (no se crean ajustes).",
        href: `${S(sessionId)}/cierre/inventario`,
        actionLabel: "Revisar conteo",
      })
  }

  // ── Paso 5: conciliación y diferencias ───────────────────────────────
  const rec = inv.reconciliation
  const nominal =
    rec.status === "IN_PLAY" ? null : differenceText(rec.difference, "nominal")
  const physicalPending =
    !!inv.count?.current && inv.count.reconciliationStatus === "PENDING"
  const physical = physicalPending
    ? differenceText(inv.position.physicalDifference ?? "0", "physical")
    : null
  const recTasks: WizardTask[] = []
  if (rec.status === "IN_PLAY")
    recTasks.push({
      code: "PLAYERS_STILL_PLAYING",
      severity: "BLOCKING",
      title: "Hay jugadores con fichas en juego",
      detail: "La conciliación se calcula cuando todos terminan (paso 1).",
      href: null,
    })
  if (nominal && !noActivity) {
    const ok = (progress?.nominalReasonDraft ?? "").trim().length >= 5
    recTasks.push({
      code: ok ? "NOMINAL_DIFFERENCE_DOCUMENTED" : "NOMINAL_REASON_MISSING",
      severity: ok ? "WARNING" : "BLOCKING",
      title: `Diferencia nominal: ${nominal.text}`,
      detail: ok
        ? "Motivo registrado."
        : "Registra el motivo para poder cerrar.",
      href: null,
    })
  }
  if (physical && !noActivity) {
    const ok = (progress?.physicalReasonDraft ?? "").trim().length >= 5
    recTasks.push({
      code: ok ? "PHYSICAL_DIFFERENCE_DOCUMENTED" : "PHYSICAL_REASON_MISSING",
      severity: ok ? "WARNING" : "BLOCKING",
      title: `Diferencia física: ${physical.text}`,
      detail: ok
        ? "Motivo registrado."
        : "Registra el motivo para poder cerrar.",
      href: null,
    })
  }

  // ── Paso 6: confirmación (efectivo y requisitos restantes) ───────────
  const confirmTasks: WizardTask[] = []
  const check = (id: string) =>
    preview.readiness.checks.find((c) => c.id === id)
  if (closing) {
    if (!check("CASH_COUNT")?.ok)
      confirmTasks.push({
        code: "CASH_COUNT_MISSING",
        severity: "BLOCKING",
        title: "Falta el arqueo de efectivo del cierre",
        detail: `Esperado en caja: $${preview.cash.expected}.`,
        href: `${S(sessionId)}/cierre/caja`,
        actionLabel: "Contar efectivo",
      })
    else if (!check("CASH_UNCHANGED")?.ok)
      confirmTasks.push({
        code: "CASH_COUNT_STALE",
        severity: "BLOCKING",
        title: "El efectivo cambió después del arqueo",
        href: `${S(sessionId)}/cierre/caja`,
        actionLabel: "Volver a contar",
      })
    if (!check("CASH_DIFFERENCES")?.ok)
      confirmTasks.push({
        code: "CASH_DIFFERENCE_OPEN",
        severity: "BLOCKING",
        title: "Diferencia de efectivo sin resolver",
        href: `${S(sessionId)}/cierre/diferencias`,
        actionLabel: "Resolver diferencia",
      })
    if (!check("CASH_WITHDRAWN")?.ok)
      confirmTasks.push({
        code: "CASH_WITHDRAWAL_MISSING",
        severity: "BLOCKING",
        title: "Falta registrar el retiro final del efectivo",
        href: `${S(sessionId)}/cierre/retiro`,
        actionLabel: "Registrar retiro",
      })
    // Cualquier otro bloqueo real de la prevalidación (no duplicado).
    const covered = new Set([
      "OPEN_TABLES",
      "ACTIVE_PARTICIPANTS",
      "PURCHASES_PENDING_DELIVERY",
      "SETTLEMENTS_PENDING_RECEPTION",
      "RAKE_COUNT_PENDING",
      "STAFF_TIPS_UNCONFIRMED",
      "STAFF_TIPS_NOT_REVIEWED",
    ])
    for (const f of preview.precheck.findings.filter(
      (x) => x.severity === "BLOCKING" && !covered.has(x.code)
    ))
      confirmTasks.push({
        code: f.code,
        severity: "BLOCKING",
        title: f.title,
        detail: f.detail,
        href: `${S(sessionId)}/cierre/prevalidacion`,
        actionLabel: "Ver detalle",
      })
  }

  const defs: { id: WizardStepId; available: boolean; tasks: WizardTask[] }[] =
    [
      {
        id: "players",
        available: live || session.status === "CLOSED",
        tasks: players,
      },
      {
        id: "tables",
        available: live || session.status === "CLOSED",
        tasks: tableTasks,
      },
      {
        id: "tips",
        available: live || session.status === "CLOSED",
        tasks: tipTasks,
      },
      { id: "count", available: live, tasks: countTasks },
      {
        id: "reconciliation",
        available: closing || session.status === "CLOSED",
        tasks: recTasks,
      },
      { id: "confirm", available: closing, tasks: confirmTasks },
    ]
  const steps = defs.map((d, i) => {
    const meta = WIZARD_STEPS[i]
    return {
      number: i + 1,
      id: d.id,
      title: meta.title,
      hint: meta.hint,
      status:
        session.status === "CLOSED"
          ? ("COMPLETED" as const)
          : stepStatus({ available: d.available, tasks: d.tasks }),
      tasks: d.tasks,
      blocking: d.tasks.filter((t) => t.severity === "BLOCKING").length,
      warnings: d.tasks.filter((t) => t.severity === "WARNING").length,
    }
  })
  const statuses = steps.map((s) => s.status)
  const canConfirm =
    closing &&
    steps.every((s) => s.blocking === 0) &&
    preview.readiness.checks.every((c) => c.ok || c.id === "NO_ACTIVITY_REASON")
  return {
    session: {
      id: session.id,
      folio: session.folio,
      status: session.status,
      openedAt: session.openedAt?.toISOString() ?? null,
      businessDate: session.businessDate.toISOString().slice(0, 10),
      isHistorical: session.isHistorical,
      operatedOpenedAt: session.operatedOpenedAt?.toISOString() ?? null,
    },
    noActivity,
    progress: wizardProgress(statuses),
    currentStep: progress?.currentStep ?? firstOpenStep(statuses),
    suggestedStep: Math.min(firstOpenStep(statuses), 6),
    steps,
    players: playersInfo,
    tables: tableInfo,
    tips: {
      staff: tips.staff,
      total: tips.total,
      reviewed: review.reviewed,
      reviewedAt: review.reviewedAt,
      reviewedBy: review.reviewedBy,
    },
    count: inv.count
      ? {
          status: inv.count.status,
          current: inv.count.current,
          confirmedAt: inv.count.confirmedAt,
          confirmedBy: inv.count.confirmedBy?.name ?? null,
          expected: inv.position.expectedCustody,
          counted: inv.position.countedCustody,
          difference: inv.position.physicalDifference,
        }
      : null,
    reconciliation: {
      status: rec.status,
      delivered: rec.delivered,
      returnedByPlayers: rec.returnedByPlayers,
      rake: rec.rake,
      tips: rec.tips,
      otherReturns: rec.otherReturns,
      authorizedUnrecovered: rec.authorizedUnrecovered,
      nominalDifference: rec.difference,
      nominal,
      physical,
      nominalReasonDraft: progress?.nominalReasonDraft ?? "",
      physicalReasonDraft: progress?.physicalReasonDraft ?? "",
    },
    summary: {
      tablesUsed: preview.financial.tables.names,
      cashExpected: preview.cash.expected,
      cashCounted: preview.cash.count?.countedAmount ?? null,
      withdrawal: preview.cash.withdrawal
        ? {
            amount: preview.cash.withdrawal.amount,
            recipient: preview.cash.withdrawal.recipientName,
          }
        : null,
      debtsOutstanding: preview.financial.credits.outstanding,
      debtPlayers: preview.financial.credits.playersWithBalance,
      payablesPending: preview.financial.settlements.pendingAmount,
      payablePlayers: preview.financial.settlements.pendingPlayers,
    },
    previewHash: preview.previewHash,
    canConfirm,
  }
}
export type ClosureWizardView = Awaited<ReturnType<typeof getClosureWizard>>

/** Guarda el paso actual y los borradores de motivos (no cambia importes). */
export async function saveClosureWizardProgress(
  actor: SessionUser,
  sessionId: string,
  input: {
    currentStep?: number
    nominalReason?: string
    physicalReason?: string
  },
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "poker_sessions" WHERE "id" = ${sessionId} FOR SHARE`
    if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
    if (rows[0].status !== "OPEN" && rows[0].status !== "CLOSING")
      throw new BusinessRuleError(
        "La sesión no está abierta ni en cierre: su cierre ya no se edita."
      )
    const data = {
      ...(input.currentStep !== undefined && {
        currentStep: input.currentStep,
      }),
      ...(input.nominalReason !== undefined && {
        nominalReasonDraft: input.nominalReason.trim() || null,
      }),
      ...(input.physicalReason !== undefined && {
        physicalReasonDraft: input.physicalReason.trim() || null,
      }),
      updatedById: actor.id,
    }
    const saved = await tx.sessionClosureProgress.upsert({
      where: { sessionId },
      create: { sessionId, ...data },
      update: data,
      select: {
        currentStep: true,
        nominalReasonDraft: true,
        physicalReasonDraft: true,
      },
    })
    if (input.nominalReason !== undefined || input.physicalReason !== undefined)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CLOSURE_WIZARD_PROGRESS_SAVED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          metadata: {
            nominalReason: saved.nominalReasonDraft,
            physicalReason: saved.physicalReasonDraft,
          },
        },
        tx
      )
    return saved
  })
}
