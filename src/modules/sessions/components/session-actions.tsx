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
 * creador y fechas reales. SUPERADMIN puede registrar una sesión HISTÓRICA
 * de una fecha anterior (el servidor revalida permiso y fecha). La vista
 * previa del folio es provisional: el definitivo llega en la respuesta.
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
  const [created, setCreated] = useState<{
    id: string
    folio: string
    isHistorical: boolean
  } | null>(null)
  const [error, setError] = useState<{
    message: string
    activeId: string | null
  } | null>(null)
  const maxDate = previousDay(today)
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(businessDate) &&
    businessDate <= maxDate &&
    businessDate >= HISTORICAL_MIN_DATE
  const previewDate = historical ? (validDate ? businessDate : null) : today
  const preview = useQuery({
    queryKey: ["session-folio-preview", previewDate],
    queryFn: () =>
      apiRequest<{ folio: string; nextSequenceNumber: number }>(
        `/api/sessions/folio-preview?businessDate=${previewDate}`
      ),
    enabled: previewDate !== null && created === null,
  })
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; folio: string; isHistorical: boolean }>(
        "/api/sessions",
        {
          method: "POST",
          body: historical
            ? { idempotencyKey: key, historical: true, businessDate }
            : { idempotencyKey: key },
        }
      ),
    onSuccess: (s) => {
      renew()
      setCreated(s)
      toast.success(`Sesión ${s.folio} creada`)
      if (!s.isHistorical) router.push(`${SESSIONS_BASE}/${s.id}/preparacion`)
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

  if (created?.isHistorical)
    return (
      <div className="space-y-3" data-testid="historical-created">
        <p className="rounded-lg border p-3 text-sm">
          Sesión histórica registrada con el folio definitivo{" "}
          <strong className="font-mono" data-testid="definitive-folio">
            {created.folio}
          </strong>
          .
        </p>
        <Button
          className="h-12 w-full text-base"
          onClick={() => router.push(`${SESSIONS_BASE}/${created.id}`)}
          data-testid="go-created-session"
        >
          Ver la sesión
        </Button>
      </div>
    )

  const blockedByActive = !historical && activeSession !== null
  const ready =
    !mutation.isPending && !blockedByActive && (!historical || validDate)
  return (
    <div className="space-y-4">
      {canHistorical ? (
        <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={historical}
            onChange={(e) => {
              setHistorical(e.target.checked)
              setError(null)
            }}
            data-testid="historical-toggle"
          />
          Registrar sesión de fecha anterior
        </label>
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
          <p
            className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-3 text-sm"
            role="note"
            data-testid="historical-warning"
          >
            Esta sesión se registrará como histórica. La fecha de captura real
            quedará guardada en auditoría y no se modificarán automáticamente
            caja ni inventario.
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
        {historical ? "Registrar sesión histórica" : "Crear sesión"}
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

/** Acción simple POST sin cuerpo (p. ej. iniciar preparación). */
export function SessionActionButton({
  url,
  label,
  success,
  redirectTo,
  testId,
  variant = "default",
}: {
  url: string
  label: string
  success: string
  redirectTo?: string
  testId?: string
  variant?: "default" | "outline"
}) {
  const router = useRouter()
  const mutation = useMutation({
    mutationFn: () => apiRequest(url, { method: "POST" }),
    onSuccess: () => {
      toast.success(success)
      if (redirectTo) router.push(redirectTo)
      else router.refresh()
    },
    onError: (e) =>
      toast.error(errorMessage(e, "No se pudo completar la acción")),
  })
  return (
    <Button
      variant={variant}
      className="h-11 w-full md:h-9 md:w-auto"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      data-testid={testId}
    >
      {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
      {label}
    </Button>
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

/** Confirmación de apertura: la hora la asigna el servidor; no se muestra éxito antes de su respuesta. */
export function OpenSessionButton({
  sessionId,
  disabled,
}: {
  sessionId: string
  disabled: boolean
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [open, setOpen] = useState(false)
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<{ session: { openedAt: string; folio: string } }>(
        `/api/sessions/${sessionId}/open`,
        {
          method: "POST",
          body: { idempotencyKey: key },
        }
      ),
    onSuccess: (r) => {
      renew()
      setOpen(false)
      toast.success(`Sesión ${r.session.folio} abierta`)
      router.push(`${SESSIONS_BASE}/${sessionId}`)
    },
    onError: (e) => toast.error(errorMessage(e, "No se pudo abrir la sesión")),
  })
  return (
    <>
      <Button
        className="h-12 w-full text-base"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="open-session"
      >
        Abrir sesión
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !o && !mutation.isPending && setOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Abrir la sesión?</AlertDialogTitle>
            <AlertDialogDescription>
              La hora de apertura la registra el servidor. La sesión abre sin
              mesas; las mesas se abren después.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              data-testid="confirm-open-session"
            >
              {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Abrir sesión
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
