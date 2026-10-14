/**
 * Política de crédito de Poker Manager (definitiva, Módulo 03).
 *
 * Crédito ILIMITADO no significa crédito sin control: cada compra a
 * crédito quedará asociada a un jugador, requerirá su firma y quedará
 * auditada; el importe no pagado genera una deuda que se conserva entre
 * sesiones y se compensa por FIFO en las liquidaciones.
 *
 * Deliberadamente NO hay campos de límite en el jugador ni en la
 * configuración. Si algún día se quisiera un límite, sería una decisión de
 * negocio nueva que debe documentarse en docs/BUSINESS_RULES.md.
 */
export const CREDIT_POLICY = {
  /** CRED-01: sin límite por jugador. */
  individualLimit: null,
  /** CRED-02: sin límite global. */
  globalLimit: null,
  /** CRED-03/04/05/06: los tres roles otorgan crédito sin autorización adicional. */
  grantableBy: ["SUPERADMIN", "PARTNER", "CASHIER"],
  requiresExternalApproval: false,
  /** CRED-07/08: toda compra a crédito va ligada a un jugador y lleva firma. */
  requiresPlayer: true,
  requiresSignature: true,
  /** CRED-10/11: las deudas persisten entre sesiones y se compensan por FIFO. */
  debtsPersistAcrossSessions: true,
  settlementOrder: "FIFO",
  /** CRED-13: lo pendiente es cuenta por cobrar, no dinero en caja. */
  creditCountsAsCash: false,
} as const

/** Siempre true: no hay tope. Existe para que los módulos futuros no inventen uno. */
export function isWithinCreditPolicy(): true {
  return true
}
