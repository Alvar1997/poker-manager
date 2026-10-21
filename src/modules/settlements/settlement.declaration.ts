/**
 * Declaraciones de la firma de LIQUIDACIÓN, versionadas. Un texto ya
 * firmado nunca cambia: para modificarlo se agrega una versión nueva y se
 * apunta `CURRENT_SETTLEMENT_DECLARATION_VERSION` a ella. Cada firma
 * conserva el texto exacto en su snapshot.
 */
export const SETTLEMENT_DECLARATIONS = {
  "2026-10-liq-v1":
    "Reconozco que la presente liquidación corresponde al valor nominal de fichas indicado. He revisado la compensación de deudas señalada, si aplica, y el importe que me corresponde recibir. Entiendo que los pagos pendientes se registrarán y se cubrirán posteriormente.",
} as const

export type SettlementDeclarationVersion = keyof typeof SETTLEMENT_DECLARATIONS

export const CURRENT_SETTLEMENT_DECLARATION_VERSION: SettlementDeclarationVersion =
  "2026-10-liq-v1"

export function currentSettlementDeclaration() {
  return {
    version: CURRENT_SETTLEMENT_DECLARATION_VERSION,
    text: SETTLEMENT_DECLARATIONS[CURRENT_SETTLEMENT_DECLARATION_VERSION],
  }
}
