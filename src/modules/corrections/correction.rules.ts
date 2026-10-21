/**
 * Reglas PURAS de las correcciones financieras excepcionales (Módulo 15).
 *
 * REGLA FUNDAMENTAL: aprobar NO modifica saldos. Una solicitud solo pasa a
 * EXECUTED cuando se ENLAZA una operación real ya registrada por el
 * servicio legítimo de su módulo de origen (reverso de abono, reverso de
 * movimiento de caja, reverso de liquidación sin pagos). Los cuatro
 * procesos del Módulo 16 se EJECUTAN en Operaciones especiales
 * (src/modules/special-operations): ese servicio enlaza la solicitud en su
 * misma transacción solo cuando los efectos reales quedaron registrados.
 */

export const CORRECTION_TYPES = [
  "RECEIVABLE_PAYMENT_REVERSAL",
  "CASH_MOVEMENT_REVERSAL",
  "SETTLEMENT_REVERSAL",
  "PURCHASE_REVERSAL",
  "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
  "UNAPPLIED_FUNDS_RETURN",
  "LATE_CHIP_REDEMPTION",
  "OTHER",
] as const
export type CorrectionTypeValue = (typeof CORRECTION_TYPES)[number]

export const CORRECTION_STATUSES = [
  "REQUESTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "EXECUTED",
  "FAILED",
  "CANCELLED",
] as const
export type CorrectionStatusValue = (typeof CORRECTION_STATUSES)[number]

export type TargetType =
  | "ReceivablePayment"
  | "CashTransaction"
  | "PlayerSettlement"
  | "ChipPurchase"
  | "UnappliedPlayerFunds"
  | "Player"

/** Referencia REAL que prueba la ejecución, por tipo (null = sin servicio). */
export type ExecutionReferenceType =
  | "ReceivablePaymentReversal"
  | "CashTransaction"
  | "SettlementReversal"
  // Módulo 16
  | "PurchaseReversal"
  | "SettlementCorrection"
  | "UnappliedFundsRefund"
  | "LateChipRedemption"

export type CorrectionTypeMeta = {
  label: string
  module: string
  targets: TargetType[]
  /** Servicio legítimo que ejecuta la corrección (o null). */
  execution: {
    referenceType: ExecutionReferenceType
    service: string
  } | null
  /** Proceso del Módulo 16: se ejecuta en Operaciones especiales. */
  module16: boolean
}

export const CORRECTION_TYPE_META: Record<
  CorrectionTypeValue,
  CorrectionTypeMeta
> = {
  RECEIVABLE_PAYMENT_REVERSAL: {
    label: "Reverso de abono",
    module: "CREDITS",
    targets: ["ReceivablePayment"],
    execution: {
      referenceType: "ReceivablePaymentReversal",
      service: "Módulo 10 · Reversar abono (reversePayment)",
    },
    module16: false,
  },
  CASH_MOVEMENT_REVERSAL: {
    label: "Reverso de movimiento de caja",
    module: "CASH",
    targets: ["CashTransaction"],
    execution: {
      referenceType: "CashTransaction",
      service: "Módulo 05 · Reversar movimiento (reverseTransaction)",
    },
    module16: false,
  },
  SETTLEMENT_REVERSAL: {
    label: "Reverso de liquidación sin pagos reales",
    module: "SETTLEMENTS",
    targets: ["PlayerSettlement"],
    execution: {
      referenceType: "SettlementReversal",
      service: "Módulo 11 · Reversar liquidación (reverseSettlement)",
    },
    module16: false,
  },
  PURCHASE_REVERSAL: {
    label: "Reverso completo de compra confirmada",
    module: "PURCHASES",
    targets: ["ChipPurchase"],
    execution: {
      referenceType: "PurchaseReversal",
      service: "Operaciones especiales · Reversos de compras (Módulo 16)",
    },
    module16: true,
  },
  SETTLEMENT_REVERSAL_WITH_PAYOUTS: {
    label: "Corrección de liquidación con pagos reales",
    module: "SETTLEMENTS",
    targets: ["PlayerSettlement"],
    execution: {
      referenceType: "SettlementCorrection",
      service:
        "Operaciones especiales · Correcciones de liquidaciones (Módulo 16)",
    },
    module16: true,
  },
  UNAPPLIED_FUNDS_RETURN: {
    label: "Devolución de fondos no aplicados",
    module: "CREDITS",
    targets: ["UnappliedPlayerFunds"],
    execution: {
      referenceType: "UnappliedFundsRefund",
      service: "Operaciones especiales · Fondos no aplicados (Módulo 16)",
    },
    module16: true,
  },
  LATE_CHIP_REDEMPTION: {
    label: "Canje posterior de fichas",
    module: "INVENTORY",
    targets: ["Player"],
    execution: {
      referenceType: "LateChipRedemption",
      service: "Operaciones especiales · Canjes (Módulo 16)",
    },
    module16: true,
  },
  OTHER: {
    label: "Otra corrección documentada",
    module: "ADMINISTRATION",
    targets: [
      "ReceivablePayment",
      "CashTransaction",
      "PlayerSettlement",
      "ChipPurchase",
      "UnappliedPlayerFunds",
      "Player",
    ],
    execution: null,
    module16: false,
  },
}

export const CORRECTION_STATUS_LABEL: Record<CorrectionStatusValue, string> = {
  REQUESTED: "Solicitada",
  UNDER_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
  EXECUTED: "Ejecutada",
  FAILED: "Ejecución fallida",
  CANCELLED: "Cancelada",
}

export const ACTIVE_STATUSES: CorrectionStatusValue[] = [
  "REQUESTED",
  "UNDER_REVIEW",
  "APPROVED",
]

/** Transiciones permitidas (los terminales no salen). */
const TRANSITIONS: Record<CorrectionStatusValue, CorrectionStatusValue[]> = {
  REQUESTED: ["UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["EXECUTED", "FAILED", "CANCELLED"],
  FAILED: ["EXECUTED", "CANCELLED"],
  REJECTED: [],
  EXECUTED: [],
  CANCELLED: [],
}

export function canTransition(
  from: CorrectionStatusValue,
  to: CorrectionStatusValue
) {
  return TRANSITIONS[from].includes(to)
}

/**
 * Estado legible que refleja la REALIDAD: una aprobada sin servicio de
 * ejecución se muestra como pendiente (nunca como ejecutada).
 */
export function displayStatus(
  status: CorrectionStatusValue,
  type: CorrectionTypeValue
): string {
  const meta = CORRECTION_TYPE_META[type]
  if (status === "APPROVED") {
    if (meta.module16)
      return "Aprobada · pendiente de ejecución en Operaciones especiales (Módulo 16)"
    if (!meta.execution)
      return "Aprobada · sin ejecución automática (requiere la operación legítima de su módulo)"
    return `Aprobada · pendiente de ejecutar en ${meta.execution.service}`
  }
  return CORRECTION_STATUS_LABEL[status]
}

/**
 * Autoaprobación: el solicitante no decide su propia solicitud si existe
 * OTRO autorizador activo (PARTNER/SUPERADMIN). Si no hay otro, se permite
 * y queda marcada en la decisión.
 */
export function selfApprovalBlocked(input: {
  actorId: string
  requestedById: string
  otherActiveAuthorizers: number
}) {
  return (
    input.actorId === input.requestedById && input.otherActiveAuthorizers > 0
  )
}

export const AUTHORIZER_ROLES = ["PARTNER", "SUPERADMIN"] as const
export function isAuthorizerRole(role: string) {
  return (AUTHORIZER_ROLES as readonly string[]).includes(role)
}
