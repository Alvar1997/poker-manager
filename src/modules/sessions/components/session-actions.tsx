"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import {
  formatBusinessDateMx,
  HISTORICAL_MIN_DATE,
} from "@/modules/sessions/session-folio"

const textareaClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"

function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

/** Día anterior a una fecha YYYY-MM-DD (para el máximo del selector). */
function previousDay(day: string) {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * Crear sesión. El servidor asigna folio (S-0001-AAAAMMDD), consecutivo,
 * creador y fechas reales. SUPERADMIN puede crear una sesión de una FECHA
 * ANTERIOR (el servidor revalida permiso y fecha): sigue la misma apertura,
 * operación y cierre que una de hoy. La vista previa del folio es
 * provisional: el definitivo llega en la respuesta.
 */
export function CreateSessionForm({
  today,
  canHistorical,
  initialHistorical = false,
  activeSession,
}: {
  today: string
  canHistorical: boolean
  initialHistorical?: boolean
  activeSession: { id: string; folio: string } | null
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [historical, setHistorical] = useState(initialHistorical)
  const [businessDate, setBusinessDate] = useState("")
  const [openingTime, setOpeningTime] = useState("")
  const [notes, setNotes] = useState("")
  const [created, setCreated] = useState(false)
  const [error, setError] = useState<{
    message: string
    activeId: string | null
  } | null>(null)
  const maxDate = previousDay(today)
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(businessDate) &&
    businessDate <= maxDate &&
    businessDate >= HISTORICAL_MIN_DATE
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(openingTime)
  const previewDate = historical ? (validDate ? businessDate : null) : today
  const preview = useQuery({
    queryKey: ["session-folio-preview", previewDate],
    queryFn: () =>
      apiRequest<{
        folio: string
        nextSequenceNumber: number
        sameDay: { folio: string; status: string }[]
      }>(`/api/sessions/folio-preview?businessDate=${previewDate}`),
    enabled: previewDate !== null && !created,
  })
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; folio: string; isHistorical: boolean }>(
        "/api/sessions",
        {
          method: "POST",
          body: historical
            ? {
                idempotencyKey: key,
                historical: true,
                businessDate,
                openingTime,
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              }
            : { idempotencyKey: key },
        }
      ),
    onSuccess: (s) => {
      renew()
      setCreated(true)
      toast.success(`Sesión ${s.folio} creada`)
      router.push(`${SESSIONS_BASE}/${s.id}/apertura`)
    },
    onError: (e) => {
      const activeId =
        e instanceof ApiClientError
          ? ((e.details as { activeSessionId?: string } | undefined)
              ?.activeSessionId ?? null)
          : null
      setError({
        message: errorMessage(e, "No se pudo crear la sesión"),
        activeId,
      })
    },
  })

  const blockedByActive = activeSession !== null
  const ready =
    !mutation.isPending &&
    !blockedByActive &&
    (!historical || (validDate && validTime))
  const sameDay = historical ? (preview.data?.sameDay ?? []) : []
  return (
    <div className="space-y-4">
      {canHistorical ? (
        // Solo SUPERADMIN ve la modalidad; el servidor la revalida.
        <fieldset className="space-y-2" data-testid="session-mode">
          <legend className="mb-1 text-sm font-semibold">
            Modalidad de jornada
          </legend>
          {(
            [
              [
                false,
                "Nueva jornada",
                "Fecha y hora automáticas (hoy).",
                "mode-new",
              ],
              [
                true,
                "Registrar jornada histórica",
                "Una noche anterior que se captura después, completa.",
                "historical-toggle",
              ],
            ] as const
          ).map(([value, label, hint, testId]) => (
            <label
              key={testId}
              className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm"
            >
              <input
                type="radio"
                name="session-mode"
                className="mt-0.5 size-5"
                checked={historical === value}
                onChange={() => {
                  setHistorical(value)
                  setError(null)
                }}
                data-testid={testId}
              />
              <span>
                <span className="block font-medium">{label}</span>
                <span className="text-muted-foreground block text-xs">
                  {hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {historical ? (
        <div className="space-y-2">
          <Label htmlFor="historical-date">Fecha original de la sesión</Label>
          <Input
            id="historical-date"
            type="date"
            className="h-12 text-base"
            max={maxDate}
            min={HISTORICAL_MIN_DATE}
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
            data-testid="historical-date"
          />
          <p className="text-muted-foreground text-xs">
            {validDate
              ? `Fecha operativa: ${formatBusinessDateMx(businessDate)}`
              : `Elige un día anterior a hoy (${formatBusinessDateMx(today)}).`}
          </p>
          <Label htmlFor="historical-time">Hora de apertura (hora local)</Label>
          <Input
            id="historical-time"
            type="time"
            className="h-12 text-base"
            value={openingTime}
            onChange={(e) => setOpeningTime(e.target.value.slice(0, 5))}
            data-testid="historical-time"
          />
          <Label htmlFor="historical-notes">Observación (opcional)</Label>
          <textarea
            id="historical-notes"
            rows={2}
            maxLength={500}
            className="border-input w-full rounded-lg border bg-transparent px-2.5 py-2 text-base md:text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="historical-notes"
          />
          {sameDay.length > 0 ? (
            <p
              className="rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 text-sm"
              role="alert"
              data-testid="same-day-warning"
            >
              Ya existe otra jornada con esa fecha:{" "}
              <strong>{sameDay.map((x) => x.folio).join(", ")}</strong>.
              Verifica que no estés capturando la misma noche dos veces (no se
              bloquea).
            </p>
          ) : null}
          <p
            className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-3 text-sm"
            role="note"
            data-testid="historical-warning"
          >
            La sesión llevará la fecha operativa elegida y se opera completa:
            apertura con conteo de fichas y caja en $0.00, mesas, compras,
            firmas, liquidaciones y cierre, igual que una de hoy. Los
            movimientos guardan su hora real de captura y la auditoría registra
            que se capturó después.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Fecha operativa: <strong>{formatBusinessDateMx(today)}</strong> (hoy).
        </p>
      )}

      {previewDate ? (
        <p className="text-sm" data-testid="folio-preview">
          Folio provisional:{" "}
          <span className="font-mono font-semibold">
            {preview.data?.folio ?? "…"}
          </span>
          <span className="text-muted-foreground block text-xs">
            El consecutivo definitivo lo asigna el sistema al confirmar.
          </span>
        </p>
      ) : null}

      {blockedByActive ? (
        <p className="rounded-lg border p-3 text-sm" role="alert">
          Ya existe una sesión vigente ({activeSession!.folio}). Termínala o
          cancélala antes de crear otra.
        </p>
      ) : null}

      <Button
        className="h-12 w-full text-base"
        onClick={() => mutation.mutate()}
        disabled={!ready}
        data-testid="create-session"
      >
        {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
        {historical ? "Crear jornada histórica" : "Crear sesión"}
      </Button>
      {error ? (
        <div role="alert" className="text-destructive space-y-2 text-sm">
          <p>{error.message}</p>
          {error.activeId ? (
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => router.push(`${SESSIONS_BASE}/${error.activeId}`)}
            >
              Ir a la sesión vigente
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Caja inicial: el usuario confirma que CONTÓ físicamente el efectivo. Esperado siempre $0.00. */
export function OpeningCashForm({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [amount, setAmount] = useState("0")
  const [verified, setVerified] = useState(false)
  const [explanation, setExplanation] = useState("")
  const nonZero = Number(amount) !== 0
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<{ countedAmount: string }>(
        `/api/sessions/${sessionId}/opening-cash`,
        {
          method: "POST",
          body: {
            countedAmount: amount.trim(),
            physicallyVerified: verified,
            ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
          },
        }
      ),
    onSuccess: (r) => {
      if (Number(r.countedAmount) === 0)
        toast.success("Caja inicial confirmada en $0.00")
      else
        toast.warning(
          "Se registró efectivo en la caja: retíralo y vuelve a contar antes de abrir"
        )
      router.refresh()
    },
    onError: (e) =>
      toast.error(errorMessage(e, "No se pudo registrar el conteo")),
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="opening-cash">Efectivo contado en la caja</Label>
        <Input
          id="opening-cash"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-11 md:h-9"
        />
        <p className="text-muted-foreground text-xs">
          La caja siempre abre en $0.00. No hay fondo inicial.
        </p>
      </div>
      {nonZero ? (
        <div className="space-y-1">
          <Label htmlFor="opening-cash-explanation">
            ¿De dónde salió ese efectivo?
          </Label>
          <textarea
            id="opening-cash-explanation"
            rows={2}
            className={textareaClass}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </div>
      ) : null}
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
          data-testid="cash-verified"
        />
        Conté físicamente el efectivo de la caja.
      </label>
      <Button
        type="submit"
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!verified || mutation.isPending}
        data-testid="confirm-opening-cash"
      >
        {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar conteo de caja
      </Button>
    </form>
  )
}

/** Inicia o retoma el arqueo OPENING del inventario compartido. */
export function StartOpeningCountButton({
  sessionId,
  label,
}: {
  sessionId: string
  label: string
}) {
  const router = useRouter()
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/sessions/${sessionId}/opening-chip-count`, {
        method: "POST",
      }),
    onSuccess: () => router.refresh(),
    onError: (e) =>
      toast.error(errorMessage(e, "No se pudo iniciar el arqueo")),
  })
  return (
    <Button
      className="h-11 w-full md:h-9 md:w-auto"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      data-testid="start-opening-count"
    >
      {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
      {label}
    </Button>
  )
}

/** Cancelación con motivo obligatorio (no borra nada). */
export function CancelSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/sessions/${sessionId}/cancel`, {
        method: "POST",
        body: { reason },
      }),
    onSuccess: () => {
      setOpen(false)
      toast.success("Sesión cancelada")
      router.refresh()
    },
    onError: (e) => toast.error(errorMessage(e, "No se pudo cancelar")),
  })
  return (
    <>
      <Button
        variant="outline"
        className="h-11 w-full md:h-9 md:w-auto"
        onClick={() => setOpen(true)}
        data-testid="cancel-session"
      >
        Cancelar sesión
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !o && !mutation.isPending && setOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar sesión</AlertDialogTitle>
            <AlertDialogDescription>
              La sesión y su folio se conservan como historial. Los arqueos y
              ajustes reales no se revierten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 text-sm">
            <Label htmlFor="cancel-reason">Motivo</Label>
            <textarea
              id="cancel-reason"
              rows={2}
              className={textareaClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              Volver
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={mutation.isPending || reason.trim().length < 5}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Cancelar sesión
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
