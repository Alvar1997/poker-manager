/**
 * Declaraciones de reconocimiento de crédito, VERSIONADAS. Un texto ya
 * firmado nunca se modifica: para cambiarlo se agrega una versión nueva y
 * se apunta `CURRENT_DECLARATION_VERSION` a ella. Las firmas existentes
 * conservan el texto exacto en su snapshot; una compra aún no entregada
 * con una versión anterior debe firmarse de nuevo.
 */
export const DECLARATIONS = {
  "2026-10-v1":
    "Reconozco haber solicitado la compra de fichas por el importe señalado y acepto el saldo pendiente de pago mostrado. Entiendo que la entrega física será confirmada por el cajero una vez concluida esta operación.",
} as const

export type DeclarationVersion = keyof typeof DECLARATIONS

export const CURRENT_DECLARATION_VERSION: DeclarationVersion = "2026-10-v1"

export function currentDeclaration() {
  return {
    version: CURRENT_DECLARATION_VERSION,
    text: DECLARATIONS[CURRENT_DECLARATION_VERSION],
  }
}
