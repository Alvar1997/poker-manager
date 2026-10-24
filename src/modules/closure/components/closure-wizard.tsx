"use client"

import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Loader2,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  AddSessionStaffForm,
  StaffTipRow,
} from "@/modules/staff-tips/components/staff-actions"

import type { WizardStepStatus, WizardTask } from "../closure-wizard.math"
import type { ClosureWizardView } from "../closure-wizard.service"
import { StartClosingButton } from "./closure-actions"
import { saveClosureReturn } from "./closure-return-banner"

/**
 * Asistente de cierre en 6 pasos (Mobile First). Todo lo que muestra lo
 * calcula el servidor (`getClosureWizard`); aquí no hay lógica financiera
 * ni casillas que «completen» pasos. RESOLVER abre la pantalla real y deja
 * un aviso «Volver al cierre»; al volver (o al enfocar la pestaña) se
 * recalcula todo.
 */

const STATUS: Record<
  WizardStepStatus,
  { label: string; icon: ReactNode; className: string }
> = {
  COMPLETED: {
    label: "Completo",
    icon: <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />,
    className: "border-emerald-600/40",
  },
  WARNING: {
    label: "Con advertencias",
    icon: <AlertTriangle className="size-5 text-amber-600" aria-hidden />,
    className: "border-amber-500/60",
  },
  ERROR: {
    label: "Pendiente",
    icon: <XCircle className="text-destructive size-5" aria-hidden />,
    className: "border-destructive/50",
  },
  PENDING: {
    label: "Aún no disponible",
    icon: <CircleDashed className="text-muted-foreground size-5" aria-hidden />,
    className: "",
  },
}

function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

/** Recalcula al volver a la pestaña (p. ej. después de RESOLVER). */
function useRefreshOnFocus() {
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

function Row({
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

function TaskList({
  tasks,
  returnUrl,
  folio,
}: {
  tasks: WizardTask[]
  returnUrl: string
  folio: string
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
            ) : (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600"
                aria-hidden
              />
            )}
            <div>
              <p className="text-sm font-medium">{t.title}</p>
              {t.detail ? (
                <p className="text-muted-foreground text-xs">{t.detail}</p>
              ) : null}
            </div>
          </div>
          {t.href ? (
            <Link
              href={t.href}
              onClick={() => saveClosureReturn({ url: returnUrl, folio })}
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

export function ClosureWizard({
  data,
  step,
  staffOptions,
  canOperate,
  canConfirm,
}: {
  data: ClosureWizardView
  step: number
  staffOptions: { id: string; name: string; position: string }[]
  canOperate: boolean
  canConfirm: boolean
}) {
  useRefreshOnFocus()
  const router = useRouter()
  const s = data.steps[step - 1]
  const base = `/dashboard/sesiones/${data.session.id}/cierre`
  const returnUrl = `${base}?paso=${step}`
  const live =
    data.session.status === "OPEN" || data.session.status === "CLOSING"
  const pct = Math.round((data.progress.done / data.progress.total) * 100)

  // El paso actual se guarda en el servidor (persistencia al recargar).
  useEffect(() => {
    if (!live || !canOperate || data.currentStep === step) return
    void apiRequest(`/api/sessions/${data.session.id}/closure/wizard`, {
      method: "PATCH",
      body: { currentStep: step },
    }).catch(() => undefined)
  }, [step, live, canOperate, data.currentStep, data.session.id])
  useEffect(() => saveClosureReturn(null), [])

  const go = (n: number) => router.push(`${base}?paso=${n}`, { scroll: true })

  return (
    <div className="space-y-4" data-testid="closure-wizard">
      <header className="space-y-2 rounded-xl border p-3">
        <p className="text-muted-foreground text-xs font-semibold tracking-wide">
          CIERRE DE JORNADA
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">Sesión {data.session.folio}</h1>
          <span className="text-sm" data-testid="wizard-session-status">
            {data.session.status === "CLOSING"
              ? "En cierre"
              : data.session.status === "OPEN"
                ? "Abierta"
                : data.session.status === "CLOSED"
                  ? "Cerrada"
                  : data.session.status}
          </span>
        </div>
        <div>
          <div className="flex justify-between text-xs">
            <span data-testid="wizard-progress">
              Progreso: {data.progress.done} de {data.progress.total} pasos
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

      <ol className="grid gap-2 sm:grid-cols-2" aria-label="Pasos del cierre">
        {data.steps.map((x) => {
          const st = STATUS[x.status]
          return (
            <li key={x.id}>
              <Link
                href={`${base}?paso=${x.number}`}
                aria-current={x.number === step ? "step" : undefined}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-xl border p-3 text-left",
                  st.className,
                  x.number === step && "ring-primary ring-2"
                )}
                data-testid={`wizard-step-${x.number}`}
                data-status={x.status}
              >
                {st.icon}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {x.number}. {x.title}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {x.blocking > 0
                      ? `${x.blocking} pendiente(s)`
                      : x.warnings > 0
                        ? `${x.warnings} advertencia(s)`
                        : st.label}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ol>

      <section
        className="space-y-3 rounded-xl border p-3"
        data-testid={`wizard-panel-${s.id}`}
      >
        <div>
          <h2 className="text-base font-semibold">
            Paso {s.number}: {s.title}
          </h2>
          <p className="text-muted-foreground text-sm">{s.hint}</p>
        </div>
        <StepBody
          data={data}
          stepId={s.id}
          staffOptions={staffOptions}
          canOperate={canOperate && live}
          canConfirm={canConfirm}
        />
        <TaskList
          tasks={s.tasks}
          returnUrl={returnUrl}
          folio={data.session.folio}
        />
        {s.status === "COMPLETED" ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" aria-hidden /> Paso completo.
          </p>
        ) : null}
      </section>

      <nav className="flex gap-2" aria-label="Navegación del cierre">
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
          disabled={step >= 6}
          onClick={() => go(step + 1)}
          data-testid="wizard-next"
        >
          Siguiente <ChevronRight />
        </Button>
      </nav>
      <p className="text-center text-xs">
        <Link className="underline" href={`${base}/prevalidacion`}>
          Ver detalle técnico del cierre
        </Link>
      </p>
    </div>
  )
}

function StepBody({
  data,
  stepId,
  staffOptions,
  canOperate,
  canConfirm,
}: {
  data: ClosureWizardView
  stepId: ClosureWizardView["steps"][number]["id"]
  staffOptions: { id: string; name: string; position: string }[]
  canOperate: boolean
  canConfirm: boolean
}) {
  const id = data.session.id
  if (stepId === "players") {
    const p = data.players
    return (
      <dl className="bg-muted/40 rounded-lg p-3" data-testid="wizard-players">
        <Row label="Jugadores totales" value={p.total} />
        <Row
          label="Finalizados"
          value={p.finished}
          testId="wizard-players-finished"
        />
        <Row
          label="Pendientes"
          value={p.pending}
          strong
          testId="wizard-players-pending"
        />
        <Row label="OUT confirmados" value={p.outs} />
        <Row label="Cashout confirmados" value={p.cashouts} />
        {p.awaitingPayout > 0 ? (
          <Row
            label="Con pago pendiente (no bloquea)"
            value={p.awaitingPayout}
          />
        ) : null}
      </dl>
    )
  }
  if (stepId === "tables") {
    if (data.tables.length === 0)
      return (
        <p className="text-sm">
          No se abrió ninguna mesa en esta sesión: no hay rake que registrar.
        </p>
      )
    return (
      <ul className="space-y-2" data-testid="wizard-tables">
        {data.tables.map((t) => (
          <li
            key={t.tableId}
            className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            data-testid="wizard-table"
          >
            <div>
              <p className="font-medium">{t.name}</p>
              <p className="text-muted-foreground text-xs">
                {t.mode === "MANUAL" ? "Registro manual" : "Conteo final"} ·{" "}
                {t.open ? "Abierta" : "Cerrada"} · {t.movements} movimiento(s)
              </p>
            </div>
            <div className="text-right">
              <p
                className="font-semibold tabular-nums"
                data-testid="wizard-table-rake"
              >
                {formatMXN(t.rake)}
              </p>
              <Link className="text-xs underline" href={t.href}>
                Ver rake
              </Link>
            </div>
          </li>
        ))}
      </ul>
    )
  }
  if (stepId === "tips")
    return (
      <TipsStep
        data={data}
        staffOptions={staffOptions}
        canOperate={canOperate}
      />
    )
  if (stepId === "count") {
    const c = data.count
    return (
      <div className="space-y-3">
        {data.session.status === "OPEN" ? (
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            <p>
              Cuando todos los jugadores terminaron y las mesas están cerradas,
              inicia el cierre: se bloquean compras, mesas y liquidaciones
              nuevas, y ya puedes contar las fichas.
            </p>
            {canOperate ? (
              <StartClosingButton
                sessionId={id}
                disabled={
                  data.steps[0].blocking > 0 ||
                  data.steps[1].tasks.some((t) => t.code === "TABLE_OPEN")
                }
              />
            ) : null}
          </div>
        ) : null}
        {c ? (
          <dl className="bg-muted/40 rounded-lg p-3" data-testid="wizard-count">
            <Row
              label="Valor esperado (custodia)"
              value={formatMXN(c.expected)}
            />
            <Row
              label="Conteo físico"
              value={c.counted ? formatMXN(c.counted) : "—"}
              testId="wizard-count-counted"
            />
            <Row
              label="Diferencia física"
              value={c.difference ? formatMXN(c.difference) : "—"}
              strong
              testId="wizard-count-difference"
            />
            {c.confirmedAt ? (
              <Row
                label="Contó"
                value={`${c.confirmedBy ?? "—"} · ${new Date(c.confirmedAt).toLocaleString("es-MX")}`}
              />
            ) : null}
          </dl>
        ) : null}
        {data.session.status === "CLOSING" ? (
          <Link
            href={`/dashboard/sesiones/${id}/cierre/inventario`}
            onClick={() =>
              saveClosureReturn({
                url: `/dashboard/sesiones/${id}/cierre?paso=4`,
                folio: data.session.folio,
              })
            }
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-11 w-full"
            )}
            data-testid="wizard-open-count"
          >
            {c ? "Revisar o volver a contar" : "Contar fichas"}
          </Link>
        ) : null}
      </div>
    )
  }
  if (stepId === "reconciliation")
    return <ReconciliationStep data={data} canOperate={canOperate} />
  return <ConfirmStep data={data} canConfirm={canConfirm} />
}

function TipsStep({
  data,
  staffOptions,
  canOperate,
}: {
  data: ClosureWizardView
  staffOptions: { id: string; name: string; position: string }[]
  canOperate: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const assigned = new Set(data.tips.staff.map((s) => s.staff.id))
  const unconfirmed = data.tips.staff.filter(
    (s) => s.state !== "CONFIRMED"
  ).length
  return (
    <div className="space-y-3">
      {canOperate ? (
        <AddSessionStaffForm
          sessionId={data.session.id}
          staff={staffOptions.filter((s) => !assigned.has(s.id))}
        />
      ) : null}
      {data.tips.staff.length > 0 ? (
        <ul className="divide-y rounded-xl border" data-testid="staff-tips">
          {data.tips.staff.map((row) => (
            <StaffTipRow
              key={row.id}
              sessionId={data.session.id}
              row={row}
              editable={canOperate}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          No hay personal en la sesión.
        </p>
      )}
      <div className="flex items-baseline justify-between rounded-xl border p-3">
        <span className="font-semibold">TOTAL PROPINAS</span>
        <span
          className="text-lg font-semibold tabular-nums"
          data-testid="tips-total"
        >
          {formatMXN(data.tips.total)}
        </span>
      </div>
      {data.tips.reviewed ? (
        <p
          className="text-sm text-emerald-700 dark:text-emerald-400"
          data-testid="tips-reviewed"
        >
          Conteo del staff confirmado
          {data.tips.reviewedBy ? ` por ${data.tips.reviewedBy}` : ""}.
        </p>
      ) : canOperate ? (
        <Button
          className="h-12 w-full"
          disabled={pending || unconfirmed > 0}
          onClick={async () => {
            setPending(true)
            try {
              await apiRequest(
                `/api/sessions/${data.session.id}/closure/wizard/tips-review`,
                { method: "POST" }
              )
              toast.success("Conteo del staff confirmado")
              router.refresh()
            } catch (e) {
              toast.error(errorText(e))
            } finally {
              setPending(false)
            }
          }}
          data-testid="tips-review"
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          {unconfirmed > 0
            ? `Confirma primero a ${unconfirmed} empleado(s)`
            : "Confirmar: el conteo del staff está completo"}
        </Button>
      ) : null}
    </div>
  )
}

function ReasonField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  testId: string
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        rows={2}
        className="border-input w-full rounded-lg border bg-transparent px-2.5 py-2 text-base md:text-sm"
        placeholder="P. ej. posible ficha extraviada, propina no capturada, error de registro, origen pendiente de identificar"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  )
}

function ReconciliationStep({
  data,
  canOperate,
}: {
  data: ClosureWizardView
  canOperate: boolean
}) {
  const router = useRouter()
  const r = data.reconciliation
  const [nominal, setNominal] = useState(r.nominalReasonDraft)
  const [physical, setPhysical] = useState(r.physicalReasonDraft)
  const [pending, setPending] = useState(false)
  const dirty =
    nominal !== r.nominalReasonDraft || physical !== r.physicalReasonDraft
  return (
    <div className="space-y-3">
      <dl
        className="bg-muted/40 rounded-lg p-3"
        data-testid="wizard-reconciliation"
      >
        <Row
          label="Fichas entregadas"
          value={formatMXN(r.delivered)}
          testId="rec-delivered"
        />
        <Row
          label="Devueltas por jugadores"
          value={formatMXN(r.returnedByPlayers)}
          testId="rec-players"
        />
        <Row label="Rake" value={formatMXN(r.rake)} testId="rec-rake" />
        <Row label="Propinas" value={formatMXN(r.tips)} testId="rec-tips" />
        {/[1-9]/.test(r.otherReturns) ? (
          <Row
            label="Otros retornos registrados"
            value={formatMXN(r.otherReturns)}
          />
        ) : null}
        {/[1-9]/.test(r.authorizedUnrecovered) ? (
          <Row
            label="Diferencias autorizadas"
            value={formatMXN(r.authorizedUnrecovered)}
          />
        ) : null}
        <Row
          label="Diferencia nominal"
          value={
            r.status === "IN_PLAY"
              ? "En juego"
              : r.nominal
                ? r.nominal.text
                : "$0 · cuadra"
          }
          strong
          testId="rec-nominal"
        />
        <Row
          label="Diferencia del arqueo físico"
          value={
            data.count?.difference
              ? r.physical
                ? r.physical.text
                : "$0 · cuadra"
              : "Sin arqueo"
          }
          strong
          testId="rec-physical"
        />
      </dl>
      <p className="text-muted-foreground text-xs">
        Son dos comparaciones distintas y no se suman. Una diferencia NO impide
        cerrar: registra el motivo (lo que observaste; no se toma como causa
        comprobada). No se crean ajustes ni movimientos.
      </p>
      {canOperate && (r.nominal || r.physical) ? (
        <div className="space-y-2">
          {r.nominal ? (
            <ReasonField
              label="Motivo de la diferencia nominal"
              value={nominal}
              onChange={setNominal}
              testId="reason-nominal"
            />
          ) : null}
          {r.physical ? (
            <ReasonField
              label="Motivo de la diferencia física"
              value={physical}
              onChange={setPhysical}
              testId="reason-physical"
            />
          ) : null}
          <Button
            className="h-11 w-full"
            disabled={pending || !dirty}
            onClick={async () => {
              setPending(true)
              try {
                await apiRequest(
                  `/api/sessions/${data.session.id}/closure/wizard`,
                  {
                    method: "PATCH",
                    body: {
                      ...(r.nominal ? { nominalReason: nominal } : {}),
                      ...(r.physical ? { physicalReason: physical } : {}),
                    },
                  }
                )
                toast.success("Motivo guardado")
                router.refresh()
              } catch (e) {
                toast.error(errorText(e))
              } finally {
                setPending(false)
              }
            }}
            data-testid="reason-save"
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Guardar motivo
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ConfirmStep({
  data,
  canConfirm,
}: {
  data: ClosureWizardView
  canConfirm: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [noActivityReason, setNoActivityReason] = useState("")
  const [key, renew] = useIdempotencyKey()
  const sm = data.summary
  const r = data.reconciliation
  if (data.session.status === "CLOSED")
    return (
      <Link
        className={cn(buttonVariants(), "h-11 w-full")}
        href={`/dashboard/sesiones/${data.session.id}/cierre/comprobante`}
      >
        Ver comprobante de cierre
      </Link>
    )
  return (
    <div className="space-y-3">
      <dl className="bg-muted/40 rounded-lg p-3" data-testid="wizard-summary">
        <Row
          label="Sesión"
          value={`${data.session.folio} · ${data.session.businessDate}`}
        />
        {data.session.openedAt ? (
          <Row
            label="Apertura"
            value={new Date(data.session.openedAt).toLocaleString("es-MX")}
          />
        ) : null}
        <Row
          label="Mesas utilizadas"
          value={sm.tablesUsed.length ? sm.tablesUsed.join(", ") : "Ninguna"}
        />
        <Row
          label="Jugadores finalizados"
          value={`${data.players.finished} de ${data.players.total}`}
        />
        {data.tables.map((t) => (
          <Row
            key={t.tableId}
            label={`Rake ${t.name}`}
            value={formatMXN(t.rake)}
          />
        ))}
        <Row label="Propinas del staff" value={formatMXN(data.tips.total)} />
        <Row label="Fichas entregadas" value={formatMXN(r.delivered)} />
        <Row label="Fichas devueltas" value={formatMXN(r.returnedByPlayers)} />
        <Row
          label="Diferencia nominal"
          value={r.nominal ? r.nominal.text : "$0 · cuadra"}
          strong
        />
        <Row
          label="Inventario contado"
          value={data.count?.counted ? formatMXN(data.count.counted) : "—"}
        />
        <Row
          label="Diferencia física"
          value={r.physical ? r.physical.text : "$0 · cuadra"}
          strong
        />
        <Row
          label="Efectivo en caja (libro)"
          value={formatMXN(sm.cashExpected)}
        />
        {sm.withdrawal ? (
          <Row
            label="Retiro final"
            value={`${formatMXN(sm.withdrawal.amount)} · ${sm.withdrawal.recipient}`}
          />
        ) : null}
        <Row
          label="Deudas pendientes de jugadores"
          value={`${formatMXN(sm.debtsOutstanding)} (${sm.debtPlayers})`}
        />
        <Row
          label="Pagos pendientes de la casa"
          value={`${formatMXN(sm.payablesPending)} (${sm.payablePlayers})`}
        />
        {r.nominal && r.nominalReasonDraft ? (
          <Row label="Motivo (nominal)" value={r.nominalReasonDraft} />
        ) : null}
        {r.physical && r.physicalReasonDraft ? (
          <Row label="Motivo (física)" value={r.physicalReasonDraft} />
        ) : null}
      </dl>
      {data.canConfirm ? (
        <p
          className="rounded-lg border border-emerald-600/40 p-3 text-sm"
          data-testid="wizard-ready"
        >
          Todos los jugadores terminaron y se hicieron los conteos.
          {r.nominal
            ? ` Existe una diferencia nominal (${r.nominal.text}) documentada.`
            : ""}
          {r.physical
            ? ` Existe una diferencia física (${r.physical.text}) documentada.`
            : ""}{" "}
          La sesión puede cerrarse. Los créditos y pagos pendientes permanecerán
          registrados.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Resuelve los pendientes de los pasos marcados para poder cerrar.
        </p>
      )}
      {data.noActivity ? (
        <ReasonFieldNoActivity
          value={noActivityReason}
          onChange={setNoActivityReason}
        />
      ) : null}
      {canConfirm ? (
        <Button
          className="h-12 w-full text-base"
          disabled={
            !data.canConfirm ||
            (data.noActivity && noActivityReason.trim().length < 5)
          }
          onClick={() => setOpen(true)}
          data-testid="wizard-confirm"
        >
          CONFIRMAR CIERRE DE SESIÓN
        </Button>
      ) : null}
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿Cerrar definitivamente la sesión {data.session.folio}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Es irreversible: la sesión quedará CERRADA y no se podrá
              modificar. El servidor vuelve a validar todo antes de cerrar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <Button
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  await apiRequest(
                    `/api/sessions/${data.session.id}/closure/confirm`,
                    {
                      method: "POST",
                      body: {
                        idempotencyKey: key,
                        previewHash: data.previewHash,
                        ...(data.noActivity
                          ? { noActivityReason: noActivityReason.trim() }
                          : {}),
                      },
                    }
                  )
                  renew()
                  toast.success("Sesión cerrada")
                  router.push(
                    `/dashboard/sesiones/${data.session.id}/cierre/comprobante`
                  )
                } catch (e) {
                  const stale =
                    e instanceof ApiClientError &&
                    (e.details as { stale?: boolean } | undefined)?.stale
                  toast.error(
                    stale
                      ? "Hubo movimientos después de revisar el resumen: se recalculó; revísalo de nuevo."
                      : errorText(e)
                  )
                  setOpen(false)
                  router.refresh()
                } finally {
                  setPending(false)
                }
              }}
              data-testid="wizard-confirm-final"
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              Sí, cerrar la sesión
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ReasonFieldNoActivity({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">
        Motivo del cierre sin actividad (obligatorio)
      </span>
      <textarea
        rows={2}
        className="border-input w-full rounded-lg border bg-transparent px-2.5 py-2 text-base md:text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="no-activity-reason"
      />
    </label>
  )
}
