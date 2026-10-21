import type ExcelJS from "exceljs"

import {
  cellValue,
  columnFormat,
  columnLetter,
  safeText,
  sheetName,
  type Column,
} from "@/modules/reports/xlsx.cells"

/**
 * Constructores de hojas XLSX (Módulo 14). Sin acceso a la base: reciben
 * filas ya calculadas por los servicios de reportes.
 */

export function addTable<T>(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Column<T>[],
  rows: T[],
  opts: { title?: string; totalsLabel?: string } = {}
) {
  const ws = wb.addWorksheet(sheetName(name), {
    views: [{ state: "frozen", ySplit: opts.title ? 2 : 1 }],
  })
  let headerRow = 1
  if (opts.title) {
    ws.getCell(1, 1).value = safeText(opts.title)
    ws.getCell(1, 1).font = { bold: true, size: 12 }
    headerRow = 2
  }
  const header = ws.getRow(headerRow)
  columns.forEach((c, i) => {
    header.getCell(i + 1).value = safeText(c.header)
    ws.getColumn(i + 1).width =
      c.width ?? (c.type === "text" ? 22 : c.type === "money" ? 15 : 17)
    const fmtCode = columnFormat(c.type)
    if (fmtCode) ws.getColumn(i + 1).numFmt = fmtCode
  })
  header.font = { bold: true }
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE5E7EB" },
  }
  for (const row of rows) {
    ws.addRow(columns.map((c) => cellValue(c.type, c.value(row))))
  }
  const withTotals = columns.some((c) => c.total !== undefined)
  if (withTotals) {
    const first = headerRow + 1
    const last = headerRow + rows.length
    const totalRow = ws.addRow(
      columns.map((c, i) => {
        if (i === 0 && c.total === undefined)
          return safeText(opts.totalsLabel ?? "TOTAL")
        if (c.total === undefined) return null
        const result = Number(c.total)
        if (rows.length === 0) return result
        const col = columnLetter(i + 1)
        return { formula: `SUM(${col}${first}:${col}${last})`, result }
      })
    )
    totalRow.font = { bold: true }
  }
  if (rows.length)
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow, column: columns.length },
    }
  return ws
}

/** Hoja de pares etiqueta → valor (resúmenes). */
export function addKeyValues(
  wb: ExcelJS.Workbook,
  name: string,
  rows: { label: string; value: unknown; type?: "money" | "text" | "int" }[]
) {
  const ws = wb.addWorksheet(sheetName(name))
  ws.getColumn(1).width = 52
  ws.getColumn(2).width = 22
  ws.getRow(1).values = ["Concepto", "Valor"]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const t = r.type ?? "money"
    const row = ws.addRow([safeText(r.label), cellValue(t, r.value)])
    const fmtCode = columnFormat(t)
    if (fmtCode) row.getCell(2).numFmt = fmtCode
  }
  return ws
}
