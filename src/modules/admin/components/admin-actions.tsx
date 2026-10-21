"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type FormEvent, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/**
 * Acciones del Módulo 15 (cliente). Solo capturan datos: el servidor
 * autoriza (rol), valida (Zod), revalida estados y versiones, y NUNCA
 * mueve dinero al aprobar. Los botones ocultos no son seguridad.
 */

export const ADMIN_BASE = "/dashboard/administracion"

function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

export function TextArea(props: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 min-h-24 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm",
        props.className
      )}
    />
  )
}

function useAction() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(
    fn: () => Promise<T>,
    success: string,
    after?: (r: T) => void
  ) {
    setPending(true)
    setError(null)
    try {
      const r = await fn()
      toast.success(success)
      if (after) after(r)
      else router.refresh()
      return r
    } catch (e) {
      const msg = errorText(e)
      setError(msg)
      toast.error(msg)
      return null
    } finally {
      setPending(false)
    }
  }
  return { pending, error, run, router }
}

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

function Submit({
  pending,
  children,
  testId,
  variant,
}: {
  pending: boolean
  children: ReactNode
  testId: string
  variant?: "default" | "outline" | "destructive"
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      className="h-11 w-full sm:w-auto md:h-9"
      data-testid={testId}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  )
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p
      className="text-destructive text-sm"
      role="alert"
      data-testid="action-error"
    >
      {error}
    </p>
  ) : null
}

// ── Filtros por URL (auditoría) ───────────────────────────────────────

export function UrlFilters({
  fields,
  values,
  base,
}: {
  fields: {
    name: string
    label: string
    type: "date" | "text" | "select"
    options?: { id: string; label: string }[]
  }[]
  values: Record<string, string | undefined>
  base: string
}) {
  const router = useRouter()
  const [v, setV] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""]))
  )
  function apply(e: FormEvent) {
    e.preventDefault()
    const p = new URLSearchParams()
    for (const [k, val] of Object.entries(v)) if (val) p.set(k, val)
    const q = p.toString()
    router.push(q ? `${base}?${q}` : base, { scroll: false })
  }
  return (
    <form
      onSubmit={apply}
      className="grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2 md:grid-cols-3"
      data-testid="admin-filters"
    >
      {fields.map((f) => (
        <Field key={f.name} id={`f-${f.name}`} label={f.label}>
          {f.type === "select" ? (
            <NativeSelect
              id={`f-${f.name}`}
              value={v[f.name]}
              data-testid={`f-${f.name}`}
              onChange={(e) =>
                setV((x) => ({ ...x, [f.name]: e.target.value }))
              }
            >
              <option value="">Todos</option>
              {f.options?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              id={`f-${f.name}`}
              type={f.type}
              value={v[f.name]}
              data-testid={`f-${f.name}`}
              onChange={(e) =>
                setV((x) => ({ ...x, [f.name]: e.target.value }))
              }
            />
          )}
        </Field>
      ))}
      <div className="flex items-end gap-2 sm:col-span-2 md:col-span-3">
        <Button
          type="submit"
          className="h-11 md:h-9"
          data-testid="apply-admin-filters"
        >
          Aplicar filtros
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 md:h-9"
          onClick={() => router.push(base)}
        >
          Limpiar
        </Button>
      </div>
    </form>
  )
}

// ── Correcciones ──────────────────────────────────────────────────────

const TYPES: { id: string; label: string; target: string; m16?: boolean }[] = [
  {
    id: "RECEIVABLE_PAYMENT_REVERSAL",
    label: "Reverso de abono",
    target: "ReceivablePayment",
  },
  {
    id: "CASH_MOVEMENT_REVERSAL",
    label: "Reverso de movimiento de caja",
    target: "CashTransaction",
  },
  {
    id: "SETTLEMENT_REVERSAL",
    label: "Reverso de liquidación sin pagos",
    target: "PlayerSettlement",
  },
  {
    id: "PURCHASE_REVERSAL",
    label: "Reverso de compra confirmada (Módulo 16)",
    target: "ChipPurchase",
    m16: true,
  },
  {
    id: "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
    label: "Corrección de liquidación con pagos (Módulo 16)",
    target: "PlayerSettlement",
    m16: true,
  },
  {
    id: "UNAPPLIED_FUNDS_RETURN",
    label: "Devolución de fondos no aplicados (Módulo 16)",
    target: "UnappliedPlayerFunds",
    m16: true,
  },
  {
    id: "LATE_CHIP_REDEMPTION",
    label: "Canje posterior de fichas (Módulo 16)",
    target: "Player",
    m16: true,
  },
]

export function CorrectionRequestForm({
  initial,
}: {
  initial: { type?: string; targetId?: string }
}) {
  const { pending, error, run, router } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [type, setType] = useState(
    initial.type && TYPES.some((t) => t.id === initial.type)
      ? initial.type
      : TYPES[0].id
  )
  const [targetId, setTargetId] = useState(initial.targetId ?? "")
  const [reason, setReason] = useState("")
  const [amount, setAmount] = useState("")
  const [evidence, setEvidence] = useState("")
  const meta = TYPES.find((t) => t.id === type)!
  return (
    <form
      className="space-y-3"
      data-testid="correction-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest<{ id: string }>("/api/admin/corrections", {
              method: "POST",
              body: {
                type,
                targetType: meta.target,
                targetId: targetId.trim(),
                reason,
                ...(amount ? { amount } : {}),
                ...(evidence ? { evidenceNote: evidence } : {}),
                idempotencyKey: key,
              },
            }),
          "Solicitud registrada. No se movió ningún saldo.",
          (r) => {
            renew()
            router.push(`${ADMIN_BASE}/correcciones/${r.id}`)
          }
        )
      }}
    >
      <Field id="c-type" label="Tipo de corrección">
        <NativeSelect
          id="c-type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          data-testid="correction-type"
        >
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {meta.m16 ? (
        <p
          className="rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs"
          data-testid="m16-warning"
        >
          Proceso del Módulo 16: esta solicitud solo pide autorización. Una vez
          aprobada por un socio o superadministrador, se ejecuta en Operaciones
          especiales con los hechos reales (fichas recibidas, firma y pagos).
          Solicitar o aprobar no genera ningún movimiento.
        </p>
      ) : null}
      <Field
        id="c-target"
        label={`Identificador de la operación original (${meta.target})`}
      >
        <Input
          id="c-target"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          required
          data-testid="correction-target"
        />
      </Field>
      <Field
        id="c-amount"
        label="Importe involucrado (opcional; si no, se toma del original)"
      >
        <Input
          id="c-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field id="c-reason" label="Motivo">
        <TextArea
          id="c-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={10}
          data-testid="correction-reason"
        />
      </Field>
      <Field
        id="c-evidence"
        label="Evidencia (referencia opcional: folio, mensaje, foto resguardada…)"
      >
        <Input
          id="c-evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </Field>
      <ErrorLine error={error} />
      <Submit pending={pending} testId="submit-correction">
        Solicitar corrección
      </Submit>
    </form>
  )
}

export function CorrectionActions({
  id,
  version,
  status,
  canAuthorize,
  executable,
  isRequester,
}: {
  id: string
  version: number
  status: string
  canAuthorize: boolean
  executable: boolean
  isRequester: boolean
}) {
  const { pending, error, run } = useAction()
  const [notes, setNotes] = useState("")
  const [reference, setReference] = useState("")
  const post = (path: string, body: unknown, msg: string) =>
    run(
      () =>
        apiRequest(`/api/admin/corrections/${id}/${path}`, {
          method: "POST",
          body,
        }),
      msg
    )
  const active = ["REQUESTED", "UNDER_REVIEW"].includes(status)
  return (
    <div className="space-y-3" data-testid="correction-actions">
      <Field id="c-notes" label="Observación / notas de decisión">
        <TextArea
          id="c-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid="correction-notes"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 md:h-9"
          disabled={pending || notes.trim().length < 3}
          onClick={() =>
            void post("comments", { notes }, "Observación registrada")
          }
          data-testid="correction-comment"
        >
          Agregar observación
        </Button>
        {active && canAuthorize ? (
          <>
            <Button
              type="button"
              className="h-11 md:h-9"
              disabled={pending}
              onClick={() =>
                void post(
                  "approve",
                  { expectedVersion: version, notes },
                  "Aprobada: pendiente de ejecución real, sin movimientos"
                )
              }
              data-testid="correction-approve"
            >
              Aprobar
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11 md:h-9"
              disabled={pending}
              onClick={() =>
                void post(
                  "reject",
                  { expectedVersion: version, notes },
                  "Solicitud rechazada"
                )
              }
              data-testid="correction-reject"
            >
              Rechazar
            </Button>
            {status === "REQUESTED" ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 md:h-9"
                disabled={pending}
                onClick={() =>
                  void post(
                    "review",
                    { expectedVersion: version, notes: notes || "En revisión" },
                    "Marcada en revisión"
                  )
                }
              >
                Marcar en revisión
              </Button>
            ) : null}
          </>
        ) : null}
        {(active || status === "APPROVED") && (isRequester || canAuthorize) ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 md:h-9"
            disabled={pending}
            onClick={() =>
              void post(
                "cancel",
                { expectedVersion: version, notes },
                "Solicitud cancelada"
              )
            }
            data-testid="correction-cancel"
          >
            Cancelar solicitud
          </Button>
        ) : null}
      </div>
      {canAuthorize &&
      (status === "APPROVED" || status === "FAILED") &&
      executable ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Enlazar la ejecución REAL</p>
          <p className="text-muted-foreground text-xs">
            Ejecuta primero la operación legítima en su módulo (reverso real) y
            pega aquí su identificador. El sistema verifica que exista y
            corresponda; no crea movimientos.
          </p>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Id del reverso registrado"
            data-testid="correction-reference"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="h-11 md:h-9"
              disabled={pending || !reference}
              onClick={() =>
                void post(
                  "execution",
                  {
                    expectedVersion: version,
                    referenceId: reference.trim(),
                    notes: notes || undefined,
                  },
                  "Ejecución real enlazada"
                )
              }
              data-testid="correction-link"
            >
              Marcar ejecutada (verificar referencia)
            </Button>
            {status === "APPROVED" ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 md:h-9"
                disabled={pending}
                onClick={() =>
                  void post(
                    "fail",
                    { expectedVersion: version, notes },
                    "Fallo registrado"
                  )
                }
              >
                El módulo rechazó la operación
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!canAuthorize && active ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="cashier-cannot-authorize"
        >
          Solo un socio (PARTNER) o SUPERADMIN puede aprobar o rechazar esta
          solicitud.
        </p>
      ) : null}
      <ErrorLine error={error} />
    </div>
  )
}

// ── Integridad ────────────────────────────────────────────────────────

export function RunIntegrityButton() {
  const { pending, error, run, router } = useAction()
  return (
    <div className="space-y-1">
      <Button
        type="button"
        className="h-11 w-full sm:w-auto md:h-9"
        disabled={pending}
        data-testid="run-integrity"
        onClick={() =>
          void run(
            () =>
              apiRequest<{ runId: string }>("/api/admin/integrity/check", {
                method: "POST",
              }),
            "Diagnóstico completado (solo lectura)",
            (r) => router.push(`${ADMIN_BASE}/integridad/${r.runId}`)
          )
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        Ejecutar diagnóstico de integridad
      </Button>
      <ErrorLine error={error} />
    </div>
  )
}

// ── Incidencias ───────────────────────────────────────────────────────

const SEVERITIES = [
  { id: "LOW", label: "Baja" },
  { id: "MEDIUM", label: "Media" },
  { id: "HIGH", label: "Alta" },
  { id: "CRITICAL", label: "Crítica" },
]

export function IncidentCreateForm() {
  const { pending, error, run, router } = useAction()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [severity, setSeverity] = useState("MEDIUM")
  return (
    <form
      className="space-y-3"
      data-testid="incident-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest<{ id: string }>("/api/admin/incidents", {
              method: "POST",
              body: { title, description, severity },
            }),
          "Incidencia registrada",
          (r) => router.push(`${ADMIN_BASE}/incidencias/${r.id}`)
        )
      }}
    >
      <Field id="i-title" label="Título">
        <Input
          id="i-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          data-testid="incident-title"
        />
      </Field>
      <Field id="i-desc" label="Descripción">
        <TextArea
          id="i-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          data-testid="incident-description"
        />
      </Field>
      <Field id="i-sev" label="Severidad">
        <NativeSelect
          id="i-sev"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          {SEVERITIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <ErrorLine error={error} />
      <Submit pending={pending} testId="submit-incident">
        Registrar incidencia
      </Submit>
    </form>
  )
}

export function IncidentUpdateForm({
  id,
  version,
  status,
  assignedToId,
  users,
  canResolve,
}: {
  id: string
  version: number
  status: string
  assignedToId: string | null
  users: { id: string; name: string }[]
  canResolve: boolean
}) {
  const { pending, error, run } = useAction()
  const [next, setNext] = useState("")
  const [assignee, setAssignee] = useState(assignedToId ?? "")
  const [comment, setComment] = useState("")
  const [evidence, setEvidence] = useState("")
  const [resolution, setResolution] = useState("")
  const options =
    (
      {
        OPEN: ["IN_REVIEW", ...(canResolve ? ["RESOLVED", "DISMISSED"] : [])],
        IN_REVIEW: ["OPEN", ...(canResolve ? ["RESOLVED", "DISMISSED"] : [])],
        RESOLVED: canResolve ? ["OPEN"] : [],
        DISMISSED: canResolve ? ["OPEN"] : [],
      } as Record<string, string[]>
    )[status] ?? []
  const LABEL: Record<string, string> = {
    OPEN: "Reabrir / abierta",
    IN_REVIEW: "En revisión",
    RESOLVED: "Resuelta",
    DISMISSED: "Descartada",
  }
  return (
    <form
      className="space-y-3"
      data-testid="incident-update-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`/api/admin/incidents/${id}`, {
              method: "PATCH",
              body: {
                expectedVersion: version,
                ...(next ? { status: next } : {}),
                ...(assignee !== (assignedToId ?? "")
                  ? { assignedToId: assignee || null }
                  : {}),
                ...(comment ? { comment } : {}),
                ...(evidence ? { evidence } : {}),
                ...(resolution ? { resolution } : {}),
              },
            }),
          "Incidencia actualizada"
        )
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="u-status" label="Cambiar estado">
          <NativeSelect
            id="u-status"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            data-testid="incident-status"
          >
            <option value="">Sin cambio</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {LABEL[o]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="u-assign" label="Responsable">
          <NativeSelect
            id="u-assign"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            data-testid="incident-assignee"
          >
            <option value="">Sin responsable</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field id="u-comment" label="Observación">
        <TextArea
          id="u-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          data-testid="incident-comment"
        />
      </Field>
      <Field id="u-evidence" label="Evidencia (referencia)">
        <Input
          id="u-evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </Field>
      {next === "RESOLVED" || next === "DISMISSED" ? (
        <Field id="u-resolution" label="Resolución (obligatoria)">
          <TextArea
            id="u-resolution"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            required
            data-testid="incident-resolution"
          />
        </Field>
      ) : null}
      <ErrorLine error={error} />
      <Submit pending={pending} testId="submit-incident-update">
        Guardar cambios
      </Submit>
    </form>
  )
}

// ── Recuperación y mantenimiento (SUPERADMIN) ─────────────────────────

export function MaintenanceForm({ enabled }: { enabled: boolean }) {
  const { pending, error, run } = useAction()
  const [reason, setReason] = useState("")
  const [password, setPassword] = useState("")
  return (
    <form
      className="space-y-3"
      data-testid="maintenance-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest("/api/admin/maintenance", {
              method: "POST",
              body: { enabled: !enabled, reason, password },
            }),
          enabled ? "Mantenimiento desactivado" : "Mantenimiento activado"
        )
      }}
    >
      <Field id="m-reason" label="Motivo">
        <Input
          id="m-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={10}
        />
      </Field>
      <Field id="m-pass" label="Tu contraseña (confirmación de identidad)">
        <Input
          id="m-pass"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <ErrorLine error={error} />
      <Submit
        pending={pending}
        testId="toggle-maintenance"
        variant={enabled ? "outline" : "destructive"}
      >
        {enabled ? "Desactivar mantenimiento" : "Activar mantenimiento"}
      </Submit>
    </form>
  )
}

export function RecoveryRequestForm({
  backups,
}: {
  backups: { id: string; label: string }[]
}) {
  const { pending, error, run } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [backupId, setBackupId] = useState(backups[0]?.id ?? "")
  const [reason, setReason] = useState("")
  const [password, setPassword] = useState("")
  if (backups.length === 0)
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="no-recoverable-backups"
      >
        No hay respaldos exitosos y verificados: no se puede preparar una
        recuperación.
      </p>
    )
  return (
    <form
      className="space-y-3"
      data-testid="recovery-request-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest("/api/admin/recovery", {
              method: "POST",
              body: { backupId, reason, password, idempotencyKey: key },
            }),
          "Solicitud registrada (no se restauró nada)",
          () => {
            renew()
            location.reload()
          }
        )
      }}
    >
      <Field id="r-backup" label="Respaldo (punto de recuperación)">
        <NativeSelect
          id="r-backup"
          value={backupId}
          onChange={(e) => setBackupId(e.target.value)}
        >
          {backups.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="r-reason" label="Motivo (obligatorio)">
        <TextArea
          id="r-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={20}
        />
      </Field>
      <Field id="r-pass" label="Tu contraseña">
        <Input
          id="r-pass"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <ErrorLine error={error} />
      <Submit
        pending={pending}
        testId="submit-recovery-request"
        variant="destructive"
      >
        Solicitar recuperación
      </Submit>
    </form>
  )
}

export function RecoveryRequestActions({
  id,
  version,
  status,
}: {
  id: string
  version: number
  status: string
}) {
  const { pending, error, run } = useAction()
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [validationId, setValidationId] = useState("")
  const [notes, setNotes] = useState("")
  return (
    <div className="space-y-3" data-testid={`recovery-actions-${id}`}>
      {status === "REQUESTED" || status === "VALIDATING" ? (
        <div className="flex flex-wrap gap-2">
          <Input
            value={validationId}
            onChange={(e) => setValidationId(e.target.value)}
            placeholder="Id de prueba aislada APROBADA"
            className="max-w-xs"
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 md:h-9"
            disabled={pending || !validationId}
            onClick={() =>
              void run(
                () =>
                  apiRequest(`/api/admin/recovery/${id}/validation`, {
                    method: "POST",
                    body: { validationId },
                  }),
                "Prueba aislada enlazada"
              )
            }
          >
            Enlazar validación
          </Button>
        </div>
      ) : null}
      {status === "VALIDATED" ? (
        <div className="space-y-2">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Tu contraseña"
          />
          <Input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="Escribe RECUPERAR"
          />
          <Button
            type="button"
            variant="destructive"
            className="h-11 md:h-9"
            disabled={pending}
            onClick={() =>
              void run(
                () =>
                  apiRequest(`/api/admin/recovery/${id}/approve`, {
                    method: "POST",
                    body: { password, confirmation, expectedVersion: version },
                  }),
                "Aprobada: ejecútala con el procedimiento protegido (CLI)"
              )
            }
            data-testid="approve-recovery"
          >
            Aprobar recuperación
          </Button>
        </div>
      ) : null}
      {["REQUESTED", "VALIDATING", "VALIDATED", "APPROVED"].includes(status) ? (
        <div className="flex flex-wrap gap-2">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Motivo de cancelación"
            className="max-w-xs"
          />
          <Button
            type="button"
            variant="ghost"
            className="h-11 md:h-9"
            disabled={pending || notes.length < 5}
            onClick={() =>
              void run(
                () =>
                  apiRequest(`/api/admin/recovery/${id}/cancel`, {
                    method: "POST",
                    body: { notes },
                  }),
                "Solicitud cancelada"
              )
            }
          >
            Cancelar
          </Button>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  )
}
