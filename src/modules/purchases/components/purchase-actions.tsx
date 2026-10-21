"use client"

import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
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
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/**
 * Acciones de compras (cliente). Toda regla y todo cálculo viven en el
 * servidor: aquí solo se capturan datos, se protegen los botones contra
 * doble clic (isPending + clave de idempotencia) y se refresca la vista
 * con la respuesta del servidor. Nunca hay campos de denominaciones.
 */

const PURCHASES_BASE = "/dashboard/compras"
const MONEY = /^\d{1,10}(\.\d{1,2})?$/

function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiClientError) {
    const issue = e.fieldIssues[0]
    return issue ? issue.message : e.message
  }
  return e instanceof Error ? e.message : fallback
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})
const fmt = (v: string) => mxn.format(v as unknown as number)

function useAction<TBody>(
  url: string,
  opts: {
    method?: "POST" | "PATCH"
    success: string
    onDone?: (data: unknown) => void
  }
) {
  const router = useRouter()
  return useMutation({
    mutationFn: (body: TBody) =>
      apiRequest<unknown>(url, { method: opts.method ?? "POST", body }),
    onSuccess: (data) => {
      toast.success(opts.success)
      opts.onDone?.(data)
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo completar")),
  })
}

function Pending({ on }: { on: boolean }) {
  return on ? <Loader2 className="animate-spin" /> : null
}

/** Campo numérico grande para importes (teclado decimal en celular). */
function AmountInput({
  id,
  value,
  onChange,
  label,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  label: string
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg">
          $
        </span>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className="h-14 pl-7 text-2xl font-semibold tabular-nums md:h-12 md:text-xl"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          aria-invalid={value !== "" && !MONEY.test(value)}
        />
      </div>
    </div>
  )
}

// ── Nueva compra ──────────────────────────────────────────────────────

/** Paso 2: importe solicitado. Solo importe: el cajero elige las fichas físicamente. */
export function NewPurchaseForm({
  participationId,
  available,
}: {
  participationId: string
  available: string
}) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [key] = useIdempotencyKey()
  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>("/api/purchases", {
        method: "POST",
        body: { participationId, nominalAmount: amount, idempotencyKey: key },
      }),
    onSuccess: (p) => {
      toast.success("Compra iniciada: registra los pagos")
      router.push(`${PURCHASES_BASE}/${p.id}`)
    },
    onError: (e) => toast.error(errorText(e, "No se pudo iniciar la compra")),
  })
  const valid = MONEY.test(amount) && /[1-9]/.test(amount)
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !create.isPending) create.mutate()
      }}
    >
      <AmountInput
        id="nominalAmount"
        label="Importe solicitado"
        value={amount}
        onChange={setAmount}
      />
      <p className="text-muted-foreground text-xs" data-testid="available">
        Disponible en el inventario compartido: {fmt(available)}. No se capturan
        denominaciones: tú eliges las fichas al entregar.
      </p>
      <Button
        type="submit"
        className="h-12 w-full text-base"
        disabled={!valid || create.isPending}
        data-testid="create-purchase"
      >
        <Pending on={create.isPending} />
        Continuar a pagos
      </Button>
    </form>
  )
}

// ── Pagos ─────────────────────────────────────────────────────────────

type Method = "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT"

/** Paso 3: agrega un componente de pago (se pueden combinar varios). */
export function AddPaymentForm({
  purchaseId,
  suggested,
}: {
  purchaseId: string
  suggested: string
}) {
  const [method, setMethod] = useState<Method>("CASH")
  const [amount, setAmount] = useState(suggested === "0.00" ? "" : suggested)
  const [received, setReceived] = useState(false)
  const [reference, setReference] = useState("")
  const [sender, setSender] = useState("")
  const [result, setResult] = useState<"APPROVED" | "DECLINED" | "PENDING">(
    "APPROVED"
  )
  const [terminalId, setTerminalId] = useState("")
  const [approved, setApproved] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const reset = () => {
    renew()
    setAmount("")
    setReceived(false)
    setReference("")
    setSender("")
    setApproved(false)
  }
  const add = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/payments`,
    { success: "Pago registrado", onDone: reset }
  )
  const isCard = method === "CARD_DEBIT" || method === "CARD_CREDIT"
  const body = (): Record<string, unknown> => {
    if (method === "CASH")
      return { method, amount, cashReceived: received, idempotencyKey: key }
    if (method === "BANK_TRANSFER")
      return {
        method,
        amount,
        ...(reference ? { bankReference: reference } : {}),
        ...(sender ? { senderName: sender } : {}),
        idempotencyKey: key,
      }
    return {
      method,
      amount,
      result,
      ...(reference ? { terminalReference: reference } : {}),
      ...(terminalId ? { terminalIdentifier: terminalId } : {}),
      ...(result === "APPROVED" && approved ? { approvalConfirmed: true } : {}),
      idempotencyKey: key,
    }
  }
  const valid =
    MONEY.test(amount) &&
    /[1-9]/.test(amount) &&
    (method !== "CASH" || received) &&
    (!isCard || result !== "APPROVED" || (approved && reference.length >= 2))
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !add.isPending) add.mutate(body())
      }}
      data-testid="add-payment-form"
    >
      <div className="space-y-1">
        <Label htmlFor="method">Método</Label>
        <NativeSelect
          id="method"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as Method)
            setReference("")
            setApproved(false)
          }}
        >
          <option value="CASH">Efectivo</option>
          <option value="BANK_TRANSFER">Transferencia bancaria</option>
          <option value="CARD_DEBIT">Tarjeta de débito (terminal)</option>
          <option value="CARD_CREDIT">Tarjeta de crédito (terminal)</option>
        </NativeSelect>
      </div>
      <AmountInput
        id="paymentAmount"
        label="Importe de este pago"
        value={amount}
        onChange={setAmount}
      />
      {method === "CASH" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={received}
            onChange={(e) => setReceived(e.target.checked)}
            data-testid="cash-received"
          />
          Recibí físicamente este efectivo
        </label>
      ) : null}
      {method === "BANK_TRANSFER" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="bankReference">Referencia (opcional)</Label>
            <Input
              id="bankReference"
              className="h-11 md:h-9"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="senderName">Quién transfiere (opcional)</Label>
            <Input
              id="senderName"
              className="h-11 md:h-9"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Queda <strong>pendiente</strong>: no cuenta como cobrada hasta que
            alguien la verifique en el banco (Caja → Transferencias).
          </p>
        </>
      ) : null}
      {isCard ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="cardResult">Resultado en la terminal</Label>
            <NativeSelect
              id="cardResult"
              value={result}
              onChange={(e) =>
                setResult(e.target.value as "APPROVED" | "DECLINED" | "PENDING")
              }
            >
              <option value="APPROVED">Aprobado</option>
              <option value="DECLINED">Rechazado</option>
              <option value="PENDING">En proceso</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="terminalReference">
              Folio o autorización de la terminal
              {result === "APPROVED" ? "" : " (opcional)"}
            </Label>
            <Input
              id="terminalReference"
              className="h-11 md:h-9"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              Nunca captures el número de la tarjeta, CVV ni NIP.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="terminalIdentifier">Terminal (opcional)</Label>
            <Input
              id="terminalIdentifier"
              className="h-11 md:h-9"
              value={terminalId}
              onChange={(e) => setTerminalId(e.target.value)}
            />
          </div>
          {result === "APPROVED" ? (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
                data-testid="card-approved"
              />
              La terminal mostró el cobro como APROBADO
            </label>
          ) : null}
        </>
      ) : null}
      <Button
        type="submit"
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!valid || add.isPending}
        data-testid="add-payment"
      >
        <Pending on={add.isPending} />
        Agregar pago
      </Button>
    </form>
  )
}

/** Diálogo con motivo (y confirmación opcional) para acciones sensibles. */
function ReasonDialog({
  trigger,
  title,
  description,
  confirmLabel,
  checkboxLabel,
  pending,
  onConfirm,
  testId,
}: {
  trigger: string
  title: string
  description: ReactNode
  confirmLabel: string
  checkboxLabel?: string
  pending: boolean
  onConfirm: (reason: string) => void
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [checked, setChecked] = useState(false)
  const valid = reason.trim().length >= 5 && (!checkboxLabel || checked)
  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-8"
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        {trigger}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${testId}-reason`}>Motivo</Label>
            <Input
              id={`${testId}-reason`}
              className="h-11 md:h-9"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {checkboxLabel ? (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                {checkboxLabel}
              </label>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Volver</AlertDialogCancel>
            <Button
              disabled={!valid || pending}
              onClick={() => onConfirm(reason.trim())}
              data-testid={`${testId}-confirm`}
            >
              <Pending on={pending} />
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Acciones sobre un pago antes de entregar (devolver, retirar, resultado de terminal). */
export function PaymentActions({
  purchaseId,
  payment,
}: {
  purchaseId: string
  payment: {
    id: string
    method: Method
    status: string
    effect: string
    bankTransferStatus: string | null
  }
}) {
  const base = `/api/purchases/${purchaseId}/payments/${payment.id}`
  const cancel = useAction<Record<string, unknown>>(`${base}/cancel`, {
    success: "Pago retirado",
  })
  const card = useAction<Record<string, unknown>>(`${base}/card-result`, {
    success: "Cobro actualizado",
  })
  const [ref, setRef] = useState("")
  const [approved, setApproved] = useState(false)
  if (payment.method === "CASH" && payment.status === "CONFIRMED")
    return (
      <ReasonDialog
        trigger="Devolver"
        title="Devolver el efectivo"
        description="Retira este pago de la compra. Solo hazlo si devolviste el dinero al jugador."
        confirmLabel="Retirar pago"
        checkboxLabel="Devolví el efectivo al jugador"
        pending={cancel.isPending}
        onConfirm={(reason) => cancel.mutate({ reason, cashReturned: true })}
        testId="return-cash"
      />
    )
  if (
    payment.method === "BANK_TRANSFER" &&
    payment.status === "PENDING" &&
    payment.bankTransferStatus !== "CONFIRMED"
  )
    return (
      <ReasonDialog
        trigger="Retirar"
        title="Retirar la transferencia"
        description="La transferencia pendiente se cancela en caja. Una transferencia ya verificada no se puede descartar."
        confirmLabel="Retirar"
        pending={cancel.isPending}
        onConfirm={(reason) => cancel.mutate({ reason })}
        testId="cancel-transfer"
      />
    )
  if (
    (payment.method === "CARD_DEBIT" || payment.method === "CARD_CREDIT") &&
    payment.status === "PENDING"
  )
    return (
      <div className="w-full space-y-2">
        <Input
          aria-label="Folio o autorización de la terminal"
          placeholder="Folio de la terminal"
          className="h-11 md:h-8"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />
          La terminal mostró APROBADO
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11 md:h-8"
            disabled={card.isPending || !approved || ref.trim().length < 2}
            onClick={() =>
              card.mutate({
                result: "APPROVED",
                terminalReference: ref.trim(),
                approvalConfirmed: true,
              })
            }
          >
            <Pending on={card.isPending} />
            Aprobado
          </Button>
          <Button
            variant="outline"
            className="h-11 md:h-8"
            disabled={card.isPending}
            onClick={() => card.mutate({ result: "DECLINED" })}
          >
            Rechazado
          </Button>
        </div>
      </div>
    )
  if (
    (payment.method === "CARD_DEBIT" || payment.method === "CARD_CREDIT") &&
    payment.status === "APPROVED"
  )
    return (
      <ReasonDialog
        trigger="Anular"
        title="Anular el cobro con tarjeta"
        description="Hazlo solo si anulaste el cobro en la terminal antes de entregar las fichas."
        confirmLabel="Anular cobro"
        checkboxLabel="Anulé el cobro en la terminal"
        pending={card.isPending}
        onConfirm={(reason) => card.mutate({ result: "VOIDED", reason })}
        testId="void-card"
      />
    )
  return null
}

// ── Crédito: socio autorizador ────────────────────────────────────────

/** Paso 4: socio que autorizó el crédito (verbal o por mensaje). No es aprobación en línea. */
export function CreditAuthorizationForm({
  purchaseId,
  partners,
}: {
  purchaseId: string
  partners: { id: string; name: string }[]
}) {
  const [partnerId, setPartnerId] = useState("")
  const [channel, setChannel] = useState<"" | "VERBAL" | "MESSAGE">("")
  const [notes, setNotes] = useState("")
  const [key, renew] = useIdempotencyKey()
  const save = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/credit-authorization`,
    {
      success: "Autorización registrada",
      onDone: () => {
        renew()
        setNotes("")
      },
    }
  )
  if (partners.length === 0)
    return (
      <p className="rounded-lg border p-3 text-sm" role="alert">
        No hay socios activos para autorizar créditos. Un SUPERADMIN debe dar de
        alta o reactivar a un socio.
      </p>
    )
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (partnerId && channel && !save.isPending)
          save.mutate({
            partnerId,
            channel,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            idempotencyKey: key,
          })
      }}
      data-testid="credit-auth-form"
    >
      <div className="space-y-1">
        <Label htmlFor="partnerId">Socio que autorizó</Label>
        <NativeSelect
          id="partnerId"
          value={partnerId}
          onChange={(e) => setPartnerId(e.target.value)}
        >
          <option value="">Selecciona un socio…</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Cómo lo autorizó</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["VERBAL", "Verbal"],
              ["MESSAGE", "Por mensaje"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="has-[:checked]:border-primary flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm"
            >
              <input
                type="radio"
                name="channel"
                value={value}
                checked={channel === value}
                onChange={() => setChannel(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="authNotes">Observación (opcional)</Label>
        <Input
          id="authNotes"
          className="h-11 md:h-9"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Registras la autorización que el socio te comunicó; el sistema no le
        envía ninguna solicitud. El importe autorizado lo calcula el servidor.
      </p>
      <Button
        type="submit"
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!partnerId || !channel || save.isPending}
        data-testid="save-credit-auth"
      >
        <Pending on={save.isPending} />
        Registrar autorización
      </Button>
    </form>
  )
}

// ── Entrega ───────────────────────────────────────────────────────────

/** Apartar el importe en el inventario compartido (opcional antes de entregar). */
export function PrepareDeliveryButton({ purchaseId }: { purchaseId: string }) {
  const [key, renew] = useIdempotencyKey()
  const prepare = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/prepare-delivery`,
    { success: "Fichas apartadas por 15 minutos", onDone: renew }
  )
  return (
    <Button
      variant="outline"
      className="h-11 w-full md:h-9 md:w-auto"
      disabled={prepare.isPending}
      onClick={() => prepare.mutate({ idempotencyKey: key })}
      data-testid="prepare-delivery"
    >
      <Pending on={prepare.isPending} />
      Apartar fichas
    </Button>
  )
}

/** Paso 6: confirmación explícita de la entrega física. El éxito solo se muestra tras la respuesta del servidor. */
export function ConfirmDeliveryForm({
  purchaseId,
  version,
  blocked,
}: {
  purchaseId: string
  version: number
  blocked: boolean
}) {
  const [delivered, setDelivered] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const confirm = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/confirm-delivery`,
    {
      success: "Entrega confirmada",
      onDone: () => {
        renew()
        setDelivered(false)
      },
    }
  )
  return (
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={delivered}
          disabled={blocked}
          onChange={(e) => setDelivered(e.target.checked)}
          data-testid="physical-delivery"
        />
        Entregué físicamente las fichas al jugador
      </label>
      <Button
        className="h-12 w-full text-base"
        disabled={blocked || !delivered || confirm.isPending}
        onClick={() =>
          confirm.mutate({
            expectedVersion: version,
            physicalDeliveryConfirmed: true,
            idempotencyKey: key,
          })
        }
        data-testid="confirm-delivery"
      >
        <Pending on={confirm.isPending} />
        Confirmar entrega
      </Button>
    </div>
  )
}

export function CancelPurchaseButton({ purchaseId }: { purchaseId: string }) {
  const cancel = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/cancel`,
    { success: "Compra cancelada" }
  )
  return (
    <ReasonDialog
      trigger="Cancelar compra"
      title="¿Cancelar esta compra?"
      description="Se libera el apartado de fichas y se cancelan las transferencias pendientes. Si recibiste efectivo o aprobaste un cobro con tarjeta, primero devuélvelo o anúlalo."
      confirmLabel="Cancelar compra"
      pending={cancel.isPending}
      onConfirm={(reason) => cancel.mutate({ reason })}
      testId="cancel-purchase"
    />
  )
}

export function EditAmountForm({
  purchaseId,
  version,
  current,
}: {
  purchaseId: string
  version: number
  current: string
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(current)
  const save = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/draft`,
    {
      method: "PATCH",
      success: "Importe actualizado",
      onDone: () => setOpen(false),
    }
  )
  if (!open)
    return (
      <Button
        variant="outline"
        className="h-11 md:h-8"
        onClick={() => setOpen(true)}
        data-testid="edit-amount"
      >
        Cambiar importe
      </Button>
    )
  const valid = MONEY.test(amount) && /[1-9]/.test(amount)
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !save.isPending)
          save.mutate({ nominalAmount: amount, expectedVersion: version })
      }}
    >
      <AmountInput
        id="editAmount"
        label="Nuevo importe"
        value={amount}
        onChange={setAmount}
      />
      <p className="text-muted-foreground text-xs">
        Cambiar el importe invalida la autorización y la firma anteriores.
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          className="h-11 md:h-9"
          disabled={!valid || save.isPending}
        >
          <Pending on={save.isPending} />
          Guardar
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setOpen(false)}
        >
          Volver
        </Button>
      </div>
    </form>
  )
}

export function ReversalRequestButton({ purchaseId }: { purchaseId: string }) {
  const [key, renew] = useIdempotencyKey()
  const request = useAction<Record<string, unknown>>(
    `/api/purchases/${purchaseId}/reversal-request`,
    { success: "Solicitud de reverso registrada", onDone: renew }
  )
  return (
    <ReasonDialog
      trigger="Solicitar reverso"
      title="Solicitar el reverso"
      description="Queda registrada y auditada. No devuelve fichas ni dinero: el reverso completo exige la devolución física y la resolución financiera (módulos de créditos y liquidaciones)."
      confirmLabel="Registrar solicitud"
      pending={request.isPending}
      onConfirm={(reason) =>
        reason.length >= 10
          ? request.mutate({ reason, idempotencyKey: key })
          : toast.error("Explica el motivo (mínimo 10 caracteres)")
      }
      testId="request-reversal"
    />
  )
}
