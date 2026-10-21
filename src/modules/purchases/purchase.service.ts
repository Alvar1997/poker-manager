import "server-only"

import { randomUUID } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  cancelPendingBankTransferInTx,
  registerPendingBankTransferInTx,
} from "@/modules/cash/bank-transfer.service"
import {
  GLOBAL_SCOPE,
  lockAccountsInTx,
  postTransactionInTx,
} from "@/modules/cash/ledger"
import {
  InsufficientNominalError,
  readNominal,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import {
  confirmNominalChipDeliveryInTx,
  expireReservations,
  getAvailableNominalValue,
  releaseNominalReservationInTx,
  reserveNominalAmountInTx,
} from "@/modules/inventory/reservation.service"
import { assertPlayerSelectable } from "@/modules/players/player.rules"
import {
  assertPaymentFits,
  BLOCKER_MESSAGE,
  deliveryBlockers,
  effectiveAmount,
  nextPurchaseNumber,
  paymentEffect,
  summarizePayments,
  type PaymentLike,
  type PurchaseFinancials,
} from "@/modules/purchases/purchase.math"
import type {
  CancelPaymentInput,
  CardResultInput,
  ConfirmDeliveryInput,
  CreatePurchaseInput,
  CreditAuthorizationInput,
  PurchasesQuery,
  RecordPaymentInput,
  UpdateDraftInput,
} from "@/modules/purchases/purchase.schemas"
import {
  appliedByReceivable,
  receivableBalance,
} from "@/modules/credits/receivable.service"
import { createReceiptInTx } from "@/modules/signatures/receipt.service"
import { invalidatePurchaseSignaturesInTx } from "@/modules/signatures/signature-invalidation"
import {
  currentSignatureVerifier,
  SIGNATURE_MISSING_MESSAGE,
  SIGNATURE_STALE_MESSAGE,
  SIGNATURE_UNAVAILABLE_MESSAGE,
  summaryHash,
  type PurchaseSignatureVerifier,
  type SignableSummary,
} from "@/modules/purchases/signature-gateway"
import { validateParticipationForPurchase } from "@/modules/session-tables/participation.service"
import {
  lockOpenSession,
  lockSessionTable,
} from "@/modules/session-tables/session-table.service"
import { issueFolio } from "@/modules/settings/folio.service"

/**
 * Compras y recompras de fichas por IMPORTE NOMINAL (Módulo 08).
 *
 * Flujo: importe → pagos → saldo por cobrar → socio autorizador (si hay
 * crédito) → firma (si hay crédito, Módulo 09) → entrega física.
 *
 * - Sin denominaciones: el inventario se descuenta por valor nominal con
 *   los servicios del Módulo 04 (reserva → entrega UNA sola vez).
 * - El dinero vive en el libro de la Caja Central (Módulo 05): efectivo y
 *   tarjeta aprobada se contabilizan al confirmar la entrega, dentro de la
 *   MISMA transacción que la salida de fichas, la deuda y la numeración.
 *   Una transferencia se registra pendiente en el Módulo 05 y solo cuenta
 *   cuando alguien la verifica manualmente.
 * - Crédito = saldo por cobrar al entregar (importe − pagos confirmados):
 *   exige socio autorizador (registro operativo, no aprobación en línea) y
 *   firma auténtica. Genera una deuda (PlayerDebt) y un evento de outbox.
 * - Orden de bloqueos (sin interbloqueos): sesión (FOR SHARE) → compra →
 *   mesa → participación → inventario compartido → saldos financieros.
 */

export type Tx = Prisma.TransactionClient
export const PURCHASE_TX = { maxWait: 15_000, timeout: 30_000 } as const
const RESERVATION_TTL_MS = 15 * 60 * 1000

const user = { select: { id: true, name: true } } as const

const paymentSelect = {
  id: true,
  method: true,
  amount: true,
  status: true,
  terminalReference: true,
  terminalIdentifier: true,
  externalReference: true,
  bankTransferId: true,
  financialTransactionId: true,
  cardSettlementId: true,
  resolutionNotes: true,
  createdAt: true,
  resolvedAt: true,
  createdBy: user,
  resolvedBy: user,
  bankTransfer: {
    select: {
      id: true,
      status: true,
      confirmedAmount: true,
      bankReference: true,
      verifiedAt: true,
      verifiedBy: user,
    },
  },
  financialTransaction: { select: { id: true, folio: true } },
} satisfies Prisma.PurchasePaymentSelect

const authorizationSelect = {
  id: true,
  partnerNameSnapshot: true,
  authorizationChannel: true,
  authorizedCreditAmount: true,
  purchaseVersion: true,
  notes: true,
  status: true,
  recordedAt: true,
  authorizedByPartner: user,
  recordedBy: user,
} satisfies Prisma.PurchaseCreditAuthorizationSelect

const purchaseSelect = {
  id: true,
  folio: true,
  sessionId: true,
  sessionTableId: true,
  cycleId: true,
  participationId: true,
  playerId: true,
  tableId: true,
  nominalAmount: true,
  status: true,
  purchaseType: true,
  sequenceNumber: true,
  rebuyNumber: true,
  version: true,
  reservationId: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  confirmedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  session: { select: { id: true, folio: true, status: true } },
  table: { select: { id: true, name: true } },
  cycle: { select: { id: true, cycleNumber: true } },
  participation: { select: { id: true, status: true } },
  player: { select: { id: true, name: true, nickname: true, isActive: true } },
  createdBy: user,
  confirmedBy: user,
  cancelledBy: user,
  payments: { orderBy: { createdAt: "asc" }, select: paymentSelect },
  authorizations: {
    orderBy: { recordedAt: "desc" },
    select: authorizationSelect,
  },
  delivery: {
    select: {
      id: true,
      nominalAmount: true,
      inventoryOperationId: true,
      confirmedPayments: true,
      pendingTransfers: true,
      outstandingAmount: true,
      summaryVersion: true,
      signatureId: true,
      deliveredAt: true,
      deliveredBy: user,
    },
  },
  debt: { select: { id: true, originalAmount: true, createdAt: true } },
  reversalRequests: {
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      reason: true,
      status: true,
      requestedAt: true,
      requestedBy: user,
    },
  },
  signatures: {
    orderBy: { signedAt: "desc" },
    select: {
      id: true,
      status: true,
      signedAt: true,
      invalidatedAt: true,
      invalidationReason: true,
      capturedBy: user,
      invalidatedBy: user,
      snapshot: { select: { purchaseVersion: true, payloadHash: true } },
    },
  },
  receipt: { select: { id: true, status: true, createdAt: true } },
} satisfies Prisma.ChipPurchaseSelect

type PurchaseRecord = Prisma.ChipPurchaseGetPayload<{
  select: typeof purchaseSelect
}>
type PaymentRecord = PurchaseRecord["payments"][number]

const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const fmt = (v: Prisma.Decimal) => v.toFixed(2)

function toPaymentLike(p: {
  id: string
  method: PaymentRecord["method"]
  amount: Prisma.Decimal
  status: PaymentRecord["status"]
  bankTransfer: {
    status: NonNullable<PaymentRecord["bankTransfer"]>["status"]
    confirmedAmount: Prisma.Decimal | null
  } | null
}): PaymentLike {
  return {
    id: p.id,
    method: p.method,
    amount: dec(p.amount),
    status: p.status,
    transferStatus: p.bankTransfer?.status ?? null,
    transferConfirmedAmount: p.bankTransfer?.confirmedAmount
      ? dec(p.bankTransfer.confirmedAmount)
      : null,
  }
}

function financialsOf(p: {
  nominalAmount: Prisma.Decimal
  payments: Parameters<typeof toPaymentLike>[0][]
}): PurchaseFinancials {
  return summarizePayments(dec(p.nominalAmount), p.payments.map(toPaymentLike))
}

function activeAuthorization(p: PurchaseRecord) {
  return p.authorizations.find(
    (a) => a.status === "ACTIVE" && a.purchaseVersion === p.version
  )
}

function authorizationValid(p: PurchaseRecord, f: PurchaseFinancials) {
  const a = activeAuthorization(p)
  return Boolean(a && dec(a.authorizedCreditAmount).equals(f.outstanding))
}

/** Resumen exacto que el jugador acepta al firmar (Módulo 09). */
function signableSummary(
  p: PurchaseRecord,
  f: PurchaseFinancials
): SignableSummary {
  const a = activeAuthorization(p)
  return {
    purchaseId: p.id,
    folio: p.folio,
    playerId: p.player.id,
    playerName: p.player.name,
    sessionId: p.sessionId,
    tableName: p.table.name,
    nominalAmount: fmt(f.nominalAmount),
    confirmedPayments: p.payments
      .map(toPaymentLike)
      .filter((x) => paymentEffect(x) === "CONFIRMED")
      .map((x) => ({
        paymentId: x.id,
        method: x.method,
        amount: fmt(effectiveAmount(x)),
      })),
    pendingTransfers: p.payments
      .map(toPaymentLike)
      .filter(
        (x) => x.method === "BANK_TRANSFER" && paymentEffect(x) === "PENDING"
      )
      .map((x) => ({ paymentId: x.id, amount: fmt(x.amount) })),
    outstandingCredit: fmt(f.outstanding),
    partner: a
      ? {
          id: a.authorizedByPartner.id,
          name: a.partnerNameSnapshot,
          channel: a.authorizationChannel,
        }
      : null,
    operationDate: p.createdAt.toISOString(),
    version: p.version,
  }
}

function paymentView(p: PaymentRecord) {
  const like = toPaymentLike(p)
  return {
    id: p.id,
    method: p.method,
    amount: fmt(dec(p.amount)),
    status: p.status,
    /** Estado efectivo: CONFIRMED (cuenta como pago), PENDING o VOID. */
    effect: paymentEffect(like),
    terminalReference: p.terminalReference,
    terminalIdentifier: p.terminalIdentifier,
    externalReference: p.externalReference,
    bankTransfer: p.bankTransfer
      ? {
          id: p.bankTransfer.id,
          status: p.bankTransfer.status,
          confirmedAmount: p.bankTransfer.confirmedAmount
            ? fmt(dec(p.bankTransfer.confirmedAmount))
            : null,
          verifiedAt: p.bankTransfer.verifiedAt?.toISOString() ?? null,
          verifiedBy: p.bankTransfer.verifiedBy,
        }
      : null,
    financialTransaction: p.financialTransaction,
    settled: Boolean(p.cardSettlementId),
    resolutionNotes: p.resolutionNotes,
    createdAt: p.createdAt.toISOString(),
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
    createdBy: p.createdBy,
    resolvedBy: p.resolvedBy,
  }
}

function financialsView(f: PurchaseFinancials) {
  return {
    nominalAmount: fmt(f.nominalAmount),
    confirmedCash: fmt(f.confirmedCash),
    verifiedBankTransfers: fmt(f.verifiedBankTransfers),
    approvedCardDebit: fmt(f.approvedCardDebit),
    approvedCardCredit: fmt(f.approvedCardCredit),
    confirmedPayments: fmt(f.confirmedPayments),
    pendingTransfers: fmt(f.pendingTransfers),
    pendingCards: fmt(f.pendingCards),
    committedPayments: fmt(f.committedPayments),
    outstanding: fmt(f.outstanding),
    uncoveredCredit: fmt(f.uncoveredCredit),
    overApplied: f.overApplied,
  }
}

async function toView(
  p: PurchaseRecord,
  opts: { verifier?: PurchaseSignatureVerifier } = {}
) {
  const f = financialsOf(p)
  const editable = p.status === "DRAFT" || p.status === "READY_FOR_DELIVERY"
  const summary = signableSummary(p, f)
  const hash = summaryHash(summary)
  const verifier = opts.verifier ?? currentSignatureVerifier()
  const needsSignature = f.outstanding.greaterThan(0)
  const signature =
    editable && needsSignature
      ? await prisma.$transaction((tx) =>
          verifier.findValidSignature(tx, {
            purchaseId: p.id,
            playerId: p.playerId,
            summaryVersion: p.version,
            summaryHash: hash,
          })
        )
      : null
  const blockers = editable
    ? deliveryBlockers({
        editable,
        participationActive: p.participation.status === "ACTIVE",
        financials: f,
        creditAuthorizationValid: authorizationValid(p, f),
        signatureValid: Boolean(signature),
      })
    : []
  const auth = activeAuthorization(p)
  return {
    id: p.id,
    folio: p.folio,
    status: p.status,
    purchaseType: p.purchaseType,
    sequenceNumber: p.sequenceNumber,
    rebuyNumber: p.rebuyNumber,
    version: p.version,
    nominalAmount: fmt(dec(p.nominalAmount)),
    notes: p.notes,
    session: p.session,
    table: p.table,
    cycle: p.cycle,
    participation: p.participation,
    player: p.player,
    createdBy: p.createdBy,
    confirmedBy: p.confirmedBy,
    cancelledBy: p.cancelledBy,
    createdAt: p.createdAt.toISOString(),
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    cancellationReason: p.cancellationReason,
    /** El apartado sigue vigente (no vencido ni liberado). */
    reservationActive:
      p.status === "READY_FOR_DELIVERY" && p.reservationId
        ? (
            await prisma.chipReservation.findUnique({
              where: { id: p.reservationId },
              select: { status: true, expiresAt: true },
            })
          )?.status === "ACTIVE"
        : false,
    financials: financialsView(f),
    payments: p.payments.map(paymentView),
    creditAuthorization: auth
      ? {
          id: auth.id,
          partner: auth.authorizedByPartner,
          partnerName: auth.partnerNameSnapshot,
          channel: auth.authorizationChannel,
          amount: fmt(dec(auth.authorizedCreditAmount)),
          notes: auth.notes,
          recordedAt: auth.recordedAt.toISOString(),
          recordedBy: auth.recordedBy,
          validForCurrentAmount: dec(auth.authorizedCreditAmount).equals(
            f.outstanding
          ),
        }
      : null,
    authorizationHistory: p.authorizations.map((a) => ({
      id: a.id,
      partnerName: a.partnerNameSnapshot,
      channel: a.authorizationChannel,
      amount: fmt(dec(a.authorizedCreditAmount)),
      status: a.status,
      purchaseVersion: a.purchaseVersion,
      recordedAt: a.recordedAt.toISOString(),
      recordedBy: a.recordedBy,
    })),
    signature: {
      required: needsSignature,
      serviceAvailable: verifier.available,
      present: Boolean(signature) || Boolean(p.delivery?.signatureId),
      signatureId: p.delivery?.signatureId ?? signature?.signatureId ?? null,
    },
    delivery: p.delivery
      ? {
          ...p.delivery,
          nominalAmount: fmt(dec(p.delivery.nominalAmount)),
          confirmedPayments: fmt(dec(p.delivery.confirmedPayments)),
          pendingTransfers: fmt(dec(p.delivery.pendingTransfers)),
          outstandingAmount: fmt(dec(p.delivery.outstandingAmount)),
          deliveredAt: p.delivery.deliveredAt.toISOString(),
        }
      : null,
    debt: p.debt
      ? {
          id: p.debt.id,
          originalAmount: fmt(dec(p.debt.originalAmount)),
          /** Derivado del libro de aplicaciones (Módulo 10): original − aplicaciones. */
          currentBalance: fmt(
            (await receivableBalance(prisma, p.debt.id)).balance
          ),
          createdAt: p.debt.createdAt.toISOString(),
        }
      : null,
    reversalRequests: p.reversalRequests.map((r) => ({
      ...r,
      requestedAt: r.requestedAt.toISOString(),
    })),
    blockers: blockers.map((code) => ({
      code,
      message:
        code === "CREDIT_SIGNATURE_REQUIRED" && !verifier.available
          ? SIGNATURE_UNAVAILABLE_MESSAGE
          : BLOCKER_MESSAGE[code],
    })),
    summary,
    summaryHash: hash,
    /** Historial de firmas (las invalidadas se conservan como evidencia). */
    signatures: p.signatures.map((x) => ({
      id: x.id,
      status: x.status,
      signedAt: x.signedAt.toISOString(),
      invalidatedAt: x.invalidatedAt?.toISOString() ?? null,
      invalidationReason: x.invalidationReason,
      capturedBy: x.capturedBy,
      invalidatedBy: x.invalidatedBy,
      purchaseVersion: x.snapshot.purchaseVersion,
      snapshotHash: x.snapshot.payloadHash,
    })),
    receipt: p.receipt
      ? {
          id: p.receipt.id,
          status: p.receipt.status,
          createdAt: p.receipt.createdAt.toISOString(),
        }
      : null,
  }
}
export type PurchaseView = Awaited<ReturnType<typeof toView>>

// ── Bloqueos y utilidades de transacción ──────────────────────────────

async function lockPurchase(tx: Tx, id: string): Promise<PurchaseRecord> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "chip_purchases" WHERE "id" = ${id} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Compra no encontrada")
  return tx.chipPurchase.findUniqueOrThrow({
    where: { id },
    select: purchaseSelect,
  })
}

async function purchaseHead(id: string) {
  const head = await prisma.chipPurchase.findUnique({
    where: { id },
    select: { id: true, sessionId: true },
  })
  if (!head) throw new NotFoundError("Compra no encontrada")
  return head
}

function assertEditable(p: { status: string }) {
  if (p.status === "CONFIRMED")
    throw new BusinessRuleError(
      "La compra ya fue confirmada: no se edita (usa la solicitud de reverso)."
    )
  if (p.status !== "DRAFT" && p.status !== "READY_FOR_DELIVERY")
    throw new BusinessRuleError("La compra ya no está en preparación.")
}

async function recordStatus(
  tx: Tx,
  purchaseId: string,
  from: PurchaseRecord["status"] | null,
  to: PurchaseRecord["status"],
  actorId: string,
  reason?: string | null
) {
  await tx.purchaseStatusHistory.create({
    data: {
      purchaseId,
      fromStatus: from,
      toStatus: to,
      changedById: actorId,
      changedAt: new Date(),
      reason: reason ?? null,
    },
  })
}

/**
 * Cambio MATERIAL (importe, pagos, autorización): nueva versión del resumen.
 * La autorización vigente queda reemplazada y la firma VALID se invalida
 * con motivo y responsable (se conserva como evidencia, Módulo 09).
 */
export async function bumpPurchaseVersionInTx(
  tx: Tx,
  purchase: { id: string; version: number },
  change: { actorId: string; reason: string; requestId?: string | null },
  extra: Prisma.ChipPurchaseUpdateManyMutationInput = {}
): Promise<number> {
  await invalidatePurchaseSignaturesInTx(
    tx,
    { purchaseId: purchase.id, actorId: change.actorId, reason: change.reason },
    { requestId: change.requestId }
  )
  await tx.purchaseCreditAuthorization.updateMany({
    where: { purchaseId: purchase.id, status: "ACTIVE" },
    data: { status: "SUPERSEDED" },
  })
  const { count } = await tx.chipPurchase.updateMany({
    where: { id: purchase.id, version: purchase.version },
    data: { ...extra, version: { increment: 1 } },
  })
  if (count !== 1)
    throw new ConflictError("La compra cambió mientras se editaba")
  return purchase.version + 1
}

async function lockOpenSessionFor(tx: Tx, sessionId: string, action: string) {
  return lockOpenSession(
    tx,
    sessionId,
    `La sesión debe estar abierta para ${action}.`
  )
}

function money(value: string) {
  return dec(value).toDecimalPlaces(2)
}

// ── Consultas ─────────────────────────────────────────────────────────

export async function getPurchase(
  id: string,
  opts: { verifier?: PurchaseSignatureVerifier } = {}
) {
  const p = await prisma.chipPurchase.findUnique({
    where: { id },
    select: purchaseSelect,
  })
  if (!p) throw new NotFoundError("Compra no encontrada")
  return toView(p, opts)
}

/** Resumen firmable (versión + huella) para el Módulo 09. */
export async function getPurchaseSummary(id: string) {
  const view = await getPurchase(id)
  return {
    purchaseId: view.id,
    status: view.status,
    version: view.version,
    summary: view.summary,
    summaryHash: view.summaryHash,
    financials: view.financials,
    signature: view.signature,
    blockers: view.blockers,
  }
}

export async function getPurchaseHistory(id: string) {
  await purchaseHead(id)
  const [statuses, audit] = await Promise.all([
    prisma.purchaseStatusHistory.findMany({
      where: { purchaseId: id },
      orderBy: { changedAt: "asc" },
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        changedAt: true,
        reason: true,
        changedBy: user,
      },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "ChipPurchase", entityId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        action: true,
        createdAt: true,
        metadata: true,
        actor: user,
      },
    }),
  ])
  return {
    statuses: statuses.map((s) => ({
      ...s,
      changedAt: s.changedAt.toISOString(),
    })),
    events: audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  }
}

const listSelect = {
  id: true,
  folio: true,
  status: true,
  purchaseType: true,
  sequenceNumber: true,
  rebuyNumber: true,
  nominalAmount: true,
  createdAt: true,
  confirmedAt: true,
  sessionId: true,
  session: { select: { folio: true } },
  table: { select: { id: true, name: true } },
  player: { select: { id: true, name: true, nickname: true } },
  createdBy: user,
  confirmedBy: user,
  delivery: { select: { signatureId: true, deliveredAt: true } },
  debt: { select: { id: true, originalAmount: true } },
  authorizations: {
    where: { status: { in: ["ACTIVE", "USED"] } },
    orderBy: { recordedAt: "desc" },
    take: 1,
    select: { partnerNameSnapshot: true, authorizationChannel: true },
  },
  payments: {
    select: {
      id: true,
      method: true,
      amount: true,
      status: true,
      bankTransfer: { select: { status: true, confirmedAmount: true } },
    },
  },
} satisfies Prisma.ChipPurchaseSelect

function monterreyDayStart(date: string) {
  // America/Monterrey: UTC−6 (sin horario de verano desde 2022).
  return new Date(`${date}T06:00:00.000Z`)
}

export async function listPurchases(query: PurchasesQuery) {
  const where: Prisma.ChipPurchaseWhereInput = {
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.tableId ? { tableId: query.tableId } : {}),
    ...(query.playerId ? { playerId: query.playerId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.purchaseType ? { purchaseType: query.purchaseType } : {}),
    ...(query.cashierId
      ? {
          OR: [
            { createdById: query.cashierId },
            { confirmedById: query.cashierId },
          ],
        }
      : {}),
    ...(query.partnerId
      ? {
          authorizations: {
            some: {
              authorizedByPartnerId: query.partnerId,
              status: { in: ["ACTIVE", "USED"] },
            },
          },
        }
      : {}),
    ...(query.method
      ? {
          payments: {
            some: {
              method: query.method,
              status: { notIn: ["DECLINED", "VOIDED", "CANCELLED"] },
            },
          },
        }
      : {}),
    ...(query.withCredit === true ? { debt: { isNot: null } } : {}),
    ...(query.withCredit === false
      ? { status: "CONFIRMED" as const, debt: { is: null } }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: monterreyDayStart(query.from) } : {}),
            ...(query.to
              ? {
                  lt: new Date(
                    monterreyDayStart(query.to).getTime() + 86_400_000
                  ),
                }
              : {}),
          },
        }
      : {}),
  }
  const [total, rows] = await prisma.$transaction([
    prisma.chipPurchase.count({ where }),
    prisma.chipPurchase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: listSelect,
    }),
  ])
  // Compras entregadas con crédito: el saldo es el de su deuda (Módulo 10).
  const debtApplied = await appliedByReceivable(
    prisma,
    rows.flatMap((r) => (r.debt ? [r.debt.id] : []))
  )
  return {
    items: rows.map((p) => {
      const f = summarizePayments(
        dec(p.nominalAmount),
        p.payments.map(toPaymentLike)
      )
      const methods = [
        ...new Set(
          p.payments
            .filter(
              (x) => !["DECLINED", "VOIDED", "CANCELLED"].includes(x.status)
            )
            .map((x) => x.method)
        ),
      ]
      return {
        id: p.id,
        folio: p.folio,
        status: p.status,
        purchaseType: p.purchaseType,
        sequenceNumber: p.sequenceNumber,
        rebuyNumber: p.rebuyNumber,
        nominalAmount: fmt(dec(p.nominalAmount)),
        confirmedPayments: fmt(f.confirmedPayments),
        pendingTransfers: fmt(f.pendingTransfers),
        outstanding: p.debt
          ? fmt(
              dec(p.debt.originalAmount).sub(
                debtApplied.get(p.debt.id) ?? dec(0)
              )
            )
          : fmt(f.outstanding),
        methods,
        partnerName: p.authorizations[0]?.partnerNameSnapshot ?? null,
        signature: p.delivery?.signatureId
          ? "SIGNED"
          : p.debt || f.outstanding.greaterThan(0)
            ? "REQUIRED"
            : "NOT_REQUIRED",
        delivered: Boolean(p.delivery),
        hadCredit: Boolean(p.debt),
        session: { id: p.sessionId, folio: p.session.folio },
        table: p.table,
        player: p.player,
        createdBy: p.createdBy,
        confirmedBy: p.confirmedBy,
        createdAt: p.createdAt.toISOString(),
        confirmedAt: p.confirmedAt?.toISOString() ?? null,
      }
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}
export type PurchaseListItem = Awaited<
  ReturnType<typeof listPurchases>
>["items"][number]

/** Socios ACTIVOS que pueden figurar como autorizadores de crédito (AUTH-03). */
export async function listCreditAuthorizers() {
  return prisma.user.findMany({
    where: { role: "PARTNER", isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })
}

/** Disponibilidad nominal del inventario compartido (para el formulario). */
export async function getPurchaseAvailability() {
  const n = await getAvailableNominalValue()
  return { available: n.available, breakdownExact: n.breakdownExact }
}

// ── Crear borrador ────────────────────────────────────────────────────

/**
 * Crea el borrador con el IMPORTE solicitado. No descuenta inventario ni
 * registra dinero: solo valida sesión, mesa, ciclo, participación activa,
 * jugador activo y que el valor nominal disponible alcance.
 */
export async function createPurchase(
  actor: SessionUser,
  input: CreatePurchaseInput,
  ctx: RequestContext = {}
) {
  const amount = money(input.nominalAmount)
  const replay = () =>
    prisma.chipPurchase.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, participationId: true, nominalAmount: true },
    })
  const sameRequest = (r: {
    participationId: string
    nominalAmount: Prisma.Decimal
  }) =>
    r.participationId === input.participationId &&
    dec(r.nominalAmount).equals(amount)
  const previous = await replay()
  if (previous) {
    if (!sameRequest(previous))
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra compra"
      )
    return { purchaseId: previous.id, replayed: true }
  }
  // Sin cron: los apartados vencidos se liberan antes de validar disponibilidad.
  await expireReservations()
  const participation = await prisma.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: { sessionId: true, sessionTableId: true },
  })
  if (!participation) throw new NotFoundError("Participación no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOpenSessionFor(tx, participation.sessionId, "registrar compras")
      const table = await lockSessionTable(tx, participation.sessionTableId)
      const again = await tx.chipPurchase.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { purchaseId: again.id, replayed: true }
      const ctxp = await validateParticipationForPurchase(
        tx,
        input.participationId
      )
      if (!table.cycles[0] || table.cycles[0].id !== ctxp.cycleId)
        throw new BusinessRuleError("La mesa debe estar abierta.")
      const player = await tx.player.findUniqueOrThrow({
        where: { id: ctxp.playerId },
        select: { id: true, name: true, isActive: true },
      })
      assertPlayerSelectable(player)
      const nominal = await readNominal(tx, await sharedChipSetId(tx))
      if (nominal.available.lessThan(amount))
        throw new InsufficientNominalError(nominal.available, amount)
      const folio = await issueFolio(tx, "PURCHASE")
      const created = await tx.chipPurchase.create({
        data: {
          folio,
          sessionId: ctxp.sessionId,
          sessionTableId: ctxp.sessionTableId,
          cycleId: ctxp.cycleId,
          participationId: ctxp.participationId,
          playerId: ctxp.playerId,
          tableId: ctxp.tableId,
          nominalAmount: amount,
          notes: input.notes ?? null,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordStatus(tx, created.id, null, "DRAFT", actor.id)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PURCHASE_DRAFT_CREATED,
          entityType: "ChipPurchase",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio,
            nominalAmount: fmt(amount),
            sessionId: ctxp.sessionId,
            table: table.table.name,
            tableId: ctxp.tableId,
            playerId: ctxp.playerId,
            participationId: ctxp.participationId,
          },
        },
        tx
      )
      return { purchaseId: created.id, replayed: false }
    }, PURCHASE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again && sameRequest(again))
        return { purchaseId: again.id, replayed: true }
    }
    throw error
  }
}

/** Cambia el importe o las notas de un borrador. Un nuevo importe es cambio material. */
export async function updateDraft(
  actor: SessionUser,
  id: string,
  input: UpdateDraftInput,
  ctx: RequestContext = {}
) {
  const head = await purchaseHead(id)
  await prisma.$transaction(async (tx) => {
    await lockOpenSessionFor(tx, head.sessionId, "editar compras")
    const p = await lockPurchase(tx, id)
    assertEditable(p)
    if (p.version !== input.expectedVersion)
      throw new ConflictError(
        "La compra cambió desde que la abriste. Revisa el resumen actualizado."
      )
    const amountChanged =
      input.nominalAmount !== undefined &&
      !money(input.nominalAmount).equals(dec(p.nominalAmount))
    if (!amountChanged) {
      if (input.notes !== undefined) {
        await tx.chipPurchase.update({
          where: { id },
          data: { notes: input.notes },
        })
      }
      return
    }
    const amount = money(input.nominalAmount!)
    const f = financialsOf(p)
    if (f.committedPayments.greaterThan(amount))
      throw new BusinessRuleError(
        `Los pagos registrados ($${fmt(f.committedPayments)}) exceden el nuevo importe. Cancela o ajusta pagos primero.`
      )
    const nominal = await readNominal(tx, await sharedChipSetId(tx))
    const reserved =
      p.status === "READY_FOR_DELIVERY" ? dec(p.nominalAmount) : dec(0)
    if (nominal.available.add(reserved).lessThan(amount))
      throw new InsufficientNominalError(
        nominal.available.add(reserved),
        amount
      )
    // Un nuevo importe libera el apartado anterior: se vuelve a preparar.
    if (p.status === "READY_FOR_DELIVERY" && p.reservationId) {
      await releaseNominalReservationInTx(tx, actor, p.reservationId, ctx)
      await recordStatus(
        tx,
        id,
        "READY_FOR_DELIVERY",
        "DRAFT",
        actor.id,
        "Cambio de importe"
      )
    }
    await bumpPurchaseVersionInTx(
      tx,
      p,
      {
        actorId: actor.id,
        reason: `Cambio de importe: $${fmt(dec(p.nominalAmount))} → $${fmt(amount)}`,
        requestId: ctx.requestId,
      },
      {
        nominalAmount: amount,
        status: "DRAFT",
        reservationId: null,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      }
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_DRAFT_UPDATED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          from: fmt(dec(p.nominalAmount)),
          to: fmt(amount),
          version: p.version + 1,
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return getPurchase(id)
}

// ── Pagos ─────────────────────────────────────────────────────────────

const METHOD_LABEL: Record<RecordPaymentInput["method"], string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
  CARD_CREDIT: "Tarjeta de crédito",
}

/**
 * Registra un componente de pago. Efectivo: el cajero declara que lo
 * recibió (se contabiliza al entregar). Transferencia: queda PENDIENTE de
 * verificación en el Módulo 05 (no es cobro). Tarjeta: resultado de la
 * terminal; solo APROBADA cuenta y nunca se guardan datos de la tarjeta.
 */
export async function recordPayment(
  actor: SessionUser,
  id: string,
  input: RecordPaymentInput,
  ctx: RequestContext = {}
) {
  const head = await purchaseHead(id)
  const amount = money(input.amount)
  const replay = await prisma.purchasePayment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, purchaseId: true, method: true, amount: true },
  })
  if (replay) {
    if (
      replay.purchaseId !== id ||
      replay.method !== input.method ||
      !dec(replay.amount).equals(amount)
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro pago"
      )
    return { purchase: await getPurchase(id), replayed: true }
  }
  await prisma.$transaction(async (tx) => {
    await lockOpenSessionFor(tx, head.sessionId, "registrar pagos")
    const p = await lockPurchase(tx, id)
    const again = await tx.purchasePayment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    })
    if (again) return
    assertEditable(p)
    const method = await tx.paymentMethod.findUnique({
      where: { code: input.method },
      select: { isActive: true },
    })
    if (!method?.isActive)
      throw new BusinessRuleError(
        `El método ${METHOD_LABEL[input.method]} no está activo en la configuración.`
      )
    const declined =
      (input.method === "CARD_DEBIT" || input.method === "CARD_CREDIT") &&
      input.result === "DECLINED"
    if (!declined) {
      try {
        assertPaymentFits(financialsOf(p), amount)
      } catch (e) {
        throw new BusinessRuleError(
          e instanceof Error ? e.message : "Pago inválido"
        )
      }
    }
    const paymentId = randomUUID()
    let bankTransferId: string | null = null
    if (input.method === "BANK_TRANSFER") {
      const pending = await registerPendingBankTransferInTx(
        tx,
        actor,
        {
          declaredAmount: amount,
          creditAccountKind: "PLAYER_PURCHASES",
          referenceType: "PurchasePayment",
          referenceId: paymentId,
          sessionId: p.sessionId,
          tableId: p.tableId,
          playerId: p.playerId,
          bankReference: input.bankReference ?? null,
          senderName: input.senderName ?? null,
          idempotencyKey: `purchase-transfer-${input.idempotencyKey}`,
        },
        ctx
      )
      bankTransferId = pending.id
    }
    const isCard =
      input.method === "CARD_DEBIT" || input.method === "CARD_CREDIT"
    const status =
      input.method === "CASH"
        ? "CONFIRMED"
        : input.method === "BANK_TRANSFER"
          ? "PENDING"
          : input.result
    const now = new Date()
    await tx.purchasePayment.create({
      data: {
        id: paymentId,
        purchaseId: id,
        method: input.method,
        amount,
        status,
        terminalReference: isCard ? (input.terminalReference ?? null) : null,
        terminalIdentifier: isCard ? (input.terminalIdentifier ?? null) : null,
        externalReference:
          input.method === "BANK_TRANSFER"
            ? (input.bankReference ?? null)
            : null,
        bankTransferId,
        createdById: actor.id,
        createdAt: now,
        ...(status === "APPROVED" ||
        status === "DECLINED" ||
        status === "CONFIRMED"
          ? { resolvedById: actor.id, resolvedAt: now }
          : {}),
        idempotencyKey: input.idempotencyKey,
      },
    })
    const version = declined
      ? p.version
      : await bumpPurchaseVersionInTx(tx, p, {
          actorId: actor.id,
          reason: `Nuevo pago registrado (${METHOD_LABEL[input.method]} $${fmt(amount)})`,
          requestId: ctx.requestId,
        })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_PAYMENT_RECORDED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          paymentId,
          method: input.method,
          amount: fmt(amount),
          status,
          terminalReference: isCard ? (input.terminalReference ?? null) : null,
          bankTransferId,
          version,
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return { purchase: await getPurchase(id), replayed: false }
}

/** Resultado de la terminal: PENDING → APPROVED/DECLINED; APPROVED → VOIDED (antes de entregar). */
export async function resolveCardPayment(
  actor: SessionUser,
  id: string,
  paymentId: string,
  input: CardResultInput,
  ctx: RequestContext = {}
) {
  const head = await purchaseHead(id)
  await prisma.$transaction(async (tx) => {
    await lockOpenSessionFor(tx, head.sessionId, "registrar pagos")
    const p = await lockPurchase(tx, id)
    const payment = p.payments.find((x) => x.id === paymentId)
    if (!payment) throw new NotFoundError("Pago no encontrado en esta compra")
    if (payment.method !== "CARD_DEBIT" && payment.method !== "CARD_CREDIT")
      throw new BusinessRuleError("Este pago no es un cobro con terminal")
    if (payment.status === input.result) return // reintento
    assertEditable(p)
    const allowed =
      (payment.status === "PENDING" &&
        (input.result === "APPROVED" || input.result === "DECLINED")) ||
      (payment.status === "APPROVED" && input.result === "VOIDED")
    if (!allowed)
      throw new BusinessRuleError(
        `No se puede pasar un cobro ${payment.status} a ${input.result}.`
      )
    const { count } = await tx.purchasePayment.updateMany({
      where: { id: paymentId, status: payment.status },
      data: {
        status: input.result,
        ...(input.result === "APPROVED"
          ? { terminalReference: input.terminalReference }
          : {}),
        resolutionNotes: input.reason ?? null,
        resolvedById: actor.id,
        resolvedAt: new Date(),
      },
    })
    if (count !== 1) throw new ConflictError("El pago cambió de estado")
    const version = await bumpPurchaseVersionInTx(tx, p, {
      actorId: actor.id,
      reason: `Cobro con terminal: ${payment.status} → ${input.result}`,
      requestId: ctx.requestId,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_PAYMENT_RESOLVED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          paymentId,
          method: payment.method,
          amount: fmt(dec(payment.amount)),
          from: payment.status,
          to: input.result,
          reason: input.reason ?? null,
          version,
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return getPurchase(id)
}

/**
 * Retira un componente antes de entregar. Efectivo: exige declarar que se
 * devolvió el dinero. Transferencia pendiente: se cancela en el Módulo 05.
 * Una transferencia ya verificada NO se descarta (requiere resolución
 * financiera explícita, fuera de este módulo).
 */
export async function cancelPayment(
  actor: SessionUser,
  id: string,
  paymentId: string,
  input: CancelPaymentInput,
  ctx: RequestContext = {}
) {
  await purchaseHead(id)
  await prisma.$transaction(async (tx) => {
    const p = await lockPurchase(tx, id)
    const payment = p.payments.find((x) => x.id === paymentId)
    if (!payment) throw new NotFoundError("Pago no encontrado en esta compra")
    if (payment.status === "CANCELLED") return
    assertEditable(p)
    if (payment.method === "CARD_DEBIT" || payment.method === "CARD_CREDIT")
      throw new BusinessRuleError(
        "Un cobro con terminal se anula o se marca rechazado; no se cancela."
      )
    if (payment.method === "CASH") {
      if (input.cashReturned !== true)
        throw new BusinessRuleError(
          "Confirma que devolviste el efectivo al jugador antes de retirarlo de la compra."
        )
    } else {
      const t = payment.bankTransfer
      if (t?.status === "CONFIRMED")
        throw new BusinessRuleError(
          "La transferencia ya fue verificada en el banco: no se descarta. Requiere una devolución o resolución financiera explícita."
        )
      if (t?.status === "PENDING_VERIFICATION")
        await cancelPendingBankTransferInTx(tx, actor, t.id, ctx)
    }
    const { count } = await tx.purchasePayment.updateMany({
      where: { id: paymentId, status: payment.status },
      data: {
        status: "CANCELLED",
        resolutionNotes: input.reason,
        resolvedById: actor.id,
        resolvedAt: new Date(),
      },
    })
    if (count !== 1) throw new ConflictError("El pago cambió de estado")
    const version = await bumpPurchaseVersionInTx(tx, p, {
      actorId: actor.id,
      reason: `Pago retirado (${payment.method} $${fmt(dec(payment.amount))})`,
      requestId: ctx.requestId,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_PAYMENT_CANCELLED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          paymentId,
          method: payment.method,
          amount: fmt(dec(payment.amount)),
          reason: input.reason,
          cashReturned: payment.method === "CASH" ? true : null,
          version,
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return getPurchase(id)
}

// ── Crédito: socio autorizador ────────────────────────────────────────

/**
 * Registra QUÉ SOCIO autorizó el crédito (verbal o por mensaje). Es un
 * registro operativo capturado por el cajero, no una aprobación en línea:
 * no se envía nada al socio. El importe lo calcula el servidor (saldo por
 * cobrar actual). Cambiar de socio o de importe crea otra versión.
 */
export async function recordCreditAuthorization(
  actor: SessionUser,
  id: string,
  input: CreditAuthorizationInput,
  ctx: RequestContext = {}
) {
  const head = await purchaseHead(id)
  const replay = await prisma.purchaseCreditAuthorization.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { purchaseId: true, authorizedByPartnerId: true },
  })
  if (replay) {
    if (
      replay.purchaseId !== id ||
      replay.authorizedByPartnerId !== input.partnerId
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra autorización"
      )
    return { purchase: await getPurchase(id), replayed: true }
  }
  await prisma.$transaction(async (tx) => {
    await lockOpenSessionFor(tx, head.sessionId, "registrar créditos")
    const p = await lockPurchase(tx, id)
    const again = await tx.purchaseCreditAuthorization.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    })
    if (again) return
    assertEditable(p)
    const f = financialsOf(p)
    if (!f.outstanding.greaterThan(0))
      throw new BusinessRuleError(
        "La compra no tiene saldo por cobrar: no requiere autorización de crédito."
      )
    const partner = await tx.user.findUnique({
      where: { id: input.partnerId },
      select: { id: true, name: true, role: true, isActive: true },
    })
    if (!partner || partner.role !== "PARTNER" || !partner.isActive)
      throw new BusinessRuleError(
        "Selecciona un socio activo: solo un socio puede autorizar créditos."
      )
    const version = await bumpPurchaseVersionInTx(tx, p, {
      actorId: actor.id,
      reason: "Nueva autorización de crédito (socio o importe)",
      requestId: ctx.requestId,
    })
    const created = await tx.purchaseCreditAuthorization.create({
      data: {
        purchaseId: id,
        authorizedByPartnerId: partner.id,
        partnerNameSnapshot: partner.name,
        authorizationChannel: input.channel,
        authorizedCreditAmount: f.outstanding,
        purchaseVersion: version,
        notes: input.notes ?? null,
        recordedById: actor.id,
        recordedAt: new Date(),
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_CREDIT_AUTH_RECORDED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          creditRecordId: created.id,
          partnerId: partner.id,
          partnerName: partner.name,
          channel: input.channel,
          creditAmount: fmt(f.outstanding),
          pendingTransfers: fmt(f.pendingTransfers),
          version,
          note: "Registro operativo del cajero; el socio no aprobó en línea.",
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return { purchase: await getPurchase(id), replayed: false }
}

// ── Preparar entrega (reserva nominal) ────────────────────────────────

/** Aparta el importe en el inventario compartido (reserva con vencimiento). */
export async function prepareDelivery(
  actor: SessionUser,
  id: string,
  input: { idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await purchaseHead(id)
  await expireReservations()
  await prisma.$transaction(async (tx) => {
    await lockOpenSessionFor(tx, head.sessionId, "entregar fichas")
    const p = await lockPurchase(tx, id)
    assertEditable(p)
    if (p.status === "READY_FOR_DELIVERY" && p.reservationId) {
      const r = await tx.chipReservation.findUnique({
        where: { id: p.reservationId },
        select: { status: true },
      })
      if (r?.status === "ACTIVE") return // ya apartado
    }
    await validateParticipationForPurchase(tx, p.participationId, p.playerId)
    const reservation = await reserveNominalAmountInTx(
      tx,
      actor,
      {
        amount: dec(p.nominalAmount),
        referenceType: "ChipPurchase",
        referenceId: p.id,
        tableId: p.tableId,
        sessionId: p.sessionId,
        playerId: p.playerId,
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        idempotencyKey: `purchase-reserve-${input.idempotencyKey}`,
      },
      ctx
    )
    await tx.chipPurchase.update({
      where: { id },
      data: { status: "READY_FOR_DELIVERY", reservationId: reservation.id },
    })
    if (p.status !== "READY_FOR_DELIVERY")
      await recordStatus(tx, id, p.status, "READY_FOR_DELIVERY", actor.id)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_DELIVERY_PREPARED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          reservationId: reservation.id,
          amount: fmt(dec(p.nominalAmount)),
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return getPurchase(id)
}

// ── Confirmar entrega (transacción única) ─────────────────────────────

type ConfirmDeps = { signatures?: PurchaseSignatureVerifier }

/**
 * Confirma la entrega física en UNA transacción:
 *   revalida sesión/mesa/ciclo/participación/jugador → saldo por cobrar →
 *   socio autorizador y firma si hay crédito → numeración → salida nominal
 *   (una sola vez) → asientos de efectivo y terminal → entrega → deuda →
 *   evento de notificación → CONFIRMED → auditoría.
 * Si algo falla, no queda nada a medias. Reintentos con la misma clave
 * devuelven la misma compra.
 */
export async function confirmDelivery(
  actor: SessionUser,
  id: string,
  input: ConfirmDeliveryInput,
  ctx: RequestContext = {},
  deps: ConfirmDeps = {}
) {
  const verifier = deps.signatures ?? currentSignatureVerifier()
  const head = await purchaseHead(id)
  const replay = async () => {
    const d = await prisma.purchaseDelivery.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { purchaseId: true },
    })
    if (d && d.purchaseId !== id)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra entrega"
      )
    return d
  }
  if (await replay())
    return { purchase: await getPurchase(id, { verifier }), replayed: true }
  try {
    const replayed = await prisma.$transaction(async (tx) => {
      await lockOpenSessionFor(tx, head.sessionId, "entregar fichas")
      const p = await lockPurchase(tx, id)
      if (p.status === "CONFIRMED") {
        const same = await tx.purchaseDelivery.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        })
        if (same) return true
        throw new ConflictError("La compra ya fue confirmada.")
      }
      assertEditable(p)
      if (p.version !== input.expectedVersion)
        throw new ConflictError(
          "La compra cambió desde que revisaste el resumen. Revísalo de nuevo antes de entregar."
        )

      // Mesa y participación vigentes (bloqueadas: un cambio de mesa o un
      // cierre simultáneo espera a esta entrega, o esta ve su resultado).
      const table = await lockSessionTable(tx, p.sessionTableId)
      if (table.status !== "OPEN" || table.cycles[0]?.id !== p.cycleId)
        throw new BusinessRuleError(
          "La mesa de esta compra ya no está abierta en el mismo ciclo."
        )
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${p.participationId} FOR UPDATE`
      try {
        await validateParticipationForPurchase(
          tx,
          p.participationId,
          p.playerId
        )
      } catch (e) {
        if (e instanceof BusinessRuleError)
          throw new BusinessRuleError(
            `${e.message} La compra conserva su mesa original: cancélala y registra una nueva en la mesa actual.`
          )
        throw e
      }
      const player = await tx.player.findUniqueOrThrow({
        where: { id: p.playerId },
        select: { id: true, name: true, isActive: true },
      })
      assertPlayerSelectable(player)

      // Estado financiero real (con transferencias verificadas a la fecha).
      const f = financialsOf(p)
      if (f.overApplied)
        throw new BusinessRuleError(BLOCKER_MESSAGE.OVER_APPLIED)
      if (f.pendingCards.greaterThan(0))
        throw new BusinessRuleError(BLOCKER_MESSAGE.PENDING_CARD_PAYMENT)
      const summary = signableSummary(p, f)
      const hash = summaryHash(summary)
      let signatureId: string | null = null
      let expectedNumber: {
        purchaseType: "INITIAL_PURCHASE" | "REBUY"
        rebuyNumber: number | null
      } | null = null
      const auth = activeAuthorization(p)
      if (f.outstanding.greaterThan(0)) {
        if (!auth || !dec(auth.authorizedCreditAmount).equals(f.outstanding))
          throw new BusinessRuleError(
            BLOCKER_MESSAGE.CREDIT_AUTHORIZATION_REQUIRED
          )
        const signature = await verifier.findValidSignature(tx, {
          purchaseId: p.id,
          playerId: p.playerId,
          summaryVersion: p.version,
          summaryHash: hash,
        })
        if (!signature)
          throw new BusinessRuleError(
            verifier.available
              ? SIGNATURE_MISSING_MESSAGE
              : SIGNATURE_UNAVAILABLE_MESSAGE
          )
        signatureId = signature.signatureId
        expectedNumber = signature.expectedNumber ?? null
      }

      // Numeración por (sesión, jugador), serializada por la participación.
      const last = await tx.chipPurchase.aggregate({
        where: { sessionId: p.sessionId, playerId: p.playerId },
        _max: { sequenceNumber: true },
      })
      const number = nextPurchaseNumber(last._max.sequenceNumber)
      // El jugador firmó un tipo/número de recompra: si otra compra suya se
      // confirmó antes, lo firmado ya no corresponde (FIR-06).
      if (
        expectedNumber &&
        (expectedNumber.purchaseType !== number.purchaseType ||
          expectedNumber.rebuyNumber !== number.rebuyNumber)
      )
        throw new BusinessRuleError(SIGNATURE_STALE_MESSAGE)

      // Inventario: salida NOMINAL una sola vez (reserva vigente o nueva).
      let reservationId = p.reservationId
      if (reservationId) {
        const r = await tx.chipReservation.findUnique({
          where: { id: reservationId },
          select: { status: true },
        })
        if (r?.status !== "ACTIVE") reservationId = null
      }
      if (!reservationId) {
        const r = await reserveNominalAmountInTx(
          tx,
          actor,
          {
            amount: dec(p.nominalAmount),
            referenceType: "ChipPurchase",
            referenceId: p.id,
            tableId: p.tableId,
            sessionId: p.sessionId,
            playerId: p.playerId,
            expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
            idempotencyKey: `purchase-reserve-${input.idempotencyKey}`,
          },
          ctx
        )
        reservationId = r.id
      }
      const delivery = await confirmNominalChipDeliveryInTx(
        tx,
        actor,
        reservationId,
        `purchase-delivery-${input.idempotencyKey}`,
        ctx
      )

      // Dinero: efectivo y tarjeta aprobada, un asiento por componente.
      const postable = p.payments.filter(
        (x) =>
          (x.method === "CASH" && x.status === "CONFIRMED") ||
          ((x.method === "CARD_DEBIT" || x.method === "CARD_CREDIT") &&
            x.status === "APPROVED")
      )
      await lockAccountsInTx(tx, [
        ...postable.map((x) =>
          x.method === "CASH"
            ? { account: "CASH_ON_HAND" as const, scopeKey: p.sessionId }
            : {
                account: "CARD_TERMINAL_CLEARING" as const,
                scopeKey: GLOBAL_SCOPE,
              }
        ),
        ...(postable.length
          ? [{ account: "PLAYER_PURCHASES" as const, scopeKey: GLOBAL_SCOPE }]
          : []),
      ])
      for (const x of postable) {
        const amount = dec(x.amount)
        const isCash = x.method === "CASH"
        const posted = await postTransactionInTx(
          tx,
          {
            type: "PURCHASE_PAYMENT",
            sessionId: p.sessionId,
            tableId: p.tableId,
            playerId: p.playerId,
            referenceType: "PurchasePayment",
            referenceId: x.id,
            reason: isCash
              ? `Cobro en efectivo de la compra ${p.folio}`
              : `Cobro con ${x.method === "CARD_DEBIT" ? "tarjeta de débito" : "tarjeta de crédito"} (terminal) de la compra ${p.folio}`,
            notes: isCash ? null : `Ref. terminal: ${x.terminalReference}`,
            idempotencyKey: `purchase-payment-${x.id}`,
            requestHash: `purchase-payment-${x.id}-${fmt(amount)}`,
            actorId: actor.id,
            audit: {
              action: AUDIT_ACTIONS.CASH_PLAYER_PAYMENT_RECORDED,
              metadata: {
                purchaseId: p.id,
                purchaseFolio: p.folio,
                method: x.method,
                amount: fmt(amount),
              },
            },
          },
          [
            isCash
              ? {
                  account: "CASH_ON_HAND",
                  direction: "DEBIT",
                  amount,
                  scopeKey: p.sessionId,
                }
              : {
                  account: "CARD_TERMINAL_CLEARING",
                  direction: "DEBIT",
                  amount,
                  scopeKey: GLOBAL_SCOPE,
                },
            {
              account: "PLAYER_PURCHASES",
              direction: "CREDIT",
              amount,
              scopeKey: GLOBAL_SCOPE,
            },
          ],
          ctx
        )
        const { count } = await tx.purchasePayment.updateMany({
          where: { id: x.id, financialTransactionId: null },
          data: { financialTransactionId: posted.transactionId },
        })
        if (count !== 1)
          throw new ConflictError("El pago ya estaba contabilizado")
      }

      const now = new Date()
      await tx.purchaseDelivery.create({
        data: {
          purchaseId: p.id,
          nominalAmount: dec(p.nominalAmount),
          inventoryOperationId: delivery.operationId,
          reservationId,
          confirmedPayments: f.confirmedPayments,
          pendingTransfers: f.pendingTransfers,
          outstandingAmount: f.outstanding,
          summaryVersion: p.version,
          summaryHash: hash,
          signatureId,
          deliveredById: actor.id,
          deliveredAt: now,
          idempotencyKey: input.idempotencyKey,
        },
      })

      if (f.outstanding.greaterThan(0) && auth) {
        const used = await tx.purchaseCreditAuthorization.updateMany({
          where: { id: auth.id, status: "ACTIVE" },
          data: { status: "USED" },
        })
        if (used.count !== 1)
          throw new ConflictError("La autorización de crédito cambió")
        const debt = await tx.playerDebt.create({
          data: {
            playerId: p.playerId,
            sessionId: p.sessionId,
            tableId: p.tableId,
            purchaseId: p.id,
            authorizationId: auth.id,
            originalAmount: f.outstanding,
            createdById: actor.id,
            createdAt: now,
          },
          select: { id: true },
        })
        await recordAudit(
          {
            action: AUDIT_ACTIONS.RECEIVABLE_CREATED,
            entityType: "PlayerDebt",
            entityId: debt.id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              purchaseId: p.id,
              folio: p.folio,
              playerId: p.playerId,
              amount: fmt(f.outstanding),
              pendingTransfers: fmt(f.pendingTransfers),
              partnerId: auth.authorizedByPartner.id,
              partnerName: auth.partnerNameSnapshot,
              channel: auth.authorizationChannel,
            },
          },
          tx
        )
        // Evento para el Módulo 13 (no se envía nada aquí; deduplicado).
        const event = await tx.notificationOutbox.createManyAndReturn({
          data: [
            {
              eventType: "PURCHASE_CREDIT_CONFIRMED",
              channel: "WHATSAPP",
              playerId: p.playerId,
              aggregateType: "ChipPurchase",
              aggregateId: p.id,
              payload: {
                purchaseId: p.id,
                folio: p.folio,
                sessionId: p.sessionId,
                table: p.table.name,
                nominalAmount: fmt(f.nominalAmount),
                confirmedPayments: fmt(f.confirmedPayments),
                creditAmount: fmt(f.outstanding),
                confirmedAt: now.toISOString(),
              },
              dedupeKey: `PURCHASE_CREDIT_CONFIRMED:${p.id}`,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        })
        if (event[0])
          await recordAudit(
            {
              action: AUDIT_ACTIONS.PURCHASE_CREDIT_EVENT_QUEUED,
              entityType: "NotificationOutbox",
              entityId: event[0].id,
              actorUserId: actor.id,
              requestId: ctx.requestId,
              metadata: { purchaseId: p.id, folio: p.folio, status: "PENDING" },
            },
            tx
          )
      }

      const { count } = await tx.chipPurchase.updateMany({
        where: { id: p.id, version: p.version, status: p.status },
        data: {
          status: "CONFIRMED",
          purchaseType: number.purchaseType,
          sequenceNumber: number.sequenceNumber,
          rebuyNumber: number.rebuyNumber,
          reservationId,
          confirmedById: actor.id,
          confirmedAt: now,
        },
      })
      if (count !== 1) throw new ConflictError("La compra cambió de estado")
      await recordStatus(tx, p.id, p.status, "CONFIRMED", actor.id)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PURCHASE_CONFIRMED,
          entityType: "ChipPurchase",
          entityId: p.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: p.folio,
            purchaseType: number.purchaseType,
            rebuyNumber: number.rebuyNumber,
            nominalAmount: fmt(f.nominalAmount),
            confirmedPayments: fmt(f.confirmedPayments),
            pendingTransfers: fmt(f.pendingTransfers),
            outstanding: fmt(f.outstanding),
            inventoryOperationId: delivery.operationId,
            table: p.table.name,
            sessionId: p.sessionId,
            cycleId: p.cycleId,
            playerId: p.playerId,
            signatureId,
            version: p.version,
          },
        },
        tx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PURCHASE_DELIVERY_CONFIRMED,
          entityType: "PurchaseDelivery",
          entityId: p.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            purchaseId: p.id,
            folio: p.folio,
            playerId: p.playerId,
            sessionId: p.sessionId,
            signatureId,
            outstanding: fmt(f.outstanding),
            summaryDigest: hash,
          },
        },
        tx
      )
      // Comprobante digital (Módulo 09): snapshot inmutable de lo entregado.
      await createReceiptInTx(tx, actor, p.id, ctx)
      return false
    }, PURCHASE_TX)
    return { purchase: await getPurchase(id, { verifier }), replayed }
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (await replay())
        return { purchase: await getPurchase(id, { verifier }), replayed: true }
      throw new ConflictError(
        "Otra operación modificó esta compra o la numeración del jugador al mismo tiempo. Intenta de nuevo."
      )
    }
    throw error
  }
}

// ── Cancelar borrador ─────────────────────────────────────────────────

/**
 * Cancela un borrador: libera la reserva y cancela transferencias
 * pendientes. NO descarta cobros reales: el efectivo recibido debe
 * devolverse (retirar el pago), la tarjeta aprobada anularse en la
 * terminal, y una transferencia verificada bloquea la cancelación.
 */
export async function cancelPurchase(
  actor: SessionUser,
  id: string,
  input: { reason: string },
  ctx: RequestContext = {}
) {
  await purchaseHead(id)
  await prisma.$transaction(async (tx) => {
    const p = await lockPurchase(tx, id)
    if (p.status === "CANCELLED") return
    assertEditable(p)
    const live = p.payments.filter(
      (x) =>
        (x.method === "CASH" && x.status === "CONFIRMED") ||
        ((x.method === "CARD_DEBIT" || x.method === "CARD_CREDIT") &&
          (x.status === "APPROVED" || x.status === "PENDING"))
    )
    if (live.length)
      throw new BusinessRuleError(
        "La compra tiene cobros reales: devuelve el efectivo (retira el pago) y anula o resuelve los cobros con terminal antes de cancelarla."
      )
    if (
      p.payments.some(
        (x) =>
          x.method === "BANK_TRANSFER" &&
          x.status !== "CANCELLED" &&
          x.bankTransfer?.status === "CONFIRMED"
      )
    )
      throw new BusinessRuleError(
        "La compra tiene una transferencia verificada: requiere resolución financiera explícita (devolución) antes de cancelar."
      )
    for (const x of p.payments) {
      if (
        x.method === "BANK_TRANSFER" &&
        x.status === "PENDING" &&
        x.bankTransfer
      ) {
        if (x.bankTransfer.status === "PENDING_VERIFICATION")
          await cancelPendingBankTransferInTx(tx, actor, x.bankTransfer.id, ctx)
        await tx.purchasePayment.update({
          where: { id: x.id },
          data: {
            status: "CANCELLED",
            resolutionNotes: "Compra cancelada",
            resolvedById: actor.id,
            resolvedAt: new Date(),
          },
        })
      }
    }
    if (p.reservationId) {
      const r = await tx.chipReservation.findUnique({
        where: { id: p.reservationId },
        select: { status: true },
      })
      if (r?.status === "ACTIVE")
        await releaseNominalReservationInTx(tx, actor, p.reservationId, ctx)
    }
    await tx.purchaseCreditAuthorization.updateMany({
      where: { purchaseId: id, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    })
    // La firma se conserva como evidencia, pero ya no autoriza nada (FIR-19).
    await invalidatePurchaseSignaturesInTx(
      tx,
      {
        purchaseId: id,
        actorId: actor.id,
        reason: `Compra cancelada: ${input.reason}`,
        status: "CANCELLED",
      },
      { requestId: ctx.requestId }
    )
    const now = new Date()
    const { count } = await tx.chipPurchase.updateMany({
      where: { id, status: p.status },
      data: {
        status: "CANCELLED",
        cancelledById: actor.id,
        cancelledAt: now,
        cancellationReason: input.reason,
      },
    })
    if (count !== 1) throw new ConflictError("La compra cambió de estado")
    await recordStatus(tx, id, p.status, "CANCELLED", actor.id, input.reason)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PURCHASE_CANCELLED,
        entityType: "ChipPurchase",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: p.folio,
          reason: input.reason,
          reservationReleased: Boolean(p.reservationId),
        },
      },
      tx
    )
  }, PURCHASE_TX)
  return getPurchase(id)
}

// ── Reverso (solicitud) ───────────────────────────────────────────────

/**
 * Registra una solicitud justificada de reverso de una compra CONFIRMADA.
 * No mueve fichas ni dinero: el reverso completo exige verificar la
 * devolución física de fichas, reembolsos, abonos y liquidaciones
 * (Módulos 10 y 11). La compra no cambia.
 */
export async function requestReversal(
  actor: SessionUser,
  id: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  await purchaseHead(id)
  const previous = await prisma.purchaseReversalRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { purchaseId: true },
  })
  if (previous) {
    if (previous.purchaseId !== id)
      throw new AppError("CONFLICT", "Clave de operación reutilizada")
    return { purchase: await getPurchase(id), replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const p = await lockPurchase(tx, id)
      if (p.status !== "CONFIRMED")
        throw new BusinessRuleError(
          "Solo se solicita el reverso de compras confirmadas. Un borrador se cancela."
        )
      const created = await tx.purchaseReversalRequest.create({
        data: {
          purchaseId: id,
          reason: input.reason,
          requestedById: actor.id,
          requestedAt: new Date(),
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PURCHASE_REVERSAL_REQUESTED,
          entityType: "ChipPurchase",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: p.folio,
            reversalRequestId: created.id,
            reason: input.reason,
            note: "Sin movimientos: el reverso completo requiere los Módulos 10 y 11.",
          },
        },
        tx
      )
    }, PURCHASE_TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("Ya hay una solicitud de reverso abierta.")
    throw error
  }
  return { purchase: await getPurchase(id), replayed: false }
}

/** Contexto para iniciar una compra desde una participación (paso 1). */
export async function getPurchaseContext(participationId: string) {
  const p = await prisma.tableParticipation.findUnique({
    where: { id: participationId },
    select: {
      id: true,
      status: true,
      session: { select: { id: true, folio: true, status: true } },
      sessionTable: {
        select: {
          status: true,
          table: { select: { id: true, name: true } },
        },
      },
      player: { select: { id: true, name: true, nickname: true } },
    },
  })
  if (!p) throw new NotFoundError("Participación no encontrada")
  const confirmed = await prisma.chipPurchase.count({
    where: {
      sessionId: p.session.id,
      playerId: p.player.id,
      status: "CONFIRMED",
    },
  })
  return {
    participationId: p.id,
    participationStatus: p.status,
    session: p.session,
    table: p.sessionTable.table,
    tableStatus: p.sessionTable.status,
    player: p.player,
    /** Lo que sería si se confirma ahora (la numeración real se asigna al confirmar). */
    nextLabel: confirmed === 0 ? "Compra inicial" : `Recompra ${confirmed}`,
  }
}

/**
 * CONTRATO (Módulo 10 — créditos): deudas de un jugador originadas en
 * compras, con su saldo vigente DERIVADO (importe original − pagos
 * confirmados después de la entrega, p. ej. transferencias verificadas).
 * Nunca hay un campo de saldo editable. Varias deudas de distintas
 * sesiones conviven; el orden es por antigüedad (base del FIFO).
 */
export async function listPlayerPurchaseDebts(playerId: string) {
  const debts = await prisma.playerDebt.findMany({
    where: { playerId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      sessionId: true,
      tableId: true,
      originalAmount: true,
      createdAt: true,
      authorization: {
        select: {
          partnerNameSnapshot: true,
          authorizationChannel: true,
          authorizedByPartnerId: true,
          recordedById: true,
        },
      },
      purchase: {
        select: {
          id: true,
          folio: true,
          nominalAmount: true,
          payments: {
            select: {
              id: true,
              method: true,
              amount: true,
              status: true,
              bankTransfer: { select: { status: true, confirmedAmount: true } },
            },
          },
        },
      },
    },
  })
  const applied = await appliedByReceivable(
    prisma,
    debts.map((d) => d.id)
  )
  return debts.map((d) => {
    const f = financialsOf(d.purchase)
    return {
      id: d.id,
      purchaseId: d.purchase.id,
      folio: d.purchase.folio,
      sessionId: d.sessionId,
      tableId: d.tableId,
      originalAmount: fmt(dec(d.originalAmount)),
      currentBalance: fmt(
        dec(d.originalAmount).sub(applied.get(d.id) ?? dec(0))
      ),
      pendingTransfers: fmt(f.pendingTransfers),
      partnerName: d.authorization.partnerNameSnapshot,
      partnerId: d.authorization.authorizedByPartnerId,
      channel: d.authorization.authorizationChannel,
      recordedById: d.authorization.recordedById,
      createdAt: d.createdAt.toISOString(),
    }
  })
}

/**
 * CONTRATO (Módulo 09): estado VIGENTE de una compra para preparar o
 * verificar el reconocimiento de crédito. La autorización solo se devuelve
 * si corresponde a la versión actual y al saldo por cobrar actual. El
 * número de compra es una proyección (el real se asigna al entregar).
 */
export async function loadPurchaseCreditStateInTx(
  tx: Tx | typeof prisma,
  id: string
) {
  const p = await tx.chipPurchase.findUnique({
    where: { id },
    select: purchaseSelect,
  })
  if (!p) throw new NotFoundError("Compra no encontrada")
  const f = financialsOf(p)
  const auth = activeAuthorization(p)
  const last = await tx.chipPurchase.aggregate({
    where: { sessionId: p.sessionId, playerId: p.playerId },
    _max: { sequenceNumber: true },
  })
  return {
    purchase: p,
    financials: f,
    authorization:
      auth && dec(auth.authorizedCreditAmount).equals(f.outstanding)
        ? auth
        : null,
    projectedNumber: nextPurchaseNumber(last._max.sequenceNumber),
  }
}
export type PurchaseCreditState = Awaited<
  ReturnType<typeof loadPurchaseCreditStateInTx>
>
