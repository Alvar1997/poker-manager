import { createHash } from "node:crypto"

/**
 * Núcleo PURO del motor de integridad (Módulo 15). Solo diagnostica: no
 * repara, no crea movimientos y nunca convierte en OK una comprobación que
 * no pudo ejecutarse (queda NOT_EVALUATED).
 */

export type IntegrityStatusValue = "OK" | "WARNING" | "ERROR" | "NOT_EVALUATED"
export type SeverityValue = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export type CheckResult = {
  checkCode: string
  category: string
  status: IntegrityStatusValue
  severity: SeverityValue
  entityType?: string | null
  entityId?: string | null
  expected?: string | null
  actual?: string | null
  difference?: string | null
  explanation: string
  references?: Record<string, unknown> | null
}

export type CheckDefinition = {
  code: string
  category: string
  title: string
  run: () => Promise<CheckResult[]>
}

export function fingerprintOf(r: {
  checkCode: string
  entityType?: string | null
  entityId?: string | null
}) {
  return createHash("sha256")
    .update(`${r.checkCode}|${r.entityType ?? ""}|${r.entityId ?? ""}`)
    .digest("hex")
    .slice(0, 40)
}

/** Ejecuta una comprobación: cualquier fallo técnico → NOT_EVALUATED. */
export async function safeRun(def: CheckDefinition): Promise<CheckResult[]> {
  try {
    const results = await def.run()
    if (results.length === 0)
      return [
        {
          checkCode: def.code,
          category: def.category,
          status: "OK",
          severity: "INFO",
          explanation: def.title,
        },
      ]
    return results
  } catch (error) {
    return [
      {
        checkCode: def.code,
        category: def.category,
        status: "NOT_EVALUATED",
        severity: "MEDIUM",
        explanation: `${def.title}: no se pudo evaluar (${
          error instanceof Error ? error.message.slice(0, 200) : "error"
        }).`,
      },
    ]
  }
}

export function summarize(results: CheckResult[]) {
  const checks = new Map<string, IntegrityStatusValue>()
  const rank: Record<IntegrityStatusValue, number> = {
    OK: 0,
    WARNING: 1,
    NOT_EVALUATED: 2,
    ERROR: 3,
  }
  for (const r of results) {
    const prev = checks.get(r.checkCode)
    if (!prev || rank[r.status] > rank[prev]) checks.set(r.checkCode, r.status)
  }
  const count = (s: IntegrityStatusValue) =>
    [...checks.values()].filter((v) => v === s).length
  return {
    checks: checks.size,
    ok: count("OK"),
    warning: count("WARNING"),
    error: count("ERROR"),
    notEvaluated: count("NOT_EVALUATED"),
    findings: results.filter((r) => r.status !== "OK").length,
    critical: results.filter(
      (r) => r.status === "ERROR" && r.severity === "CRITICAL"
    ).length,
    overall:
      count("ERROR") > 0
        ? "ERROR"
        : count("NOT_EVALUATED") > 0
          ? "NOT_EVALUATED"
          : count("WARNING") > 0
            ? "WARNING"
            : "OK",
  }
}

/**
 * Solo los ERROR de severidad HIGH/CRITICAL generan incidencia automática.
 * Las obligaciones pendientes legítimas o las fichas en circulación son
 * INFO/OK y nunca abren incidencias.
 */
export function shouldOpenIncident(r: CheckResult) {
  return (
    r.status === "ERROR" && (r.severity === "HIGH" || r.severity === "CRITICAL")
  )
}

export function incidentSeverityOf(
  r: CheckResult
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (r.severity === "CRITICAL") return "CRITICAL"
  if (r.severity === "HIGH") return "HIGH"
  if (r.severity === "MEDIUM") return "MEDIUM"
  return "LOW"
}

export const CATEGORY_LABEL: Record<string, string> = {
  CASH: "Caja",
  PURCHASES: "Compras",
  DEBTS: "Deudas y abonos",
  SETTLEMENTS: "Liquidaciones",
  INVENTORY: "Inventario de fichas",
  BANK: "Banco y terminal",
  EVIDENCE: "Evidencias",
  AUDIT: "Auditoría",
  SPECIAL_OPERATIONS: "Operaciones especiales",
}
