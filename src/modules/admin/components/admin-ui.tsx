import Link from "next/link"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Presentación del Módulo 15 (sin lógica: solo muestra lo que calculó el servidor). */

export const ADMIN_BASE = "/dashboard/administracion"

const TONE: Record<string, string> = {
  OK: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  HEALTHY: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  SUCCESS: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  PASSED: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  ACTIVE: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  EXECUTED: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  COMPLETED: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  RESOLVED: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  WARNING: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  DEGRADED: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  STALE: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  APPROVED: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  PARTIAL: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  NOT_CONFIGURED: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  NOT_EVALUATED: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  HIGH: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  ERROR: "border-destructive/60 text-destructive",
  FAILED: "border-destructive/60 text-destructive",
  FAILING: "border-destructive/60 text-destructive",
  VERIFICATION_FAILED: "border-destructive/60 text-destructive",
  UNAVAILABLE: "border-destructive/60 text-destructive",
  DOWN: "border-destructive/60 text-destructive",
  CRITICAL: "border-destructive/60 text-destructive",
  DENIED: "border-destructive/60 text-destructive",
  FAILURE: "border-destructive/60 text-destructive",
}

export function StatusBadge({
  value,
  label,
  testId,
}: {
  value: string
  label?: string
  testId?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("align-middle", TONE[value])}
      data-testid={testId}
      data-value={value}
    >
      {label ?? value}
    </Badge>
  )
}

export function PageHeader({
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

export function LinkButton({
  href,
  children,
  testId,
  variant = "outline",
}: {
  href: string
  children: ReactNode
  testId?: string
  variant?: "outline" | "default"
}) {
  return (
    <Link
      href={href}
      className={cn(
        buttonVariants({ variant }),
        "h-11 w-full sm:w-auto md:h-9"
      )}
      data-testid={testId}
    >
      {children}
    </Link>
  )
}

export function Table({
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
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <td className={cn("border-b px-2 py-2 align-top", className)}>
      {children}
    </td>
  )
}

export function KeyValue({
  label,
  children,
  testId,
}: {
  label: string
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

/** Enlace a la pantalla de la entidad afectada (cuando existe). */
export function entityHref(entityType: string | null, entityId: string | null) {
  if (!entityType || !entityId) return null
  switch (entityType) {
    case "ChipPurchase":
      return `/dashboard/compras/${entityId}`
    case "PokerSession":
      return `/dashboard/sesiones/${entityId}`
    case "Player":
      return `/dashboard/jugadores/${entityId}`
    case "ReceivablePayment":
      return `/dashboard/creditos/abonos/${entityId}`
    case "PlayerDebt":
      return `/dashboard/creditos/${entityId}`
    case "PlayerSettlement":
      return `/dashboard/liquidaciones/${entityId}`
    case "CorrectionRequest":
      return `${ADMIN_BASE}/correcciones/${entityId}`
    case "OperationalIncident":
      return `${ADMIN_BASE}/incidencias/${entityId}`
    case "IntegrityCheckRun":
      return `${ADMIN_BASE}/integridad/${entityId}`
    case "BackupExecution":
      return `${ADMIN_BASE}/respaldos/${entityId}`
    default:
      return null
  }
}

/** Tipo de corrección sugerido para una entidad (para «Solicitar corrección»). */
export function correctionTypeFor(entityType: string | null) {
  switch (entityType) {
    case "ChipPurchase":
      return "PURCHASE_REVERSAL"
    case "ReceivablePayment":
      return "RECEIVABLE_PAYMENT_REVERSAL"
    case "CashTransaction":
      return "CASH_MOVEMENT_REVERSAL"
    case "PlayerSettlement":
      return "SETTLEMENT_REVERSAL"
    default:
      return null
  }
}

export function Pager({
  base,
  query,
  page,
  pageSize,
  total,
}: {
  base: string
  query: Record<string, string | undefined>
  page: number
  pageSize: number
  total: number
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const href = (p: number) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(query))
      if (v && k !== "page") q.set(k, v)
    if (p > 1) q.set("page", String(p))
    const s = q.toString()
    return s ? `${base}?${s}` : base
  }
  return (
    <div
      className="flex items-center justify-between gap-2 text-xs"
      data-testid="admin-pager"
    >
      {page > 1 ? (
        <Link
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          href={href(page - 1)}
        >
          Anterior
        </Link>
      ) : (
        <span />
      )}
      <span className="text-muted-foreground">
        Página {page} de {pages} · {total} registro(s)
      </span>
      {page < pages ? (
        <Link
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          href={href(page + 1)}
        >
          Siguiente
        </Link>
      ) : (
        <span />
      )}
    </div>
  )
}
