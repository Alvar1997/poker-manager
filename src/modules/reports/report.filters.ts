import { z } from "zod"

/**
 * Filtros de reportes (Módulo 14). Se validan SIEMPRE en el servidor (API,
 * páginas y exportación usan el mismo schema). Viajan como URL search
 * params para que persistan al navegar entre listado y detalle.
 *
 * Las fechas son DÍAS OPERATIVOS (YYYY-MM-DD, zona del negocio). Nunca se
 * usa una sola fecha ambigua: el periodo general (`from`/`to`) aplica a la
 * fecha propia de cada reporte, y en créditos se distinguen la fecha de
 * ORIGEN de la deuda (`debtFrom`/`debtTo`) y la fecha REAL del abono
 * (`paymentFrom`/`paymentTo`).
 */

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

const day = z
  .string()
  .regex(DAY, "Fecha inválida (AAAA-MM-DD)")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Fecha inválida")
  .optional()
const id = z.string().regex(ID, "Identificador inválido").optional()
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v

export const PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "CARD_DEBIT",
  "CARD_CREDIT",
] as const

/** Estados aceptados por reporte (cada reporte valida los suyos). */
export const REPORT_STATUSES = {
  sessions: ["OPEN", "CLOSING", "CLOSED", "CANCELLED", "DRAFT", "PREPARATION"],
  tables: ["OPEN", "CLOSED"],
  purchases: [
    "DRAFT",
    "READY_FOR_DELIVERY",
    "CONFIRMED",
    "CANCELLED",
    "REVERSED",
  ],
  credits: ["OPEN", "PARTIALLY_PAID", "PAID"],
  payments: ["PENDING", "CONFIRMED", "REJECTED", "REVERSED"],
  settlements: [
    "DRAFT",
    "READY_FOR_CONFIRMATION",
    "PENDING_PAYOUT",
    "COMPLETED",
    "CANCELLED",
    "REVERSED",
  ],
  financial: [],
  chips: [],
  players: [],
  comparisons: [],
  dashboard: [],
} as const satisfies Record<string, readonly string[]>

export type ReportKind = keyof typeof REPORT_STATUSES
export const REPORT_KINDS = Object.keys(REPORT_STATUSES) as ReportKind[]

const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema)

export const reportFiltersSchema = z
  .object({
    from: opt(day),
    to: opt(day),
    sessionId: opt(id),
    tableId: opt(id),
    playerId: opt(id),
    method: opt(z.enum(PAYMENT_METHODS).optional()),
    status: opt(z.string().max(40).optional()),
    operatorId: opt(id),
    partnerId: opt(id),
    debtFrom: opt(day),
    debtTo: opt(day),
    paymentFrom: opt(day),
    paymentTo: opt(day),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
  })
  .superRefine((f, ctx) => {
    for (const [a, b] of [
      ["from", "to"],
      ["debtFrom", "debtTo"],
      ["paymentFrom", "paymentTo"],
    ] as const) {
      const x = f[a]
      const y = f[b]
      if (x && y && x > y)
        ctx.addIssue({
          code: "custom",
          path: [b],
          message: "La fecha final es anterior a la inicial",
        })
    }
  })

export type ReportFilters = z.output<typeof reportFiltersSchema>

/** Valida y, además, que `status` pertenezca al reporte. */
export function parseReportFilters(
  kind: ReportKind,
  raw: Record<string, string | string[] | undefined>
):
  | { ok: true; filters: ReportFilters }
  | { ok: false; issues: { path: string; message: string }[] } {
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  )
  const r = reportFiltersSchema.safeParse(flat)
  if (!r.success)
    return {
      ok: false,
      issues: r.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    }
  const allowed = REPORT_STATUSES[kind] as readonly string[]
  if (r.data.status && !allowed.includes(r.data.status))
    return {
      ok: false,
      issues: [
        { path: "status", message: "Estado no válido para este reporte" },
      ],
    }
  return { ok: true, filters: r.data }
}

/** Filtros por defecto (sin restricciones) para cuando la URL no es válida. */
export const DEFAULT_FILTERS: ReportFilters = { page: 1, pageSize: 25 }

/** Serializa filtros a query string (omite vacíos y la paginación por defecto). */
export function filtersToQuery(
  f: Partial<ReportFilters>,
  overrides: Partial<
    Record<keyof ReportFilters, string | number | undefined>
  > = {}
): string {
  const merged = { ...f, ...overrides } as Record<string, unknown>
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === "") continue
    if (k === "page" && Number(v) === 1) continue
    if (k === "pageSize" && Number(v) === 25) continue
    params.set(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ""
}

/** Descripción legible de los criterios (para el XLSX y la auditoría). */
export const FILTER_LABEL: Record<keyof ReportFilters, string> = {
  from: "Desde (día operativo)",
  to: "Hasta (día operativo)",
  sessionId: "Sesión",
  tableId: "Mesa",
  playerId: "Jugador",
  method: "Método de pago",
  status: "Estado",
  operatorId: "Usuario operador",
  partnerId: "Socio autorizador",
  debtFrom: "Origen de deuda desde",
  debtTo: "Origen de deuda hasta",
  paymentFrom: "Fecha de abono desde",
  paymentTo: "Fecha de abono hasta",
  page: "Página",
  pageSize: "Tamaño de página",
}

export function activeFilters(f: ReportFilters) {
  return (Object.keys(FILTER_LABEL) as (keyof ReportFilters)[])
    .filter((k) => k !== "page" && k !== "pageSize")
    .filter((k) => f[k] !== undefined && f[k] !== "")
    .map((k) => ({ key: k, label: FILTER_LABEL[k], value: String(f[k]) }))
}

/** Para páginas: filtros válidos o los predeterminados con los errores. */
export function pageFilters(
  kind: ReportKind,
  raw: Record<string, string | string[] | undefined>
): { filters: ReportFilters; issues: { path: string; message: string }[] } {
  const r = parseReportFilters(kind, raw)
  return r.ok
    ? { filters: r.filters, issues: [] }
    : { filters: DEFAULT_FILTERS, issues: r.issues }
}
