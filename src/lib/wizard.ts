/**
 * Tipos comunes de los asistentes guiados (apertura y cierre de sesión).
 * Cada tarea la calcula el SERVIDOR con datos reales y trae la ruta REAL
 * para resolverla; la interfaz nunca marca pasos como completos.
 */

export type TaskSeverity = "BLOCKING" | "WARNING" | "INFO"

export type WizardTask = {
  /** Código estable (p. ej. CHIP_COUNT_MISSING). */
  code: string
  severity: TaskSeverity
  title: string
  detail?: string
  entity?: { type: string; id: string }
  /** Ruta REAL para resolverlo (o null si se resuelve dentro del paso). */
  href: string | null
  actionLabel?: string
}
