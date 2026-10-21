import type ExcelJS from "exceljs"

import { tzOffsetMinutes } from "@/modules/reports/report.math"

/**
 * Celdas del XLSX (Módulo 14). Puro y probado por unidad.
 *
 * Seguridad: ningún texto proveniente de usuarios (nombres, referencias,
 * motivos) se escribe de forma que Excel lo interprete como fórmula. Los
 * textos que empiezan con `= + - @`, tabulador o retorno se prefijan con un
 * apóstrofo y se eliminan caracteres de control. Las únicas fórmulas del
 * libro son los totales que genera el sistema (con su resultado ya
 * calculado por el servidor).
 */

const FORMULA_START = /^[=+\-@\t\r]/
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_TEXT = 32_000

export function safeText(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value).replace(CONTROL, "").slice(0, MAX_TEXT)
  return FORMULA_START.test(s) ? `'${s}` : s
}

/** Importe decimal en string → número para Excel (2 decimales exactos). */
export function moneyNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null
  return Math.round(Number(value) * 100) / 100
}

/**
 * Excel no guarda zona horaria: se escribe la hora LOCAL del negocio como
 * si fuera UTC, para que la celda muestre la hora de Monterrey.
 */
export function excelLocalDate(value: string | Date | null | undefined) {
  if (!value) return null
  const d = typeof value === "string" ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() + tzOffsetMinutes(d) * 60_000)
}

export const MONEY_FMT = '"$"#,##0.00;[Red]-"$"#,##0.00'
export const DATETIME_FMT = "dd/mm/yyyy hh:mm"
export const DATE_FMT = "dd/mm/yyyy"

export type ColumnType = "text" | "money" | "int" | "datetime" | "date" | "day"

export type Column<T> = {
  header: string
  type: ColumnType
  value: (row: T) => unknown
  width?: number
  /** Suma verificable al pie (fórmula SUM con el resultado del servidor). */
  total?: string
}

export function cellValue(type: ColumnType, raw: unknown): ExcelJS.CellValue {
  if (raw === null || raw === undefined || raw === "") return null
  switch (type) {
    case "money":
      return moneyNumber(String(raw))
    case "int":
      return Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : null
    case "datetime":
    case "date":
      return excelLocalDate(raw as string)
    case "day": {
      // Día operativo YYYY-MM-DD → fecha (sin hora, sin zona).
      const s = String(raw)
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null
    }
    default:
      return safeText(raw)
  }
}

export function columnFormat(type: ColumnType): string | undefined {
  if (type === "money") return MONEY_FMT
  if (type === "datetime") return DATETIME_FMT
  if (type === "date" || type === "day") return DATE_FMT
  if (type === "int") return "0"
  return undefined
}

/** Letra de columna Excel (1 → A, 27 → AA). */
export function columnLetter(n: number): string {
  let s = ""
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Nombre de hoja válido (≤31, sin `[]:*?/\`). */
export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31)
}
