"use client"

import { useMutation } from "@tanstack/react-query"
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

const textareaClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"

function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

/** Crear sesión: el servidor asigna folio, creador y fechas. Sin mesas ni fondo inicial. */
export function CreateSessionButton() {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [error, setError] = useState<{
    message: string
    activeId: string | null
  } | null>(null)
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; folio: string }>("/api/sessions", {
        method: "POST",
        body: { idempotencyKey: key },
      }),
    onSuccess: (s) => {
      renew()
      toast.success(`Sesión ${s.folio} creada`)
      router.push(`${SESSIONS_BASE}/${s.id}/preparacion`)
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
  return (
    <div className="space-y-3">
      <Button
        className="h-12 w-full text-base"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        data-testid="create-session"
      >
        {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
        Crear sesión
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
