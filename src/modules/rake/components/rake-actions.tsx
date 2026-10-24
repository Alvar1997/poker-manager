"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/**
 * Formularios del rake por mesa (Módulo 18). El servidor fija la hora
 * real, el responsable, la modalidad y los importes calculados.
 */

function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

function useRun() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  return {
    pending,
    async run(fn: () => Promise<unknown>, ok: string, after?: () => void) {
      setPending(true)
      try {
        await fn()
        toast.success(ok)
        after?.()
        router.refresh()
      } catch (e) {
        toast.error(errorText(e))
      } finally {
        setPending(false)
      }
    },
  }
}

function Submit({
  pending,
  disabled,
  testId,
  children,
}: {
  pending: boolean
  disabled?: boolean
  testId: string
  children: ReactNode
}) {
  return (
    <Button
      type="submit"
      className="h-11 w-full sm:w-auto"
      disabled={pending || disabled}
      data-testid={testId}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {children}
    </Button>
  )
}

const money = (v: string) => v.replace(/[^\d.]/g, "")

export function RakeEntryForm({
  sessionId,
  tableId,
  closedCycles,
}: {
  sessionId: string
  tableId: string
  /** Ciclos cerrados sin conteo (captura atrasada). */
  closedCycles: { id: string; label: string }[]
}) {
  const { pending, run } = useRun()
  const [key, renew] = useIdempotencyKey()
  const [amount, setAmount] = useState("")
  const [cycleId, setCycle] = useState("")
  const [effectiveAt, setEffective] = useState("")
  return (
    <form
      className="space-y-2"
      data-testid="rake-entry-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(
              `/api/sessions/${sessionId}/tables/${tableId}/rake/entries`,
              {
                method: "POST",
                body: {
                  amount,
                  ...(cycleId ? { cycleId } : {}),
                  ...(effectiveAt
                    ? { effectiveAt: new Date(effectiveAt).toISOString() }
                    : {}),
                  idempotencyKey: key,
                },
              }
            ),
          "Rake registrado",
          () => {
            renew()
            setAmount("")
            setEffective("")
          }
        )
      }}
    >
      <div className="flex gap-2">
        {["25", "50", "75", "100"].map((a) => (
          <Button
            key={a}
            type="button"
            variant="outline"
            className="h-11 flex-1"
            onClick={() => setAmount(a)}
            data-testid={`rake-quick-${a}`}
          >
            ${a}
          </Button>
        ))}
      </div>
      <Input
        inputMode="decimal"
        className="h-11 text-base"
        placeholder="Importe"
        value={amount}
        onChange={(e) => setAmount(money(e.target.value))}
        data-testid="rake-amount"
      />
      {closedCycles.length > 0 ? (
        <NativeSelect
          value={cycleId}
          onChange={(e) => setCycle(e.target.value)}
          data-testid="rake-cycle"
        >
          <option value="">Ciclo abierto (ahora)</option>
          {closedCycles.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} (captura atrasada)
            </option>
          ))}
        </NativeSelect>
      ) : null}
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2">
          Captura atrasada: hora efectiva
        </summary>
        <Input
          type="datetime-local"
          className="h-11 text-base"
          value={effectiveAt}
          onChange={(e) => setEffective(e.target.value)}
          data-testid="rake-effective"
        />
        <p className="text-muted-foreground text-xs">
          Se conservan la hora declarada y la hora real de captura.
        </p>
      </details>
      <Submit
        pending={pending}
        disabled={!(Number(amount) > 0)}
        testId="rake-entry-submit"
      >
        Registrar rake
      </Submit>
    </form>
  )
}

export function RakeCountForm({
  sessionId,
  tableId,
  cycleId,
  registered,
  mode,
}: {
  sessionId: string
  tableId: string
  cycleId: string
  registered: string
  mode: string
}) {
  const { pending, run } = useRun()
  const [key, renew] = useIdempotencyKey()
  const [amount, setAmount] = useState("")
  const [counted, setCounted] = useState(false)
  const [zero, setZero] = useState(false)
  const isZero = amount !== "" && Number(amount) === 0
  return (
    <form
      className="space-y-2"
      data-testid="rake-count-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(
              `/api/sessions/${sessionId}/tables/${tableId}/rake/counts`,
              {
                method: "POST",
                body: {
                  cycleId,
                  countedAmount: amount,
                  physicallyCounted: true,
                  ...(isZero ? { zeroConfirmed: true } : {}),
                  idempotencyKey: key,
                },
              }
            ),
          "Conteo de rake confirmado",
          () => renew()
        )
      }}
    >
      {mode === "MANUAL" ? (
        <p className="text-sm">
          Registrado durante la mesa: <strong>{formatMXN(registered)}</strong>.
          Cuenta el recipiente y captura lo encontrado.
        </p>
      ) : (
        <p className="text-sm">
          Cuenta las fichas del recipiente: lo contado es el rake de la casa de
          este ciclo.
        </p>
      )}
      <Input
        inputMode="decimal"
        className="h-11 text-base"
        placeholder="Importe contado"
        value={amount}
        onChange={(e) => setAmount(money(e.target.value))}
        data-testid="rake-count-amount"
      />
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-5"
          checked={counted}
          onChange={(e) => setCounted(e.target.checked)}
          data-testid="rake-count-confirm"
        />
        Conté físicamente las fichas del recipiente
      </label>
      {isZero ? (
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-5"
            checked={zero}
            onChange={(e) => setZero(e.target.checked)}
            data-testid="rake-count-zero"
          />
          Confirmo que el recipiente estaba vacío ($0)
        </label>
      ) : null}
      <Submit
        pending={pending}
        disabled={amount === "" || !counted || (isZero && !zero)}
        testId="rake-count-submit"
      >
        Confirmar conteo
      </Submit>
    </form>
  )
}

/**
 * Corrección auditable (±, motivo): de un registro manual concreto o del
 * conteo final. Lo capturado originalmente no cambia.
 */
export function RakeCorrectionForm({
  sessionId,
  tableId,
  cycleId,
  targets,
  suggested,
}: {
  sessionId: string
  tableId: string
  cycleId: string
  /** Registros manuales corregibles; vacío = se corrige el conteo final. */
  targets: { id: string; label: string }[]
  suggested?: string
}) {
  const { pending, run } = useRun()
  const [key, renew] = useIdempotencyKey()
  const [open, setOpen] = useState(false)
  const [movementId, setMovement] = useState(targets.at(-1)?.id ?? "")
  const [amount, setAmount] = useState(suggested ?? "")
  const [reason, setReason] = useState("")
  if (!open)
    return (
      <Button
        variant="ghost"
        className="h-11"
        onClick={() => setOpen(true)}
        data-testid="rake-correct-open"
      >
        Corregir
      </Button>
    )
  return (
    <form
      className="space-y-2"
      data-testid="rake-correction-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(
              `/api/sessions/${sessionId}/tables/${tableId}/rake/corrections`,
              {
                method: "POST",
                body: {
                  cycleId,
                  ...(targets.length > 0 ? { movementId } : {}),
                  amount,
                  reason,
                  idempotencyKey: key,
                },
              }
            ),
          "Corrección registrada",
          () => {
            renew()
            setOpen(false)
            setReason("")
          }
        )
      }}
    >
      <p className="text-muted-foreground text-xs">
        Se registra un movimiento nuevo (+ o −) con motivo; el registro original
        se conserva y el inventario refleja las fichas reales.
      </p>
      {targets.length > 0 ? (
        <NativeSelect
          value={movementId}
          onChange={(e) => setMovement(e.target.value)}
          data-testid="rake-correct-target"
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      <Input
        className="h-11 text-base"
        placeholder="Corrección (+ o −), p. ej. -25"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, ""))}
        data-testid="rake-correct-amount"
      />
      <Input
        className="h-11 text-base"
        placeholder="Motivo (mínimo 10 caracteres)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="rake-correct-reason"
      />
      <Submit
        pending={pending}
        disabled={reason.trim().length < 10 || !/[1-9]/.test(amount)}
        testId="rake-correct-submit"
      >
        Registrar corrección
      </Submit>
    </form>
  )
}

export function RakeModeForm({
  tableId,
  mode,
}: {
  tableId: string
  mode: string
}) {
  const { pending, run } = useRun()
  const [value, setValue] = useState(mode)
  const [reason, setReason] = useState("")
  return (
    <form
      className="space-y-2"
      data-testid="rake-mode-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`/api/tables/${tableId}/rake-mode`, {
              method: "POST",
              body: { mode: value, reason },
            }),
          "Modalidad actualizada"
        )
      }}
    >
      <NativeSelect
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid="rake-mode"
      >
        <option value="MANUAL">Captura manual</option>
        <option value="FINAL_COUNT">Conteo final</option>
      </NativeSelect>
      <Input
        className="h-11 text-base"
        placeholder="Motivo del cambio"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="rake-mode-reason"
      />
      <Submit
        pending={pending}
        disabled={value === mode || reason.trim().length < 5}
        testId="rake-mode-submit"
      >
        Cambiar modalidad
      </Submit>
    </form>
  )
}
