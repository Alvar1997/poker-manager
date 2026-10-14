import { BusinessRuleError } from "@/lib/errors"

/**
 * Reglas de dominio del jugador que usarán los módulos operativos
 * (sesiones, compras…). Puras: sin acceso a base de datos.
 */

/**
 * Un jugador inactivo permanece en el directorio y conserva historial y
 * deudas, pero NO puede seleccionarse para nuevas compras ni sesiones
 * ordinarias. Los cobros de deudas pendientes no usan esta verificación.
 */
export function assertPlayerSelectable(player: {
  isActive: boolean
  name: string
}): void {
  if (!player.isActive) {
    throw new BusinessRuleError(
      `${player.name} está inactivo: no puede seleccionarse para nuevas operaciones. Reactívalo primero.`
    )
  }
}

export function isPlayerSelectable(player: { isActive: boolean }): boolean {
  return player.isActive
}
