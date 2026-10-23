"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/**
 * Acciones del Módulo 17 (cliente, PRIVADO). Solo CAPTURAN lo que el
 * operador declara (importes entregados o devueltos, autorizador verbal,
 * propuesta de reserva/pago): el servidor autoriza, recalcula límites y
 * resultados, revalida estados y registra. Ningún resultado, saldo ni
 * aprobador se envía desde aquí.
 */

import { BANKING_API } from "./labels"

function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

export type FieldSpec = {
  name: string
  label: string
  type: "money" | "text" | "textarea" | "select" | "checkbox" | "percent"
  options?: { value: string; label: string }[]
  hint?: string
  required?: boolean
  initial?: string | boolean
  /** Solo se envía si tiene valor. */
  optional?: boolean
}

/**
 * Formulario de acción genérico: POST JSON con clave de idempotencia por
 * intento (se conserva al reintentar y se renueva tras el éxito).
 */
export function ActionForm({
  url,
  fields,
  extra = {},
  submitLabel,
  success,
  testId,
  variant = "default",
  onDone,
}: {
  url: string
  fields: FieldSpec[]
  extra?: Record<string, unknown>
  submitLabel: string
  success: string
  testId: string
  variant?: "default" | "outline" | "destructive"
  onDone?: (data: unknown) => void
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.initial ?? (f.type === "checkbox" ? false : ""),
      ])
    )
  )
  const set = (name: string, v: string | boolean) =>
    setValues((s) => ({ ...s, [name]: v }))
  return (
    <form
      className="space-y-3"
      data-testid={testId}
      onSubmit={async (e) => {
        e.preventDefault()
        setPending(true)
        setError(null)
        const body: Record<string, unknown> = { ...extra, idempotencyKey: key }
        for (const f of fields) {
          const v = values[f.name]
          if (f.optional && (v === "" || v === false)) continue
          body[f.name] = v
        }
        try {
          const data = await apiRequest<unknown>(url, { method: "POST", body })
          toast.success(success)
          renew()
          if (onDone) onDone(data)
          else router.refresh()
        } catch (err) {
          const msg = errorText(err)
          setError(msg)
          toast.error(msg)
        } finally {
          setPending(false)
        }
      }}
    >
      {fields.map((f) => {
        const id = `${testId}-${f.name}`
        if (f.type === "checkbox")
          return (
            <label
              key={f.name}
              htmlFor={id}
              className="flex min-h-11 items-start gap-2 text-sm"
            >
              <input
                id={id}
                type="checkbox"
                className="mt-1 size-5"
                checked={Boolean(values[f.name])}
                onChange={(e) => set(f.name, e.target.checked)}
                data-testid={id}
              />
              <span>{f.label}</span>
            </label>
          )
        return (
          <div key={f.name} className="space-y-1">
            <Label htmlFor={id}>{f.label}</Label>
            {f.type === "select" ? (
              <NativeSelect
                id={id}
                value={String(values[f.name] ?? "")}
                onChange={(e) => set(f.name, e.target.value)}
                required={f.required}
                data-testid={id}
              >
                <option value="">Selecciona…</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            ) : f.type === "textarea" ? (
              <textarea
                id={id}
                value={String(values[f.name] ?? "")}
                onChange={(e) => set(f.name, e.target.value)}
                required={f.required}
                data-testid={id}
                className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 min-h-20 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
              />
            ) : (
              <Input
                id={id}
                inputMode={f.type === "text" ? "text" : "decimal"}
                value={String(values[f.name] ?? "")}
                onChange={(e) => set(f.name, e.target.value)}
                required={f.required}
                data-testid={id}
                className="h-11 md:h-9"
              />
            )}
            {f.hint ? (
              <p className="text-muted-foreground text-xs">{f.hint}</p>
            ) : null}
          </div>
        )
      })}
      {error ? (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        variant={variant}
        disabled={pending}
        className="h-11 w-full sm:w-auto md:h-9"
        data-testid={`${testId}-submit`}
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        {submitLabel}
      </Button>
    </form>
  )
}

/** Formulario de desembolso REAL (efectivo entregado o transferencia en trámite). */
export function DisburseForm({
  url,
  testId,
  submitLabel = "Registrar pago real",
  sessionCashAllowed,
}: {
  url: string
  testId: string
  submitLabel?: string
  sessionCashAllowed: boolean
}) {
  const [method, setMethod] = useState("CASH")
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={`${testId}-method`}>Medio</Label>
        <NativeSelect
          id={`${testId}-method`}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          data-testid={`${testId}-method`}
        >
          <option value="CASH">Efectivo entregado</option>
          <option value="BANK_TRANSFER">
            Transferencia (queda en trámite)
          </option>
        </NativeSelect>
      </div>
      <ActionForm
        key={method}
        url={url}
        testId={testId}
        submitLabel={submitLabel}
        success={
          method === "CASH"
            ? "Pago en efectivo registrado"
            : "Transferencia en trámite: no cuenta como pagada hasta confirmarla"
        }
        extra={{ method }}
        fields={[
          {
            name: "amount",
            label: "Importe realmente entregado",
            type: "money",
            required: true,
          },
          ...(method === "CASH"
            ? [
                {
                  name: "funding",
                  label: "¿De dónde sale el efectivo?",
                  type: "select" as const,
                  required: true,
                  initial: "ADMIN_CUSTODY",
                  options: [
                    {
                      value: "ADMIN_CUSTODY",
                      label: "Mi custodia administrativa",
                    },
                    ...(sessionCashAllowed
                      ? [
                          {
                            value: "SESSION_CASH",
                            label: "Caja de la sesión abierta",
                          },
                        ]
                      : []),
                  ],
                },
              ]
            : [
                {
                  name: "bankReference",
                  label: "Referencia de la transferencia",
                  type: "text" as const,
                  optional: true,
                },
              ]),
          {
            name: "notes",
            label: "Notas (opcional)",
            type: "text",
            optional: true,
          },
        ]}
      />
    </div>
  )
}

/** Confirma, marca fallida o cancela una transferencia pendiente. */
export function ResolvePayoutForm({ payoutId }: { payoutId: string }) {
  return (
    <ActionForm
      url={`${BANKING_API}/payouts/${payoutId}/resolve`}
      testId={`resolve-${payoutId}`}
      submitLabel="Resolver transferencia"
      success="Transferencia resuelta"
      fields={[
        {
          name: "outcome",
          label: "Resultado",
          type: "select",
          required: true,
          options: [
            { value: "EXECUTED", label: "Ejecutada (con referencia)" },
            { value: "FAILED", label: "Fallida" },
            { value: "CANCELLED", label: "Cancelada" },
          ],
        },
        {
          name: "bankReference",
          label: "Referencia",
          type: "text",
          optional: true,
        },
        {
          name: "reason",
          label: "Motivo (si falló o se canceló)",
          type: "text",
          optional: true,
        },
      ]}
    />
  )
}

/** Sección plegable (sin JavaScript extra: <details>). */
export function Panel({
  title,
  children,
  testId,
  open = false,
}: {
  title: string
  children: ReactNode
  testId: string
  open?: boolean
}) {
  return (
    <details
      className={cn("rounded-lg border p-3 [&_summary]:cursor-pointer")}
      data-testid={testId}
      open={open}
    >
      <summary className="min-h-9 text-sm font-medium">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

/**
 * Preparación del corte: el cajero propone reserva + pago (deben sumar el
 * saldo que calcula el servidor). Si hay pérdidas entre tramos con
 * porcentajes distintos, SOLO un socio captura cómo se distribuyen.
 */
export function PrepareClosingForm({
  cycleId,
  tranches,
  allocationRequired,
  canAllocate,
  balance,
}: {
  cycleId: string
  tranches: { key: string; playerPercent: string; gains: string }[]
  allocationRequired: boolean
  canAllocate: boolean
  balance: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reserveAmount, setReserve] = useState("0")
  const [payAmount, setPay] = useState(balance)
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  return (
    <form
      className="space-y-3"
      data-testid="prepare-closing-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setPending(true)
        setError(null)
        try {
          await apiRequest(`${BANKING_API}/cycles/${cycleId}/prepare-closing`, {
            method: "POST",
            body: {
              reserveAmount,
              payAmount,
              ...(allocationRequired && canAllocate
                ? {
                    lossAllocation: Object.fromEntries(
                      tranches.map((t) => [t.key, alloc[t.key] || "0"])
                    ),
                  }
                : {}),
              idempotencyKey: key,
            },
          })
          toast.success(
            "Corte preparado: requiere aprobación digital de un socio"
          )
          renew()
          router.refresh()
        } catch (err) {
          const msg = errorText(err)
          setError(msg)
          toast.error(msg)
        } finally {
          setPending(false)
        }
      }}
    >
      {allocationRequired ? (
        canAllocate ? (
          <fieldset
            className="space-y-2 rounded-lg border p-3"
            data-testid="allocation-fields"
          >
            <legend className="px-1 text-sm font-medium">
              Distribución de pérdidas entre tramos
            </legend>
            {tranches.map((t, i) => (
              <div key={t.key} className="space-y-1">
                <Label htmlFor={`alloc-${i}`}>
                  Tramo {t.playerPercent}% (ganancias {t.gains})
                </Label>
                <Input
                  id={`alloc-${i}`}
                  inputMode="decimal"
                  value={alloc[t.key] ?? ""}
                  onChange={(e) =>
                    setAlloc((s) => ({ ...s, [t.key]: e.target.value }))
                  }
                  data-testid={`alloc-${i}`}
                  className="h-11 md:h-9"
                />
              </div>
            ))}
          </fieldset>
        ) : (
          <p
            className="text-sm text-amber-700 dark:text-amber-400"
            data-testid="allocation-needed"
          >
            Hay pérdidas entre tramos con porcentajes distintos: un PARTNER o
            SUPERADMIN debe preparar el corte con su distribución.
          </p>
        )
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="closing-reserve">A reserva</Label>
          <Input
            id="closing-reserve"
            inputMode="decimal"
            value={reserveAmount}
            onChange={(e) => setReserve(e.target.value)}
            data-testid="closing-reserve"
            className="h-11 md:h-9"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="closing-pay">Reconocido para pago</Label>
          <Input
            id="closing-pay"
            inputMode="decimal"
            value={payAmount}
            onChange={(e) => setPay(e.target.value)}
            data-testid="closing-pay"
            className="h-11 md:h-9"
          />
        </div>
      </div>
      {error ? (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-testid="prepare-closing-error"
        >
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending}
        className="h-11 w-full sm:w-auto md:h-9"
        data-testid="prepare-closing-submit"
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        Preparar corte
      </Button>
    </form>
  )
}
