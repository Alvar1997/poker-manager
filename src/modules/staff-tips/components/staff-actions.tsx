"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

import type { SessionTipsView } from "../tips.service"

/**
 * Formularios de staff y propinas (Módulo 18, simplificado). Sin lógica
 * financiera: el servidor calcula el total y decide qué cuenta; aquí solo
 * se captura y se muestra su respuesta. Mobile First (44 px).
 */

export const STAFF_BASE = "/dashboard/administracion/staff"

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
  variant = "default",
}: {
  pending: boolean
  disabled?: boolean
  testId: string
  children: ReactNode
  variant?: "default" | "outline"
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      className="h-11"
      disabled={pending || disabled}
      data-testid={testId}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {children}
    </Button>
  )
}

const money = (v: string) => v.replace(/[^\d.]/g, "")

/** Normaliza un importe capturado a 2 decimales como TEXTO (sin aritmética). */
function normalize(v: string) {
  if (!/^\d+(\.\d*)?$/.test(v)) return v
  const [int, frac = ""] = v.split(".")
  return `${int.replace(/^0+(?=\d)/, "")}.${(frac + "00").slice(0, 2)}`
}

// ── Catálogo ──────────────────────────────────────────────────────────

export function StaffCreateForm({
  positions,
}: {
  positions: { id: string; name: string }[]
}) {
  const { pending, run } = useRun()
  const [name, setName] = useState("")
  const [positionId, setPositionId] = useState(positions[0]?.id ?? "")
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      data-testid="staff-create-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest("/api/admin/staff", {
              method: "POST",
              body: { name, positionId },
            }),
          "Empleado registrado",
          () => setName("")
        )
      }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="staff-name">Nombre</Label>
        <Input
          id="staff-name"
          className="h-11 text-base"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="staff-name"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="staff-position">Puesto</Label>
        <NativeSelect
          id="staff-position"
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          data-testid="staff-position"
        >
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Submit
        pending={pending}
        disabled={name.trim().length < 2 || !positionId}
        testId="staff-create-submit"
      >
        Registrar
      </Submit>
    </form>
  )
}

export function StaffActiveToggle({
  id,
  isActive,
}: {
  id: string
  isActive: boolean
}) {
  const { pending, run } = useRun()
  return (
    <Button
      variant="outline"
      className="h-11 md:h-9"
      disabled={pending}
      onClick={() =>
        void run(
          () =>
            apiRequest(`/api/admin/staff/${id}`, {
              method: "PATCH",
              body: { isActive: !isActive },
            }),
          isActive ? "Empleado desactivado" : "Empleado activado"
        )
      }
      data-testid={`staff-toggle-${id}`}
    >
      {isActive ? "Desactivar" : "Activar"}
    </Button>
  )
}

// ── Propinas de la sesión ─────────────────────────────────────────────

export function AddSessionStaffForm({
  sessionId,
  staff,
}: {
  sessionId: string
  staff: { id: string; name: string; position: string }[]
}) {
  const { pending, run } = useRun()
  const [staffMemberId, setStaff] = useState(staff[0]?.id ?? "")
  if (staff.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Todo el personal activo ya está en la sesión. Da de alta empleados en
        Administración → Staff.
      </p>
    )
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      data-testid="add-session-staff"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`/api/sessions/${sessionId}/staff`, {
              method: "POST",
              body: { staffMemberId },
            }),
          "Empleado agregado a la sesión"
        )
      }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="session-staff">Agregar empleado</Label>
        <NativeSelect
          id="session-staff"
          value={staffMemberId}
          onChange={(e) => setStaff(e.target.value)}
          data-testid="session-staff-select"
        >
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.position}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Submit pending={pending} testId="add-session-staff-submit">
        Agregar
      </Submit>
    </form>
  )
}

type Row = SessionTipsView["staff"][number]

/** Fila de propinas de un empleado: borrador → confirmar → corrección. */
export function StaffTipRow({
  sessionId,
  row,
  editable,
}: {
  sessionId: string
  row: Row
  editable: boolean
}) {
  const { pending, run } = useRun()
  const [amount, setAmount] = useState(row.draft ?? "")
  const [received, setReceived] = useState(false)
  const [zero, setZero] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fix, setFix] = useState("")
  const [reason, setReason] = useState("")
  const [fixKey, renewFix] = useIdempotencyKey()
  const base = `/api/sessions/${sessionId}/staff/${row.id}/tip-count`
  // "300" y "300.00" son el mismo importe (comparación de texto normalizado).
  const dirty = normalize(amount) !== normalize(row.draft ?? "")
  const isZero = amount !== "" && !/[1-9]/.test(amount)
  return (
    <li
      className="space-y-2 p-3"
      data-testid="staff-tip-row"
      data-state={row.state}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium">{row.staff.name}</div>
          <div className="text-muted-foreground text-xs">
            {row.staff.position}
            {Number(row.partials) > 0
              ? ` · anotado durante la noche ${formatMXN(row.partials)}`
              : ""}
          </div>
        </div>
        <div className="text-right">
          <div
            className="font-semibold tabular-nums"
            data-testid="staff-tip-recognized"
          >
            {row.state === "CONFIRMED" ? formatMXN(row.recognized) : "—"}
          </div>
          <div className="text-muted-foreground text-xs">
            {row.state === "CONFIRMED"
              ? Number(row.corrections) !== 0
                ? `conteo ${formatMXN(row.confirmedCount)} · correcciones ${formatMXN(row.corrections)}`
                : "Confirmado"
              : row.state === "DRAFT"
                ? "Borrador (no cuenta aún)"
                : "Sin conteo"}
          </div>
        </div>
      </div>
      {editable && row.state !== "CONFIRMED" ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              inputMode="decimal"
              className="h-11 flex-1 text-base"
              placeholder="Importe contado"
              value={amount}
              onChange={(e) => setAmount(money(e.target.value))}
              data-testid="staff-tip-amount"
            />
            <Button
              variant="outline"
              className="h-11"
              disabled={pending || amount === "" || !dirty}
              onClick={() =>
                void run(
                  () =>
                    apiRequest(base, {
                      method: "PATCH",
                      body: {
                        amount,
                        ...(row.version
                          ? { expectedVersion: row.version }
                          : {}),
                      },
                    }),
                  "Borrador guardado"
                )
              }
              data-testid="staff-tip-save"
            >
              Guardar
            </Button>
          </div>
          {row.state === "DRAFT" && !dirty ? (
            <div className="space-y-2">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5"
                  checked={received}
                  onChange={(e) => setReceived(e.target.checked)}
                  data-testid="staff-tip-received"
                />
                Conté y recibí físicamente las fichas de sus propinas
              </label>
              {isZero ? (
                <label className="flex min-h-11 items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-5"
                    checked={zero}
                    onChange={(e) => setZero(e.target.checked)}
                    data-testid="staff-tip-zero"
                  />
                  Confirmo que no recibió propinas ($0)
                </label>
              ) : null}
              <Button
                className="h-11 w-full"
                disabled={pending || !received || (isZero && !zero)}
                onClick={() =>
                  void run(
                    () =>
                      apiRequest(`${base}/confirm`, {
                        method: "POST",
                        body: {
                          expectedVersion: row.version,
                          amount,
                          physicallyReceived: true,
                          ...(isZero ? { zeroConfirmed: true } : {}),
                        },
                      }),
                    "Conteo confirmado"
                  )
                }
                data-testid="staff-tip-confirm"
              >
                Confirmar {formatMXN(amount || "0")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {editable && row.state === "CONFIRMED" ? (
        fixing ? (
          <form
            className="space-y-2"
            data-testid="staff-tip-correction"
            onSubmit={(e) => {
              e.preventDefault()
              void run(
                () =>
                  apiRequest(`${base}/corrections`, {
                    method: "POST",
                    body: { amount: fix, reason, idempotencyKey: fixKey },
                  }),
                "Corrección registrada",
                () => {
                  renewFix()
                  setFixing(false)
                  setFix("")
                  setReason("")
                }
              )
            }}
          >
            <Input
              className="h-11 text-base"
              placeholder="Corrección (+ o −), p. ej. -25"
              value={fix}
              onChange={(e) => setFix(e.target.value.replace(/[^\d.-]/g, ""))}
              data-testid="staff-tip-correction-amount"
            />
            <Input
              className="h-11 text-base"
              placeholder="Motivo (mínimo 10 caracteres)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="staff-tip-correction-reason"
            />
            <Submit
              pending={pending}
              disabled={!/[1-9]/.test(fix) || reason.trim().length < 10}
              testId="staff-tip-correction-submit"
            >
              Registrar corrección
            </Submit>
          </form>
        ) : (
          <Button
            variant="ghost"
            className="h-11"
            onClick={() => setFixing(true)}
            data-testid="staff-tip-fix"
          >
            Corregir
          </Button>
        )
      ) : null}
      {row.history.length > 0 ? (
        <details className="text-xs">
          <summary className="text-muted-foreground min-h-9 cursor-pointer py-2">
            Historial ({row.history.length})
          </summary>
          <ul className="space-y-1">
            {row.history.map((h) => (
              <li key={h.id}>
                {h.kind === "PARTIAL" ? "Parcial" : "Corrección"}{" "}
                {formatMXN(h.amount)} · {new Date(h.at).toLocaleString("es-MX")}{" "}
                · {h.by}
                {h.reason ? ` · ${h.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  )
}
