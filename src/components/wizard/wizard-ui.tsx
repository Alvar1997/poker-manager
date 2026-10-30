"use client"

import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Info,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, type ReactNode } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import { ApiClientError } from "@/lib/api-client"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { WizardTask } from "@/lib/wizard"
import { formatBusinessDateLong } from "@/modules/sessions/session-folio"

/**
 * Piezas visuales comunes de los asistentes guiados (apertura y cierre).
 * Solo presentan lo que calculó el servidor: aquí no hay reglas de negocio.
 * Los `data-testid` son los mismos en ambos asistentes.
 */

export type StepTone = "done" | "warning" | "error" | "idle"

const TONE: Record<StepTone, { icon: ReactNode; className: string }> = {
  done: {
    icon: <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />,
    className: "border-emerald-600/40",
  },
  warning: {
    icon: <AlertTriangle className="size-5 text-amber-600" aria-hidden />,
    className: "border-amber-500/60",
  },
  error: {
    icon: <XCircle className="text-destructive size-5" aria-hidden />,
    className: "border-destructive/50",
  },
  idle: {
    icon: <CircleDashed className="text-muted-foreground size-5" aria-hidden />,
    className: "",
  },
}

export function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

/** Recalcula al volver a la pestaña (p. ej. después de RESOLVER). */
export function useRefreshOnFocus() {
  const router = useRouter()
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [router])
}

export function WizardRow({
  label,
  value,
  strong,
  testId,
}: {
  label: string
  value: ReactNode
  strong?: boolean
  testId?: string
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 py-1 text-sm",
        strong && "font-semibold"
      )}
    >
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="text-right tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

export function WizardHeader({
  eyebrow,
  title,
  statusText,
  done,
  total,
}: {
  eyebrow: string
  title: string
  statusText: string
  done: number
  total: number
}) {
  const pct = Math.round((done / total) * 100)
  return (
    <header className="space-y-2 rounded-xl border p-3">
      <p className="text-muted-foreground text-xs font-semibold tracking-wide">
        {eyebrow}
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <span className="text-sm" data-testid="wizard-session-status">
          {statusText}
        </span>
      </div>
      <div>
        <div className="flex justify-between text-xs">
          <span data-testid="wizard-progress">
            Progreso: {done} de {total} pasos
          </span>
          <span>{pct}%</span>
        </div>
        <div
          className="bg-muted mt-1 h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="bg-primary h-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </header>
  )
}

export function WizardStepList({
  steps,
  current,
  hrefFor,
  label,
}: {
  steps: {
    number: number
    title: string
    status: string
    tone: StepTone
    summary: string
  }[]
  current: number
  hrefFor: (n: number) => string
  label: string
}) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2" aria-label={label}>
      {steps.map((x) => {
        const t = TONE[x.tone]
        return (
          <li key={x.number}>
            <Link
              href={hrefFor(x.number)}
              aria-current={x.number === current ? "step" : undefined}
              className={cn(
                "flex min-h-14 items-center gap-3 rounded-xl border p-3 text-left",
                t.className,
                x.number === current && "ring-primary ring-2"
              )}
              data-testid={`wizard-step-${x.number}`}
              data-status={x.status}
            >
              {t.icon}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {x.number}. {x.title}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {x.summary}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

/** Pendientes concretos con su botón RESOLVER (ruta real). */
export function WizardTaskList({
  tasks,
  onResolve,
}: {
  tasks: WizardTask[]
  onResolve?: () => void
}) {
  if (tasks.length === 0) return null
  return (
    <ul className="divide-y rounded-xl border" data-testid="wizard-tasks">
      {tasks.map((t, i) => (
        <li
          key={`${t.code}-${t.entity?.id ?? i}`}
          className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="wizard-task"
          data-code={t.code}
          data-severity={t.severity}
        >
          <div className="flex items-start gap-2">
            {t.severity === "BLOCKING" ? (
              <XCircle
                className="text-destructive mt-0.5 size-4 shrink-0"
                aria-hidden
              />
            ) : t.severity === "WARNING" ? (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600"
                aria-hidden
              />
            ) : (
              <Info
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
                aria-hidden
              />
            )}
            <div>
              {t.severity === "BLOCKING" ? (
                <p className="text-destructive text-xs font-semibold">
                  PENDIENTE
                </p>
              ) : null}
              <p className="text-sm font-medium">{t.title}</p>
              {t.detail ? (
                <p className="text-muted-foreground text-xs">{t.detail}</p>
              ) : null}
            </div>
          </div>
          {t.href ? (
            <Link
              href={t.href}
              onClick={onResolve}
              className={cn(
                buttonVariants({
                  variant: t.severity === "BLOCKING" ? "default" : "outline",
                }),
                "h-11 shrink-0"
              )}
              data-testid="wizard-resolve"
            >
              {t.actionLabel ?? "Resolver"}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function WizardNav({
  step,
  total,
  go,
  label,
}: {
  step: number
  total: number
  go: (n: number) => void
  label: string
}) {
  return (
    <nav className="flex gap-2" aria-label={label}>
      <Button
        variant="outline"
        className="h-12 flex-1"
        disabled={step <= 1}
        onClick={() => go(step - 1)}
        data-testid="wizard-prev"
      >
        <ChevronLeft /> Anterior
      </Button>
      <Button
        className="h-12 flex-1"
        disabled={step >= total}
        onClick={() => go(step + 1)}
        data-testid="wizard-next"
      >
        Siguiente <ChevronRight />
      </Button>
    </nav>
  )
}

export function StepComplete() {
  return (
    <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="size-4" aria-hidden /> Paso completo.
    </p>
  )
}

/**
 * Aviso fijo de JORNADA HISTÓRICA (capturada después) para no confundirla
 * con la jornada actual. Solo muestra datos del servidor.
 */
export function HistoricalBanner({
  businessDate,
  operatedOpenedAt,
  operatedClosedAt,
}: {
  businessDate: string
  operatedOpenedAt?: string | null
  operatedClosedAt?: string | null
}) {
  return (
    <div
      className="rounded-xl border-2 border-violet-500/60 bg-violet-500/10 p-3"
      role="note"
      data-testid="historical-banner"
    >
      <p className="text-xs font-semibold tracking-wide text-violet-800 dark:text-violet-300">
        JORNADA HISTÓRICA
      </p>
      <p className="text-lg font-semibold uppercase">
        {formatBusinessDateLong(businessDate)}
      </p>
      <p className="text-muted-foreground text-xs">
        {operatedOpenedAt
          ? `Apertura operativa: ${formatDateTime(operatedOpenedAt)}`
          : "Apertura operativa sin registrar"}
        {operatedClosedAt
          ? ` · Cierre operativo: ${formatDateTime(operatedClosedAt)}`
          : ""}
        . No es la jornada de hoy.
      </p>
    </div>
  )
}
