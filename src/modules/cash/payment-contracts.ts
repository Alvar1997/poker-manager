import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError } from "@/lib/errors"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { registerPendingBankTransferInTx } from "@/modules/cash/bank-transfer.service"
import {
  formatMoney,
  money,
  splitPayment,
  type PaymentComponent,
} from "@/modules/cash/cash.math"
import {
  custodianScope,
  GLOBAL_SCOPE,
  postTransactionInTx,
  type LedgerEntry,
  type Tx,
} from "@/modules/cash/ledger"
import {
  currentSessionGateway,
  requireSessionStatus,
  type SessionGateway,
} from "@/modules/cash/session-gateway"

/**
 * CONTRATOS internos para abonos (Módulo 10) y liquidaciones (Módulo 11).
 * Las COMPRAS (Módulo 08) ya no usan `recordPlayerPaymentInTx`: registran
 * cada componente (efectivo, transferencia, tarjeta) en
 * `src/modules/purchases/purchase.service.ts` y lo contabilizan al
 * confirmar la entrega, con referencia `PurchasePayment` por componente. No tienen endpoint: los módulos de origen los llaman
 * DENTRO de su propia transacción, con su referencia única.
 *
 * - Pago mixto: efectivo → asiento inmediato; transferencia → PENDIENTE de
 *   verificación (no es cobro); crédito → NINGÚN asiento (es deuda).
 * - Una operación de origen solo puede cobrarse/pagarse una vez (índices
 *   únicos por referencia).
 * - Liquidación (Módulo 11): la compensación de deuda NO mueve efectivo;
 *   cada desembolso real (efectivo o transferencia ejecutada) genera UN
 *   asiento, nunca más del efectivo disponible.
 */

type Deps = { sessions?: SessionGateway }

export async function recordPlayerPaymentInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    origin: "PURCHASE" | "DEBT_PAYMENT"
    referenceId: string
    sessionId: string
    tableId?: string | null
    playerId: string
    total: Prisma.Decimal | string
    components: {
      method: PaymentComponent["method"]
      amount: Prisma.Decimal | string
    }[]
    bankReference?: string | null
    idempotencyKey: string
  },
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  await requireSessionStatus(
    deps.sessions ?? currentSessionGateway(),
    input.sessionId,
    ["OPEN"]
  )
  let split: ReturnType<typeof splitPayment>
  try {
    split = splitPayment(
      money(input.total),
      input.components.map(
        (c) =>
          ({ method: c.method, amount: money(c.amount) }) as PaymentComponent
      )
    )
  } catch (e) {
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "Pago inválido"
    )
  }
  const referenceType =
    input.origin === "PURCHASE" ? "ChipPurchase" : "DebtPayment"
  const creditAccount =
    input.origin === "PURCHASE" ? "PLAYER_PURCHASES" : "PLAYER_DEBT_PAYMENTS"

  let cashTransactionId: string | null = null
  if (split.cashNow.greaterThan(0)) {
    const posted = await postTransactionInTx(
      tx,
      {
        type: input.origin === "PURCHASE" ? "PURCHASE_PAYMENT" : "DEBT_PAYMENT",
        sessionId: input.sessionId,
        tableId: input.tableId,
        playerId: input.playerId,
        referenceType,
        referenceId: input.referenceId,
        reason:
          input.origin === "PURCHASE"
            ? "Cobro en efectivo de compra de fichas"
            : "Abono en efectivo",
        idempotencyKey: `${input.idempotencyKey}-cash`,
        requestHash: `${referenceType}-${input.referenceId}-${formatMoney(split.cashNow)}`,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_PLAYER_PAYMENT_RECORDED,
          metadata: { cash: formatMoney(split.cashNow) },
        },
      },
      [
        {
          account: "CASH_ON_HAND",
          direction: "DEBIT",
          amount: split.cashNow,
          scopeKey: input.sessionId,
        },
        {
          account: creditAccount,
          direction: "CREDIT",
          amount: split.cashNow,
          scopeKey: GLOBAL_SCOPE,
        },
      ],
      ctx
    )
    cashTransactionId = posted.transactionId
  }

  let bankTransferId: string | null = null
  if (split.bankPending.greaterThan(0)) {
    const pending = await registerPendingBankTransferInTx(
      tx,
      actor,
      {
        declaredAmount: split.bankPending,
        creditAccountKind: creditAccount,
        referenceType,
        referenceId: input.referenceId,
        sessionId: input.sessionId,
        tableId: input.tableId,
        playerId: input.playerId,
        bankReference: input.bankReference,
        idempotencyKey: `${input.idempotencyKey}-bank`,
      },
      ctx
    )
    bankTransferId = pending.id
  }

  return {
    cashTransactionId,
    bankTransferId,
    cashReceived: formatMoney(split.cashNow),
    bankPending: formatMoney(split.bankPending),
    /** Queda como deuda (Módulo 10); NO genera dinero. */
    creditAmount: formatMoney(split.credit),
  }
}

/**
 * CONTRATO (Módulo 11): asiento de UN desembolso de liquidación ya
 * ejecutado. Solo sale dinero real que se entregó; la compensación de deuda
 * nunca pasa por aquí (no es efectivo ni banco).
 *
 *  - SESSION_CASH: efectivo de la caja de la sesión de origen (OPEN o
 *    CLOSING). Nunca de una sesión cerrada; nunca deja la caja negativa.
 *  - ADMIN_CUSTODY: efectivo administrativo del custodio (sesión ya
 *    cerrada): no toca ninguna caja de sesión; la custodia no puede quedar
 *    negativa.
 *  - BANK: transferencia saliente cuya ejecución se verificó manualmente.
 *
 * Un asiento por desembolso (referencia `SettlementPayout`, índice único).
 */
export async function recordSettlementPayoutInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    payoutId: string
    settlementId: string
    settlementFolio: string
    funding: "SESSION_CASH" | "ADMIN_CUSTODY" | "BANK"
    sessionId?: string | null
    custodianUserId?: string | null
    tableId?: string | null
    playerId: string
    amount: Prisma.Decimal
    bankReference?: string | null
    idempotencyKey: string
  },
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  if (!input.amount.greaterThan(0))
    throw new BusinessRuleError("El desembolso debe ser mayor que cero")
  let source: LedgerEntry
  if (input.funding === "SESSION_CASH") {
    if (!input.sessionId)
      throw new Error("El efectivo de sesión requiere la sesión de origen")
    await requireSessionStatus(
      deps.sessions ?? currentSessionGateway(),
      input.sessionId,
      ["OPEN", "CLOSING"]
    )
    source = {
      account: "CASH_ON_HAND",
      direction: "CREDIT",
      amount: input.amount,
      scopeKey: input.sessionId,
    }
  } else if (input.funding === "ADMIN_CUSTODY") {
    if (!input.custodianUserId)
      throw new Error("La custodia administrativa requiere su custodio")
    source = {
      account: "ADMIN_CASH_CUSTODY",
      direction: "CREDIT",
      amount: input.amount,
      scopeKey: custodianScope(input.custodianUserId),
    }
  } else {
    source = {
      account: "BANK",
      direction: "CREDIT",
      amount: input.amount,
      scopeKey: GLOBAL_SCOPE,
    }
  }
  const isBank = input.funding === "BANK"
  const posted = await postTransactionInTx(
    tx,
    {
      type: isBank ? "BANK_TRANSFER_PAYOUT" : "PLAYER_SETTLEMENT",
      sessionId: input.funding === "SESSION_CASH" ? input.sessionId : null,
      tableId: input.tableId,
      playerId: input.playerId,
      referenceType: "SettlementPayout",
      referenceId: input.payoutId,
      reason: isBank
        ? `Transferencia ejecutada al jugador (liquidación ${input.settlementFolio})`
        : input.funding === "ADMIN_CUSTODY"
          ? `Pago administrativo en efectivo de la liquidación ${input.settlementFolio}`
          : `Pago en efectivo de la liquidación ${input.settlementFolio}`,
      notes: input.bankReference
        ? `Ref. bancaria: ${input.bankReference}`
        : null,
      idempotencyKey: input.idempotencyKey,
      requestHash: `SettlementPayout-${input.payoutId}-${formatMoney(input.amount)}`,
      actorId: actor.id,
      audit: {
        action: AUDIT_ACTIONS.CASH_SETTLEMENT_PAID,
        metadata: {
          settlementId: input.settlementId,
          payoutId: input.payoutId,
          funding: input.funding,
          amount: formatMoney(input.amount),
        },
      },
    },
    [
      {
        account: "PLAYER_SETTLEMENTS",
        direction: "DEBIT",
        amount: input.amount,
        scopeKey: GLOBAL_SCOPE,
      },
      source,
    ],
    ctx
  )
  return { transactionId: posted.transactionId, replayed: posted.replayed }
}
