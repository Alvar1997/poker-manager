"use client"

import { Loader2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
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
import {
  errorText,
  HistoricalBanner,
  StepComplete,
  type StepTone,
  useRefreshOnFocus,
  WizardHeader,
  WizardNav,
  WizardRow,
  WizardStepList,
  WizardTaskList,
} from "@/components/wizard/wizard-ui"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  AddSessionStaffForm,
  StaffTipRow,
} from "@/modules/staff-tips/components/staff-actions"

import type { WizardStepStatus } from "../closure-wizard.math"
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

/** Estado del paso → tono y texto (las piezas visuales son comunes). */
const STATUS: Record<WizardStepStatus, { label: string; tone: StepTone }> = {
  COMPLETED: { label: "Completo", tone: "done" },
  WARNING: { label: "Con advertencias", tone: "warning" },
  ERROR: { label: "Pendiente", tone: "error" },
  PENDING: { label: "Aún no disponible", tone: "idle" },
}

const Row = WizardRow

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
      <WizardHeader
        eyebrow="CIERRE DE JORNADA"
        title={`Sesión ${data.session.folio}`}
        statusText={
          data.session.status === "CLOSING"
            ? "En cierre"
            : data.session.status === "OPEN"
              ? "Abierta"
              : data.session.status === "CLOSED"
                ? "Cerrada"
                : data.session.status
        }
        done={data.progress.done}
        total={data.progress.total}
      />
      {data.session.isHistorical ? (
        <HistoricalBanner
          businessDate={data.session.businessDate}
          operatedOpenedAt={data.session.operatedOpenedAt}
        />
      ) : null}

      <WizardStepList
        label="Pasos del cierre"
        current={step}
        hrefFor={(n) => `${base}?paso=${n}`}
        steps={data.steps.map((x) => ({
          number: x.number,
          title: x.title,
          status: x.status,
          tone: STATUS[x.status].tone,
          summary:
            x.blocking > 0
              ? `${x.blocking} pendiente(s)`
              : x.warnings > 0
                ? `${x.warnings} advertencia(s)`
                : STATUS[x.status].label,
        }))}
      />

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
        <WizardTaskList
          tasks={s.tasks}
          onResolve={() =>
            saveClosureReturn({ url: returnUrl, folio: data.session.folio })
          }
        />
        {s.status === "COMPLETED" ? <StepComplete /> : null}
      </section>

      <WizardNav label="Navegación del cierre" step={step} total={6} go={go} />
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
  // Jornada histórica: fecha y hora OPERATIVA de cierre (local).
  const [closedAtLocal, setClosedAtLocal] = useState("")
  const historical = data.session.isHistorical
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
        {historical && data.session.operatedOpenedAt ? (
          <Row
            label="Apertura operativa"
            value={formatDateTime(data.session.operatedOpenedAt)}
          />
        ) : null}
        {data.session.openedAt ? (
          <Row
            label={historical ? "Apertura capturada" : "Apertura"}
            value={formatDateTime(data.session.openedAt)}
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
      {historical && canConfirm ? (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">
            Fecha y hora en que terminó la jornada (obligatoria)
          </span>
          <input
            type="datetime-local"
            className="border-input h-12 w-full rounded-lg border bg-transparent px-2.5 text-base"
            value={closedAtLocal}
            onChange={(e) => setClosedAtLocal(e.target.value.slice(0, 16))}
            data-testid="historical-closed-at"
          />
          <span className="text-muted-foreground block text-xs">
            Hora local. Debe ser posterior a la apertura operativa y no futura;
            la hora real de este registro queda en la auditoría.
          </span>
        </label>
      ) : null}
      {canConfirm ? (
        <Button
          className="h-12 w-full text-base"
          disabled={
            !data.canConfirm ||
            (data.noActivity && noActivityReason.trim().length < 5) ||
            (historical && closedAtLocal.length !== 16)
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
                        ...(historical
                          ? { operatedClosedAt: closedAtLocal }
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
