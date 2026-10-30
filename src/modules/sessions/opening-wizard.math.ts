import type { WizardTask } from "@/lib/wizard"

/**
 * Reglas PURAS del asistente de apertura (4 pasos). El estado de cada paso
 * se DERIVA de sus tareas y de registros reales calculados en el servidor:
 * nunca de que el usuario lo haya visitado ni de casillas marcables.
 */

export type OpeningStepId = "session" | "chips" | "tables" | "confirm"

export type OpeningStepStatus =
  /** Validación confirmada con datos reales. */
  | "COMPLETED"
  /** Falta una operación, pero nada impide continuar. */
  | "PENDING"
  /** Completo, con advertencias que permiten continuar. */
  | "WARNING"
  /** Requisito obligatorio sin cumplir: impide abrir. */
  | "BLOCKED"

export const OPENING_STEPS: {
  id: OpeningStepId
  title: string
  hint: string
}[] = [
  {
    id: "session",
    title: "Crear jornada",
    hint: "Folio, responsable y fecha los registra el sistema.",
  },
  {
    id: "chips",
    title: "Contar fichas",
    hint: "Un solo conteo físico del inventario compartido.",
  },
  {
    id: "tables",
    title: "Preparar mesas (opcional)",
    hint: "Elige las mesas que abrirán al iniciar, o continúa sin mesas.",
  },
  {
    id: "confirm",
    title: "Confirmar apertura",
    hint: "Caja en $0.00, revisión final y apertura.",
  },
]

export function openingStepStatus(input: {
  done: boolean
  tasks: WizardTask[]
}): OpeningStepStatus {
  if (input.tasks.some((t) => t.severity === "BLOCKING")) return "BLOCKED"
  if (!input.done) return "PENDING"
  if (input.tasks.some((t) => t.severity === "WARNING")) return "WARNING"
  return "COMPLETED"
}

/** Pasos completos (con o sin advertencias). El 4 solo cuenta al abrir. */
export function openingProgress(statuses: OpeningStepStatus[]) {
  const done = statuses.filter(
    (s) => s === "COMPLETED" || s === "WARNING"
  ).length
  return { done, total: statuses.length }
}

/** Paso sugerido: el primero que aún no está completo (o el último). */
export function suggestedOpeningStep(statuses: OpeningStepStatus[]) {
  const i = statuses.findIndex((s) => s === "BLOCKED" || s === "PENDING")
  return i === -1 ? statuses.length : i + 1
}
