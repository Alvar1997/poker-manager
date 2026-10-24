"use client"

import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatNominal } from "@/modules/inventory/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/**
 * Acciones del cierre (Módulo 12). El navegador solo envía lo que el
 * operador captura (conteos, receptor, motivos); el servidor calcula
 * esperados, diferencias y requisitos, y valida el rol. Nunca se declara
 * éxito antes de la respuesta confirmada del servidor.
 */

const textareaClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"

const msg = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback

const base = (sessionId: string) => `/api/sessions/${sessionId}/closure`

export function StartClosingButton({
  sessionId,
  disabled,
}: {
  sessionId: string
  disabled: boolean
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/start`, {
        method: "POST",
        body: { idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      toast.success("La sesión entró en cierre")
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo iniciar el cierre")),
  })
  return (
    <Button
      className="h-11 w-full md:h-9 md:w-auto"
      disabled={disabled || m.isPending}
      onClick={() => m.mutate()}
      data-testid="closure-start"
    >
      {m.isPending ? <Loader2 className="animate-spin" /> : null}
      Iniciar cierre (pasar a «En cierre»)
    </Button>
  )
}

export function ReturnToOpenForm({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [when, setWhen] = useState("")
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/return-to-open`, {
        method: "POST",
        body: {
          idempotencyKey: key,
          reason: reason.trim(),
          ...(when
            ? { forgottenOperationAt: new Date(when).toISOString() }
            : {}),
        },
      }),
    onSuccess: () => {
      renew()
      toast.success(
        "La sesión regresó a Abierta. Al terminar, inicia un cierre nuevo."
      )
      setOpen(false)
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo regresar a Abierta")),
  })
  if (!open)
    return (
      <Button
        variant="outline"
        className="h-11 w-full md:h-9 md:w-auto"
        onClick={() => setOpen(true)}
        data-testid="closure-return-open"
      >
        Regresar a Abierta (operación olvidada)
      </Button>
    )
  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p className="text-sm">
        Úsalo solo para registrar una operación REAL olvidada. Los arqueos
        confirmados se conservan como evidencia y tendrás que preparar el cierre
        de nuevo.
      </p>
      <div className="space-y-1">
        <Label htmlFor="return-reason">Motivo</Label>
        <textarea
          id="return-reason"
          rows={2}
          className={textareaClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="return-when">
          Hora en que ocurrió la operación (opcional)
        </Label>
        <Input
          id="return-when"
          type="datetime-local"
          className="h-11 md:h-9"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Se guarda aparte: la hora de captura siempre es la real del servidor.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="submit"
          className="h-11 md:h-9"
          disabled={reason.trim().length < 5 || m.isPending}
          data-testid="closure-return-open-confirm"
        >
          {m.isPending ? <Loader2 className="animate-spin" /> : null}
          Confirmar regreso a Abierta
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 md:h-9"
          onClick={() => setOpen(false)}
        >
          Cancelar
        </Button>
      </div>
    </form>
  )
}

export function StartClosingCountButton({
  sessionId,
  label,
}: {
  sessionId: string
  label: string
}) {
  const router = useRouter()
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/inventory-count`, {
        method: "POST",
        body: { action: "start" },
      }),
    onSuccess: () => router.refresh(),
    onError: (e) => toast.error(msg(e, "No se pudo iniciar el arqueo")),
  })
  return (
    <Button
      className="h-11 w-full md:h-9 md:w-auto"
      disabled={m.isPending}
      onClick={() => m.mutate()}
      data-testid="closure-count-start"
    >
      {m.isPending ? <Loader2 className="animate-spin" /> : null}
      {label}
    </Button>
  )
}

export function CashCountForm({
  sessionId,
  expected,
}: {
  sessionId: string
  expected: string
}) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [explanation, setExplanation] = useState("")
  const [verified, setVerified] = useState(false)
  const differs =
    amount.trim() !== "" &&
    /^\d+(\.\d{1,2})?$/.test(amount.trim()) &&
    Number(amount) !== Number(expected)
  const m = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; replayed: boolean }>(
        `${base(sessionId)}/cash-count`,
        {
          method: "POST",
          body: {
            countedAmount: amount.trim(),
            physicallyCounted: verified,
            ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
          },
        }
      ),
    onSuccess: () => {
      toast.success("Arqueo de efectivo registrado")
      setAmount("")
      setExplanation("")
      setVerified(false)
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo registrar el arqueo")),
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="closing-cash">Efectivo contado físicamente</Label>
        <Input
          id="closing-cash"
          inputMode="decimal"
          className="h-11 md:h-9"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {differs ? (
        <div className="space-y-1">
          <Label htmlFor="closing-cash-explanation">
            Hay diferencia con lo esperado: explica su causa
          </Label>
          <textarea
            id="closing-cash-explanation"
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
          data-testid="closing-cash-verified"
        />
        Conté físicamente todo el efectivo de la caja.
      </label>
      <Button
        type="submit"
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!verified || amount.trim() === "" || m.isPending}
        data-testid="closing-cash-submit"
      >
        {m.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar arqueo de efectivo
      </Button>
    </form>
  )
}

export function WithdrawalForm({
  sessionId,
  available,
}: {
  sessionId: string
  available: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [recipient, setRecipient] = useState("")
  const [notes, setNotes] = useState("")
  const [delivered, setDelivered] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/cash-withdrawal`, {
        method: "POST",
        body: {
          idempotencyKey: key,
          amount: available,
          recipientName: recipient.trim(),
          physicallyDelivered: delivered,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      }),
    onSuccess: () => {
      renew()
      toast.success("Retiro final registrado: la caja quedó en $0.00")
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo registrar el retiro")),
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p className="text-sm">
        Importe a retirar (todo el efectivo disponible):{" "}
        <span
          className="font-semibold tabular-nums"
          data-testid="withdrawal-available"
        >
          {formatNominal(available)}
        </span>
      </p>
      <div className="space-y-1">
        <Label htmlFor="withdrawal-recipient">¿Quién recibe el efectivo?</Label>
        <Input
          id="withdrawal-recipient"
          className="h-11 md:h-9"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Nombre de quien recibe o custodia el dinero"
        />
        <p className="text-muted-foreground text-xs">
          El receptor no necesita iniciar sesión ni firmar: registras que se lo
          entregaste.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="withdrawal-notes">Observaciones (opcional)</Label>
        <Input
          id="withdrawal-notes"
          className="h-11 md:h-9"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={delivered}
          onChange={(e) => setDelivered(e.target.checked)}
          data-testid="withdrawal-delivered"
        />
        Entregué físicamente {formatNominal(available)} a la persona indicada.
      </label>
      <Button
        type="submit"
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!delivered || recipient.trim().length < 3 || m.isPending}
        data-testid="withdrawal-submit"
      >
        {m.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar retiro final
      </Button>
    </form>
  )
}

export function DiscrepancyNoteForm({
  sessionId,
  discrepancyId,
}: {
  sessionId: string
  discrepancyId: string
}) {
  const router = useRouter()
  const [notes, setNotes] = useState("")
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/discrepancies/${discrepancyId}/resolve`, {
        method: "POST",
        body: { action: "note", notes: notes.trim() },
      }),
    onSuccess: () => {
      toast.success("Observación registrada")
      setNotes("")
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo registrar")),
  })
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <Input
        aria-label="Observación de la investigación"
        className="h-11 md:h-9"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Seguimiento de la investigación"
      />
      <Button
        type="submit"
        variant="outline"
        className="h-11 md:h-9"
        disabled={notes.trim().length < 3 || m.isPending}
      >
        Agregar observación
      </Button>
    </form>
  )
}

export function AuthorizeAdjustmentForm({
  sessionId,
  discrepancyId,
  difference,
}: {
  sessionId: string
  discrepancyId: string
  difference: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [reason, setReason] = useState("")
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/discrepancies/${discrepancyId}/resolve`, {
        method: "POST",
        body: {
          action: "authorize-adjustment",
          idempotencyKey: key,
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      renew()
      toast.success("Ajuste excepcional autorizado")
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo autorizar el ajuste")),
  })
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p className="text-sm">
        Ajuste EXCEPCIONAL de {formatNominal(difference)}. La diferencia
        original queda registrada; el ajuste se liga al arqueo.
      </p>
      <Label htmlFor={`adj-${discrepancyId}`}>Motivo</Label>
      <textarea
        id={`adj-${discrepancyId}`}
        rows={2}
        className={textareaClass}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        type="submit"
        className="h-11 md:h-9"
        disabled={reason.trim().length < 5 || m.isPending}
        data-testid="authorize-adjustment"
      >
        {m.isPending ? <Loader2 className="animate-spin" /> : null}
        Autorizar ajuste excepcional
      </Button>
    </form>
  )
}

export function ConfirmClosureForm({
  sessionId,
  previewHash,
  noActivity,
  ready,
}: {
  sessionId: string
  previewHash: string
  noActivity: boolean
  ready: boolean
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [reason, setReason] = useState("")
  const [reviewed, setReviewed] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/confirm`, {
        method: "POST",
        body: {
          idempotencyKey: key,
          previewHash,
          ...(noActivity ? { noActivityReason: reason.trim() } : {}),
        },
      }),
    onSuccess: () => {
      renew()
      toast.success("Sesión cerrada definitivamente")
      router.push(`/dashboard/sesiones/${sessionId}/cierre/comprobante`)
    },
    onError: (e) => {
      const stale =
        e instanceof ApiClientError &&
        (e.details as { stale?: boolean } | undefined)?.stale
      toast.error(
        stale
          ? "Hubo movimientos después de preparar el resumen: revísalo de nuevo."
          : msg(e, "No se pudo cerrar la sesión")
      )
      router.refresh()
    },
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      {noActivity ? (
        <div className="space-y-1">
          <Label htmlFor="no-activity-reason">
            Motivo del cierre sin actividad
          </Label>
          <textarea
            id="no-activity-reason"
            rows={2}
            className={textareaClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      ) : null}
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          data-testid="closure-reviewed"
        />
        Revisé el resumen: inventario, efectivo, retiro y pendientes.
      </label>
      <Button
        type="submit"
        className="h-12 w-full text-base md:w-auto"
        disabled={
          !ready ||
          !reviewed ||
          m.isPending ||
          (noActivity && reason.trim().length < 5)
        }
        data-testid="closure-confirm"
      >
        {m.isPending ? <Loader2 className="animate-spin" /> : null}
        Confirmar cierre definitivo
      </Button>
    </form>
  )
}

/**
 * Conciliación de la DIFERENCIA NOMINAL global de la sesión (solo PARTNER o
 * SUPERADMIN). El servidor calcula el importe; aquí solo se elige el hecho
 * verificado y se explica.
 */
export function SessionChipReconciliationForm({
  sessionId,
  difference,
  identifiable,
}: {
  sessionId: string
  difference: string
  identifiable: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [kind, setKind] = useState<
    "RETURN_IDENTIFIED_IN_COUNT" | "UNRECOVERED_AUTHORIZED"
  >(
    Number(identifiable) > 0
      ? "RETURN_IDENTIFIED_IN_COUNT"
      : "UNRECOVERED_AUTHORIZED"
  )
  const [reason, setReason] = useState("")
  const m = useMutation({
    mutationFn: () =>
      apiRequest(`${base(sessionId)}/chip-reconciliation`, {
        method: "POST",
        body: { kind, reason: reason.trim(), idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      toast.success(
        kind === "RETURN_IDENTIFIED_IN_COUNT"
          ? "Retorno identificado registrado: vuelve a contar las fichas"
          : "Diferencia documentada y autorizada"
      )
      router.refresh()
    },
    onError: (e) => toast.error(msg(e, "No se pudo conciliar")),
  })
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      data-testid="chip-reconciliation-form"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p className="text-sm">
        Diferencia nominal de la sesión:{" "}
        <strong>{formatNominal(difference)}</strong>. Ningún jugador se lleva
        fichas: concilia con un hecho verificado.
      </p>
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="radio"
          name="chip-rec-kind"
          className="mt-1 size-5"
          checked={kind === "RETURN_IDENTIFIED_IN_COUNT"}
          disabled={Number(identifiable) <= 0}
          onChange={() => setKind("RETURN_IDENTIFIED_IN_COUNT")}
          data-testid="chip-rec-identified"
        />
        <span>
          Las fichas están en la caja: el arqueo encontró{" "}
          {formatNominal(identifiable)} de más (devoluciones no capturadas). Se
          registra la entrada real y se vuelve a contar.
        </span>
      </label>
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="radio"
          name="chip-rec-kind"
          className="mt-1 size-5"
          checked={kind === "UNRECOVERED_AUTHORIZED"}
          onChange={() => setKind("UNRECOVERED_AUTHORIZED")}
          data-testid="chip-rec-unrecovered"
        />
        <span>
          Las fichas no aparecen: documentar y autorizar la diferencia (sin
          movimientos; queda señalada).
        </span>
      </label>
      <Label htmlFor="chip-rec-reason">Qué se verificó y por qué</Label>
      <textarea
        id="chip-rec-reason"
        rows={2}
        className={textareaClass}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="chip-rec-reason"
      />
      <Button
        type="submit"
        className="h-11 md:h-9"
        disabled={reason.trim().length < 10 || m.isPending}
        data-testid="chip-rec-submit"
      >
        {m.isPending ? <Loader2 className="animate-spin" /> : null}
        Conciliar diferencia
      </Button>
    </form>
  )
}
