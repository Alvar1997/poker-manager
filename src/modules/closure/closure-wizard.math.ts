/**
 * Reglas PURAS del asistente de cierre (6 pasos). El estado de cada paso se
 * DERIVA de sus tareas (calculadas en el servidor con datos reales): nunca
 * de que el cajero lo haya visitado ni de casillas marcables.
 */

import type { WizardTask } from "@/lib/wizard"

export type { TaskSeverity, WizardTask } from "@/lib/wizard"

export type WizardStepId =
  "players" | "tables" | "tips" | "count" | "reconciliation" | "confirm"

export type WizardStepStatus =
  /** Aún no se puede trabajar (depende de un paso o estado previo). */
  | "PENDING"
  /** Tiene tareas obligatorias por hacer. */
  | "ERROR"
  /** Completo, con advertencias que permiten continuar. */
  | "WARNING"
  | "COMPLETED"

export const WIZARD_STEPS: { id: WizardStepId; title: string; hint: string }[] =
  [
    {
      id: "players",
      title: "Finalizar jugadores",
      hint: "Todos terminan con OUT o cashout confirmado.",
    },
    {
      id: "tables",
      title: "Cerrar mesas y rake",
      hint: "Cada mesa cerrada y su rake registrado.",
    },
    {
      id: "tips",
      title: "Contar propinas",
      hint: "Importe contado de cada empleado.",
    },
    {
      id: "count",
      title: "Arqueo de fichas",
      hint: "Un conteo físico global del inventario.",
    },
    {
      id: "reconciliation",
      title: "Conciliación y diferencias",
      hint: "Destino de las fichas y motivo si falta o sobra.",
    },
    {
      id: "confirm",
      title: "Confirmar cierre",
      hint: "Efectivo, retiro final y cierre definitivo.",
    },
  ]

export function stepStatus(input: {
  available: boolean
  tasks: WizardTask[]
}): WizardStepStatus {
  if (!input.available) return "PENDING"
  if (input.tasks.some((t) => t.severity === "BLOCKING")) return "ERROR"
  if (input.tasks.some((t) => t.severity === "WARNING")) return "WARNING"
  return "COMPLETED"
}

export function wizardProgress(statuses: WizardStepStatus[]) {
  const done = statuses.filter(
    (s) => s === "COMPLETED" || s === "WARNING"
  ).length
  return { done, total: statuses.length }
}

/** Paso sugerido: el primero que aún no está completo. */
export function firstOpenStep(statuses: WizardStepStatus[]) {
  const i = statuses.findIndex((s) => s === "ERROR" || s === "PENDING")
  return i === -1 ? statuses.length : i + 1
}

/** Texto de una diferencia nominal o física (+ faltan / − sobran). */
export function differenceText(amount: string, kind: "nominal" | "physical") {
  if (!/[1-9]/.test(amount)) return null
  const negative = amount.startsWith("-")
  const abs = negative ? amount.slice(1) : amount
  if (kind === "nominal")
    return negative
      ? {
          tone: "SURPLUS" as const,
          abs,
          text: `sobran $${abs} respecto al valor nominal entregado`,
        }
      : { tone: "MISSING" as const, abs, text: `faltan $${abs} por justificar` }
  // Física: contado − esperado (+ sobran en la caja, − faltan).
  return negative
    ? {
        tone: "MISSING" as const,
        abs,
        text: `faltan $${abs} en el arqueo frente a lo esperado`,
      }
    : {
        tone: "SURPLUS" as const,
        abs,
        text: `sobran $${abs} en el arqueo frente a lo esperado`,
      }
}
