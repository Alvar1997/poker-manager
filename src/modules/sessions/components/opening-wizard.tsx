"use client"

import { Info, Loader2, Plus, X } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  errorText,
  StepComplete,
  type StepTone,
  useRefreshOnFocus,
  HistoricalBanner,
  WizardHeader,
  WizardNav,
  WizardRow as Row,
  WizardStepList,
  WizardTaskList,
} from "@/components/wizard/wizard-ui"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatDateTime, localTimeOf } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { saveClosureReturn } from "@/modules/closure/components/closure-return-banner"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import { OpeningCashForm } from "@/modules/sessions/components/session-actions"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import type { OpeningStepStatus } from "@/modules/sessions/opening-wizard.math"
import type { OpeningWizardView } from "@/modules/sessions/opening-wizard.service"
import { formatBusinessDateMx } from "@/modules/sessions/session-folio"

/**
 * Asistente de apertura en 4 pasos (Mobile First). Todo lo que muestra lo
 * calcula el servidor (`getOpeningWizard`); aquí no hay reglas de negocio
 * ni casillas que «completen» pasos. RESOLVER abre la pantalla real (p. ej.
 * el arqueo de fichas) y deja «Volver a la apertura»; al volver se
 * recalcula todo.
 */

const STATUS: Record<OpeningStepStatus, { label: string; tone: StepTone }> = {
  COMPLETED: { label: "Completo", tone: "done" },
  WARNING: { label: "Con advertencias", tone: "warning" },
  BLOCKED: { label: "Falta para abrir", tone: "error" },
  PENDING: { label: "Pendiente", tone: "idle" },
}

const textareaClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"

export function OpeningWizard({
  data,
  step,
  canOperate,
  canHistorical,
  custodyTotal,
}: {
  data: OpeningWizardView
  step: number
  /** Creador (o SUPERADMIN) con la sesión en borrador o preparación. */
  canOperate: boolean
  /** SUPERADMIN: puede corregir la hora operativa de una jornada histórica. */
  canHistorical: boolean
  /** Efectivo administrativo en custodia (no es parte de la caja). */
  custodyTotal: string
}) {
  useRefreshOnFocus()
  const router = useRouter()
  const s = data.steps[step - 1]
  const id = data.session.id
  const base = `${SESSIONS_BASE}/${id}/apertura`
  const returnUrl = `${base}?paso=${step}`

  // El paso actual se guarda en el servidor (persistencia al recargar).
  useEffect(() => {
    if (!canOperate || data.currentStep === step) return
    void apiRequest(`/api/sessions/${id}/opening/wizard`, {
      method: "PATCH",
      body: { currentStep: step },
    }).catch(() => undefined)
  }, [step, canOperate, data.currentStep, id])
  useEffect(() => saveClosureReturn(null), [])

  const go = (n: number) => router.push(`${base}?paso=${n}`, { scroll: true })

  return (
    <div className="space-y-4" data-testid="opening-wizard">
      <WizardHeader
        eyebrow="APERTURA DE JORNADA"
        title={`Jornada ${data.session.folio}`}
        statusText={data.session.statusLabel}
        done={data.progress.done}
        total={data.progress.total}
      />
      {data.session.isHistorical ? (
        <HistoricalBanner
          businessDate={data.session.businessDate}
          operatedOpenedAt={data.session.operatedOpenedAt}
        />
      ) : null}

      {!data.session.canManagePreparation ? (
        <p
          className="flex items-start gap-2 rounded-lg border p-3 text-sm"
          data-testid="read-only-preparation"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Solo {data.session.createdBy.name} (quien creó la jornada) o un
          superadministrador pueden continuar esta preparación. Puedes consultar
          su avance.
        </p>
      ) : null}

      <WizardStepList
        label="Pasos de la apertura"
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
              : x.id === "confirm" && data.canOpen
                ? "Listo para abrir"
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
          canOperate={canOperate}
          canHistorical={canHistorical}
          custodyTotal={custodyTotal}
          go={go}
        />
        <WizardTaskList
          tasks={s.tasks}
          onResolve={() =>
            saveClosureReturn({
              url: returnUrl,
              folio: data.session.folio,
              label: "Volver a la apertura",
            })
          }
        />
        {s.status === "COMPLETED" ? <StepComplete /> : null}
      </section>

      <WizardNav
        label="Navegación de la apertura"
        step={step}
        total={4}
        go={go}
      />
    </div>
  )
}

function StepBody({
  data,
  stepId,
  canOperate,
  canHistorical,
  custodyTotal,
  go,
}: {
  data: OpeningWizardView
  stepId: OpeningWizardView["steps"][number]["id"]
  canOperate: boolean
  canHistorical: boolean
  custodyTotal: string
  go: (n: number) => void
}) {
  if (stepId === "session")
    return (
      <SessionStep
        data={data}
        canOperate={canOperate}
        canHistorical={canHistorical}
        go={go}
      />
    )
  if (stepId === "chips") return <ChipsStep data={data} />
  if (stepId === "tables")
    return <TablesStep data={data} canOperate={canOperate} go={go} />
  return (
    <ConfirmStep
      data={data}
      canOperate={canOperate}
      custodyTotal={custodyTotal}
    />
  )
}

function SessionStep({
  data,
  canOperate,
  canHistorical,
  go,
}: {
  data: OpeningWizardView
  canOperate: boolean
  canHistorical: boolean
  go: (n: number) => void
}) {
  const router = useRouter()
  const ses = data.session
  const [notes, setNotes] = useState(ses.notes ?? "")
  const savedTime = ses.operatedOpenedAt
    ? localTimeOf(ses.operatedOpenedAt)
    : ""
  const [time, setTime] = useState(savedTime)
  const [pending, setPending] = useState(false)
  const editTime = ses.isHistorical && canOperate && canHistorical
  const timeDirty = editTime && time !== savedTime && time.length === 5
  const dirty = notes.trim() !== (ses.notes ?? "") || timeDirty

  async function save(start: boolean) {
    setPending(true)
    try {
      if (dirty)
        await apiRequest(`/api/sessions/${ses.id}/opening/wizard`, {
          method: "PATCH",
          body: {
            notes: notes.trim(),
            ...(timeDirty ? { openingTime: time } : {}),
          },
        })
      if (start)
        await apiRequest(`/api/sessions/${ses.id}/prepare`, { method: "POST" })
      toast.success(start ? "Jornada guardada en preparación" : "Guardado")
      if (start) go(2)
      router.refresh()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <dl className="bg-muted/40 rounded-lg p-3" data-testid="opening-session">
        <Row label="Folio" value={ses.folio} testId="opening-folio" />
        <Row
          label="Fecha operativa"
          value={formatBusinessDateMx(ses.businessDate)}
        />
        <Row label="Responsable" value={ses.createdBy.name} />
        <Row label="Creada" value={formatDateTime(ses.createdAt)} />
        <Row label="Estado" value={ses.statusLabel} />
        <Row
          label="Modalidad"
          value={ses.isHistorical ? "Jornada histórica" : "Nueva jornada"}
          testId="opening-mode"
        />
        <Row label="Caja central inicial" value={formatMXN("0.00")} />
        {ses.isHistorical ? (
          <Row
            label="Apertura operativa"
            value={
              ses.operatedOpenedAt ? formatDateTime(ses.operatedOpenedAt) : "—"
            }
            testId="opening-operated-at"
          />
        ) : (
          <Row label="Hora de apertura" value="Se registra al abrir" />
        )}
      </dl>
      {editTime ? (
        <div className="space-y-1">
          <Label htmlFor="opening-time">
            Hora de apertura de la jornada (hora local)
          </Label>
          <input
            id="opening-time"
            type="time"
            className="border-input h-12 w-full rounded-lg border bg-transparent px-2.5 text-base"
            value={time}
            onChange={(e) => setTime(e.target.value.slice(0, 5))}
            data-testid="opening-time"
          />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        No se pide fondo inicial, rake, propinas ni jugadores: eso se registra
        con la jornada abierta.
      </p>
      {canOperate ? (
        <div className="space-y-1">
          <Label htmlFor="opening-notes">Observación (opcional)</Label>
          <textarea
            id="opening-notes"
            rows={2}
            maxLength={500}
            className={textareaClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="opening-notes"
          />
        </div>
      ) : ses.notes ? (
        <p className="text-sm">Observación: {ses.notes}</p>
      ) : null}
      {canOperate && ses.status === "DRAFT" ? (
        <Button
          className="h-12 w-full text-base"
          disabled={pending}
          onClick={() => save(true)}
          data-testid="opening-start"
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          GUARDAR Y CONTINUAR
        </Button>
      ) : canOperate && dirty ? (
        <Button
          variant="outline"
          className="h-11 w-full"
          disabled={pending}
          onClick={() => save(false)}
          data-testid="opening-notes-save"
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          Guardar cambios
        </Button>
      ) : null}
    </div>
  )
}

const COUNT_STATUS: Record<string, string> = {
  DRAFT: "En captura",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
}

function ChipsStep({ data }: { data: OpeningWizardView }) {
  const c = data.chipCount
  if (!c)
    return (
      <p className="text-sm" data-testid="opening-no-count">
        Aún no se ha contado el inventario de fichas para esta jornada. Un solo
        conteo cubre todas las mesas: el inventario es compartido.
      </p>
    )
  const diff = c.differenceTotal !== "0.00" && c.status === "CONFIRMED"
  return (
    <div className="space-y-3">
      <dl className="bg-muted/40 rounded-lg p-3" data-testid="opening-count">
        <Row
          label="Estado del conteo"
          value={
            c.reconciliationStatus === "RECONCILED"
              ? "Confirmado y conciliado"
              : (COUNT_STATUS[c.status] ?? c.status)
          }
          testId="opening-count-status"
        />
        <Row label="Contó" value={c.countedBy?.name ?? "—"} />
        {c.confirmedBy ? (
          <Row label="Confirmó" value={c.confirmedBy.name} />
        ) : null}
        <Row label="Inventario esperado" value={formatMXN(c.expectedTotal)} />
        <Row
          label="Valor nominal contado"
          value={formatMXN(c.countedTotal)}
          strong
          testId="opening-count-total"
        />
        {diff ? (
          <Row
            label="Diferencia inicial"
            value={formatMXN(c.differenceTotal)}
            testId="opening-count-diff"
          />
        ) : null}
      </dl>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {c.details.map((d) => (
          <li
            key={d.denominationId}
            className="rounded-lg border p-2 text-xs"
            data-testid="opening-denomination"
          >
            <p className="font-medium">
              {formatMXN(d.unitValue)}
              {d.name ? ` · ${d.name}` : ""}
            </p>
            <p className="text-muted-foreground">
              {d.countedQuantity ?? "—"} fichas (esperadas {d.expectedQuantity})
            </p>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        El valor nominal de las fichas no es dinero en caja.
      </p>
    </div>
  )
}

function TablesStep({
  data,
  canOperate,
  go,
}: {
  data: OpeningWizardView
  canOperate: boolean
  go: (n: number) => void
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const id = data.session.id
  const editable = canOperate && data.session.status === "PREPARATION"
  const t = data.tables

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setPending(key)
    try {
      await fn()
      toast.success(ok)
      router.refresh()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      {t.planned.length > 0 ? (
        <ul className="space-y-2" data-testid="opening-planned-tables">
          {t.planned.map((p) => (
            <li
              key={p.tableId}
              className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              data-testid="opening-planned-table"
              data-table={p.code}
            >
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-xs">
                  Ciegas {formatMXN(p.blinds.small)} / {formatMXN(p.blinds.big)}{" "}
                  · se abre al confirmar
                </p>
                {p.problem ? (
                  <p className="text-destructive text-xs">{p.problem}</p>
                ) : null}
              </div>
              {editable ? (
                <Button
                  variant="outline"
                  className="h-11 shrink-0"
                  disabled={pending !== null}
                  onClick={() =>
                    run(
                      p.tableId,
                      () =>
                        apiRequest(
                          `/api/sessions/${id}/opening/tables/${p.tableId}/remove`,
                          { method: "POST" }
                        ),
                      `${p.name} quitada de la preparación`
                    )
                  }
                  data-testid="opening-remove-table"
                >
                  {pending === p.tableId ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <X />
                  )}
                  Quitar
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : t.noTablesConfirmed ? (
        <p
          className="rounded-lg border p-3 text-sm"
          data-testid="opening-no-tables-chosen"
        >
          Elegiste abrir sin mesas. Podrás agregarlas con la jornada abierta.
        </p>
      ) : null}

      {editable && t.available.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {t.available.map((a) => (
            <Button
              key={a.tableId}
              variant="outline"
              className="h-12 justify-start"
              disabled={pending !== null}
              onClick={() =>
                run(
                  a.tableId,
                  () =>
                    apiRequest(`/api/sessions/${id}/opening/tables`, {
                      method: "POST",
                      body: { tableId: a.tableId },
                    }),
                  `${a.name} agregada`
                )
              }
              data-testid="opening-add-table"
              data-table={a.code}
            >
              {pending === a.tableId ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              Agregar {a.name}
            </Button>
          ))}
        </div>
      ) : null}
      {editable && t.available.length === 0 && t.planned.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No hay mesas activas en el catálogo.{" "}
          <Link className="underline" href="/dashboard/configuracion/mesas">
            Configurar mesas
          </Link>
        </p>
      ) : null}

      {editable && t.planned.length === 0 && !t.noTablesConfirmed ? (
        <Button
          className="h-12 w-full"
          variant="secondary"
          disabled={pending !== null}
          onClick={() =>
            run(
              "none",
              async () => {
                await apiRequest(`/api/sessions/${id}/opening/wizard`, {
                  method: "PATCH",
                  body: { noTables: true },
                })
                go(4)
              },
              "Continuarás sin mesas"
            )
          }
          data-testid="opening-no-tables"
        >
          Continuar sin mesas
        </Button>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Agregar una mesa no mueve fichas ni dinero: todas usan el mismo
        inventario y la misma caja central.
      </p>
    </div>
  )
}

function ConfirmStep({
  data,
  canOperate,
  custodyTotal,
}: {
  data: OpeningWizardView
  canOperate: boolean
  custodyTotal: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const ses = data.session
  const c = data.chipCount
  const needsCash =
    canOperate &&
    ses.status === "PREPARATION" &&
    data.steps[3].tasks.some((t) => t.code.startsWith("CASH_"))
  const blockers = data.blockers.filter((b) => b.step !== 4)

  async function openSession() {
    setPending(true)
    try {
      await apiRequest(`/api/sessions/${ses.id}/open`, {
        method: "POST",
        body: { idempotencyKey: key, previewHash: data.previewHash },
      })
      renew()
      setOpen(false)
      toast.success(`Jornada ${ses.folio} abierta`)
      router.push(`${SESSIONS_BASE}/${ses.id}`)
    } catch (e) {
      setOpen(false)
      toast.error(
        e instanceof ApiClientError && e.status === 409
          ? "La preparación cambió: revisa el resumen actualizado."
          : errorText(e)
      )
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <dl className="bg-muted/40 rounded-lg p-3" data-testid="opening-summary">
        <Row label="Jornada" value={ses.folio} />
        <Row
          label="Preparación iniciada"
          value={
            ses.preparationStartedAt
              ? formatDateTime(ses.preparationStartedAt)
              : "—"
          }
        />
        <Row label="Responsable" value={ses.createdBy.name} />
        <Row
          label="Conteo físico inicial"
          value={
            data.steps[1].status === "COMPLETED" ||
            data.steps[1].status === "WARNING"
              ? `Confirmado${c?.confirmedBy ? ` por ${c.confirmedBy.name}` : ""}`
              : "Pendiente"
          }
          testId="opening-summary-count"
        />
        <Row
          label="Valor nominal de las fichas"
          value={c ? formatMXN(c.countedTotal) : "—"}
        />
        <Row
          label="Mesas preparadas"
          value={
            data.tables.planned.length === 0
              ? "0 (se agregan después)"
              : `${data.tables.planned.length}: ${data.tables.planned.map((t) => t.name).join(", ")}`
          }
          testId="opening-summary-tables"
        />
        <Row
          label="Caja central inicial"
          value={formatMXN(data.cash.openingAmount)}
          strong
          testId="opening-summary-cash"
        />
        <Row label="Fecha y hora de apertura" value="Se registran al abrir" />
      </dl>

      {needsCash ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Caja física: debe estar vacía</p>
          {custodyTotal !== "0.00" ? (
            <p
              className="rounded-lg border border-amber-500/50 p-2 text-xs"
              role="note"
              data-testid="custody-segregation"
            >
              Hay {formatMXN(custodyTotal)} de efectivo administrativo en
              custodia (abonos fuera de sesión). No es parte de esta caja:
              sepáralo antes de contar.
            </p>
          ) : null}
          <OpeningCashForm sessionId={ses.id} />
        </div>
      ) : data.cash.confirmed ? (
        <p className="text-sm" data-testid="cash-zero-done">
          Caja confirmada en $0.00
          {data.cash.confirmedBy ? ` por ${data.cash.confirmedBy.name}` : ""}.
        </p>
      ) : null}

      {blockers.length > 0 ? (
        <ul className="space-y-2" data-testid="opening-blockers">
          {blockers.map((b, i) => (
            <li
              key={`${b.code}-${i}`}
              className="border-destructive/40 flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              data-testid="opening-blocker"
              data-code={b.code}
            >
              <span>{b.title}</span>
              <Link
                className="shrink-0 text-xs font-medium underline"
                href={`${SESSIONS_BASE}/${ses.id}/apertura?paso=${b.step}`}
              >
                Ir al paso {b.step}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {ses.status === "PREPARATION" || ses.status === "DRAFT" ? (
        <Button
          className="h-14 w-full text-base font-semibold"
          disabled={!data.canOpen || !canOperate}
          onClick={() => setOpen(true)}
          data-testid="wizard-open"
        >
          ABRIR JORNADA
        </Button>
      ) : null}

      <AlertDialog
        open={open}
        onOpenChange={(o) => !o && !pending && setOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Abrir la jornada {ses.folio}?</AlertDialogTitle>
            <AlertDialogDescription>
              La caja central inicia en $0.00 y la hora de apertura la registra
              el servidor.{" "}
              {data.tables.planned.length === 0
                ? "Se abre sin mesas; podrás agregarlas después."
                : `Se abrirán ${data.tables.planned.length} mesa(s).`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Volver</AlertDialogCancel>
            <Button
              disabled={pending}
              onClick={openSession}
              data-testid="wizard-open-final"
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              ABRIR JORNADA
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
