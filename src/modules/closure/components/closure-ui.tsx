import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Finding, ReadinessCheck } from "@/modules/closure/closure.math"
import { formatNominal } from "@/modules/inventory/components/format"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

/** Presentación del cierre (Módulo 12). Sin lógica financiera: solo muestra. */

export const closureBase = (sessionId: string) =>
  `${SESSIONS_BASE}/${sessionId}/cierre`

export const CLOSURE_STEPS = [
  { slug: "prevalidacion", label: "Prevalidación" },
  { slug: "propinas", label: "Propinas" },
  { slug: "inventario", label: "Arqueo de fichas" },
  { slug: "caja", label: "Arqueo de efectivo" },
  { slug: "diferencias", label: "Diferencias" },
  { slug: "retiro", label: "Retiro final" },
  { slug: "pendientes", label: "Pendientes" },
  { slug: "resumen", label: "Resumen y confirmación" },
] as const

export function ClosureNav({
  sessionId,
  current,
}: {
  sessionId: string
  current?: string
}) {
  return (
    <nav
      aria-label="Pasos del cierre"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ol className="flex gap-2 pb-1 text-xs">
        <li>
          <Link
            href={closureBase(sessionId)}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3 whitespace-nowrap",
              !current && "bg-primary text-primary-foreground"
            )}
          >
            Panel
          </Link>
        </li>
        {CLOSURE_STEPS.map((s) => (
          <li key={s.slug}>
            <Link
              href={`${closureBase(sessionId)}/${s.slug}`}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 whitespace-nowrap",
                current === s.slug && "bg-primary text-primary-foreground"
              )}
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  BLOCKING: "Bloquea",
  WARNING: "Advertencia",
  INFO: "Información",
}

export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0)
    return <p className="text-muted-foreground text-sm">Sin hallazgos.</p>
  return (
    <ul className="space-y-2" data-testid="closure-findings">
      {findings.map((f) => (
        <li
          key={f.code}
          data-testid={`finding-${f.code}`}
          data-severity={f.severity}
          className={cn(
            "flex gap-2 rounded-lg border p-3 text-sm",
            f.severity === "BLOCKING" &&
              "border-destructive/50 bg-destructive/5",
            f.severity === "WARNING" && "border-amber-500/50 bg-amber-500/5"
          )}
        >
          {f.severity === "BLOCKING" ? (
            <XCircle
              className="text-destructive mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          ) : f.severity === "WARNING" ? (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
          ) : (
            <Info
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">
              {f.title}{" "}
              <Badge
                variant="outline"
                className="ml-1 align-middle text-[10px]"
              >
                {SEVERITY_LABEL[f.severity]}
              </Badge>
            </p>
            <p className="text-muted-foreground break-words">{f.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ReadinessList({ checks }: { checks: ReadinessCheck[] }) {
  return (
    <ul className="space-y-1.5 text-sm" data-testid="closure-readiness">
      {checks.map((c) => (
        <li
          key={c.id}
          className="flex gap-2"
          data-testid={`check-${c.id}`}
          data-ok={c.ok ? "true" : "false"}
        >
          {c.ok ? (
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0 text-emerald-600"
              aria-hidden="true"
            />
          ) : (
            <XCircle
              className="text-destructive mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <span>
            {c.label}
            {c.message ? (
              <span className="text-muted-foreground block text-xs">
                {c.message}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Renglón etiqueta → importe. */
export function MoneyRow({
  label,
  value,
  testId,
  strong = false,
  hint,
}: {
  label: string
  value: string | null
  testId?: string
  strong?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground text-sm">
        {label}
        {hint ? <span className="block text-xs">{hint}</span> : null}
      </dt>
      <dd
        className={cn(
          "text-right tabular-nums",
          strong && "text-lg font-semibold"
        )}
        data-testid={testId}
      >
        {value === null ? "—" : formatNominal(value)}
      </dd>
    </div>
  )
}

/**
 * Las tres cifras de fichas que nunca se mezclan: diferencia física (A),
 * neto no retornado de la sesión (B) y circulación global (C).
 */
export function ChipFigures({
  physicalDifference,
  physicalStatus,
  sessionNetNotReturned,
  globalCirculation,
}: {
  physicalDifference: string | null
  physicalStatus: string
  sessionNetNotReturned: string
  globalCirculation: string
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div
        className={cn(
          "rounded-lg border p-3",
          physicalStatus === "SHORTAGE" || physicalStatus === "SURPLUS"
            ? "border-destructive/50 bg-destructive/5"
            : physicalStatus === "MATCH"
              ? "border-emerald-600/40"
              : ""
        )}
      >
        <p className="text-muted-foreground text-xs">
          Diferencia física de arqueo
        </p>
        <p
          className="text-lg font-semibold tabular-nums"
          data-testid="chip-physical-difference"
        >
          {physicalDifference === null
            ? "Sin contar"
            : formatNominal(physicalDifference)}
        </p>
        <p className="text-muted-foreground text-xs">
          Contado − esperado bajo custodia. Si no es $0, bloquea el cierre.
        </p>
      </div>
      <div className="rounded-lg border p-3">
        <p className="text-muted-foreground text-xs">
          Balance nominal de la sesión
        </p>
        <p
          className="text-lg font-semibold tabular-nums"
          data-testid="chip-session-outstanding"
        >
          {formatNominal(sessionNetNotReturned)}
        </p>
        <p className="text-muted-foreground text-xs">
          Entregado − devuelto en ambas mesas. Con todos los jugadores
          terminados debe ser $0: los resultados individuales se compensan entre
          jugadores. Si no es $0, se investiga antes de cerrar.
        </p>
      </div>
      <div className="rounded-lg border p-3">
        <p className="text-muted-foreground text-xs">Circulación global</p>
        <p
          className="text-lg font-semibold tabular-nums"
          data-testid="chip-global-circulation"
        >
          {formatNominal(globalCirculation)}
        </p>
        <p className="text-muted-foreground text-xs">
          Fichas fuera de custodia de todas las sesiones (continuo; canjeables
          solo con recepción física).
        </p>
      </div>
    </div>
  )
}
