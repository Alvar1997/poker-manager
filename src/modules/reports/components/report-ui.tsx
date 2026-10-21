import { Download, Info } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  filtersToQuery,
  type ReportFilters,
  type ReportKind,
} from "@/modules/reports/report.filters"

/**
 * Presentación de reportes (Módulo 14). Sin lógica financiera: solo
 * muestra cifras que ya calculó el servidor (strings decimales).
 */

export { REPORTS_BASE } from "@/modules/reports/components/report-tabs"

export function ReportHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

/** Descarga XLSX con los MISMOS filtros de la pantalla (sin CSV ni PDF). */
export function ExportButton({
  report,
  filters,
}: {
  report: ReportKind
  filters: Partial<ReportFilters>
}) {
  const q = filtersToQuery({ ...filters, page: 1 })
  const href = `/api/reports/export/xlsx?report=${report}${q ? `&${q.slice(1)}` : ""}`
  return (
    <a
      href={href}
      download
      data-testid="export-xlsx"
      className={cn(
        buttonVariants({ variant: "outline" }),
        "h-11 w-full sm:w-auto md:h-9"
      )}
    >
      <Download aria-hidden="true" />
      Exportar Excel (XLSX)
    </a>
  )
}

export function Stat({
  label,
  value,
  money = true,
  hint,
  testId,
  strong = false,
}: {
  label: string
  value: string | number | null
  money?: boolean
  hint?: string
  testId?: string
  strong?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          strong ? "text-lg font-semibold" : "font-medium"
        )}
        data-testid={testId}
      >
        {value === null
          ? "—"
          : money
            ? formatMXN(String(value))
            : String(value)}
      </dd>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
      {children}
    </dl>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground flex gap-2 rounded-lg border border-dashed p-3 text-xs">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function Money({ value }: { value: string | null | undefined }) {
  return <span className="tabular-nums">{formatMXN(value ?? null)}</span>
}

/** Tabla responsiva: desplazamiento horizontal dentro de su caja en móvil. */
export function DataTable({
  head,
  children,
  testId,
}: {
  head: string[]
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full min-w-[640px] text-sm" data-testid={testId}>
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            {head.map((h) => (
              <th key={h} className="px-2 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Td({
  children,
  num = false,
  className,
}: {
  children: ReactNode
  num?: boolean
  className?: string
}) {
  return (
    <td
      className={cn(
        "border-b px-2 py-2 align-top",
        num && "text-right whitespace-nowrap tabular-nums",
        className
      )}
    >
      {children}
    </td>
  )
}

/** Paginación con enlaces que CONSERVAN los filtros. */
export function Pagination({
  base,
  filters,
  page,
  pageSize,
  total,
}: {
  base: string
  filters: Partial<ReportFilters>
  page: number
  pageSize: number
  total: number
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1)
    return (
      <p className="text-muted-foreground text-xs" data-testid="page-info">
        {total} registro(s)
      </p>
    )
  const link = (p: number, label: string, disabled: boolean) =>
    disabled ? (
      <span className="text-muted-foreground px-3 py-2 text-sm">{label}</span>
    ) : (
      <Link
        href={`${base}${filtersToQuery(filters, { page: p })}`}
        className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
      >
        {label}
      </Link>
    )
  return (
    <div className="flex items-center justify-between gap-2">
      {link(page - 1, "Anterior", page <= 1)}
      <span className="text-muted-foreground text-xs" data-testid="page-info">
        Página {page} de {pages} · {total} registro(s)
      </span>
      {link(page + 1, "Siguiente", page >= pages)}
    </div>
  )
}

export const SESSION_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  PREPARATION: "Preparación",
  OPEN: "Abierta",
  CLOSING: "En cierre",
  CLOSED: "Cerrada",
  CANCELLED: "Cancelada",
}

export const DEBT_STATUS_LABEL: Record<string, string> = {
  OPEN: "Pendiente",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagada",
}

export const METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
  CARD_CREDIT: "Tarjeta de crédito",
}

export const PURCHASE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  READY_FOR_DELIVERY: "Lista para entregar",
  CONFIRMED: "Entregada",
  CANCELLED: "Cancelada",
  REVERSED: "Revertida",
}

export const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  READY_FOR_CONFIRMATION: "Lista para recibir",
  PENDING_PAYOUT: "Pendiente de pago",
  COMPLETED: "Completada",
  CANCELLED: "Cancelada",
  REVERSED: "Revertida",
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  REJECTED: "Rechazado",
  REVERSED: "Revertido",
}
