"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
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
 * Acciones de créditos (cliente). Los saldos, la distribución FIFO, la
 * sesión y el custodio los decide el SERVIDOR; aquí solo se capturan datos.
 * La vista previa FIFO es informativa (el servidor recalcula al confirmar).
 */

export const CREDITS_BASE = "/dashboard/creditos"
const MONEY = /^\d{1,10}(\.\d{1,2})?$/
const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})
const fmt = (v: string) => mxn.format(v as unknown as number)

function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : fallback
}

type Preview =
  | {
      valid: true
      outstanding: string
      remaining: string
      allocations: {
        receivableId: string
        order: number
        purchaseFolio: string
        tableName: string
        sessionFolio: string
        amount: string
        balanceAfter: string
      }[]
    }
  | { valid: false; outstanding: string; message: string; allocations: [] }

type Method = "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT"

export function NewCreditPaymentForm({
  playerId,
  outstanding,
  openSession,
}: {
  playerId: string
  outstanding: string
  openSession: { id: string; folio: string } | null
}) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<Method>("CASH")
  const [origin, setOrigin] = useState<"SESSION" | "ADMINISTRATIVE">(
    openSession ? "SESSION" : "ADMINISTRATIVE"
  )
  const [received, setReceived] = useState(false)
  const [reference, setReference] = useState("")
  const [approved, setApproved] = useState(false)
  const [result, setResult] = useState<"APPROVED" | "DECLINED">("APPROVED")
  const [key] = useIdempotencyKey()
  const validAmount = MONEY.test(amount) && /[1-9]/.test(amount)
  const preview = useQuery({
    queryKey: ["fifo-preview", playerId, amount],
    queryFn: () =>
      apiRequest<Preview>(
        `/api/credits/players/${playerId}/fifo-preview?amount=${encodeURIComponent(amount)}`
      ),
    enabled: validAmount,
  })
  const isCard = method === "CARD_DEBIT" || method === "CARD_CREDIT"
  const submit = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>("/api/credits/payments", {
        method: "POST",
        body: {
          playerId,
          amount,
          origin,
          method,
          ...(method === "CASH" ? { cashReceived: received } : {}),
          ...(method === "BANK_TRANSFER" && reference
            ? { bankReference: reference }
            : {}),
          ...(isCard
            ? {
                result,
                ...(reference ? { terminalReference: reference } : {}),
                ...(result === "APPROVED" && approved
                  ? { approvalConfirmed: true }
                  : {}),
              }
            : {}),
          idempotencyKey: key,
        },
      }),
    onSuccess: (p) => {
      toast.success(
        method === "BANK_TRANSFER"
          ? "Transferencia registrada: pendiente de verificación"
          : "Abono registrado"
      )
      router.push(`${CREDITS_BASE}/abonos/${p.id}`)
    },
    onError: (e) => toast.error(errorText(e, "No se pudo registrar el abono")),
  })
  const previewOk = preview.data?.valid === true
  const ready =
    validAmount &&
    previewOk &&
    (method !== "CASH" || received) &&
    (!isCard || result === "DECLINED" || (approved && reference.length >= 2))
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !submit.isPending) submit.mutate()
      }}
      data-testid="credit-payment-form"
    >
      <p className="text-sm">
        Deuda pendiente:{" "}
        <strong data-testid="form-outstanding">{fmt(outstanding)}</strong>
      </p>
      <div className="space-y-1">
        <Label htmlFor="amount">Importe del abono</Label>
        <div className="relative">
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg">
            $
          </span>
          <Input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-14 pl-7 text-2xl font-semibold tabular-nums md:h-12 md:text-xl"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="origin">Dónde se recibe</Label>
        <NativeSelect
          id="origin"
          value={origin}
          onChange={(e) =>
            setOrigin(e.target.value as "SESSION" | "ADMINISTRATIVE")
          }
        >
          {openSession ? (
            <option value="SESSION">Sesión abierta {openSession.folio}</option>
          ) : null}
          <option value="ADMINISTRATIVE">
            Administrativo (fuera de sesión)
          </option>
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          {origin === "SESSION"
            ? "El efectivo entra a la caja central de la sesión abierta."
            : "No toca ninguna caja de sesión: el efectivo queda bajo tu custodia hasta depositarlo."}
        </p>
      </div>
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
      {method === "CASH" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={received}
            onChange={(e) => setReceived(e.target.checked)}
            data-testid="credit-cash-received"
          />
          Recibí físicamente este efectivo
        </label>
      ) : null}
      {method === "BANK_TRANSFER" ? (
        <div className="space-y-1">
          <Label htmlFor="ref">Referencia (opcional)</Label>
          <Input
            id="ref"
            className="h-11 md:h-9"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Queda pendiente: la deuda no baja hasta que alguien verifique la
            transferencia.
          </p>
        </div>
      ) : null}
      {isCard ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="cardResult">Resultado en la terminal</Label>
            <NativeSelect
              id="cardResult"
              value={result}
              onChange={(e) =>
                setResult(e.target.value as "APPROVED" | "DECLINED")
              }
            >
              <option value="APPROVED">Aprobado</option>
              <option value="DECLINED">Rechazado</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="termRef">Folio o autorización de la terminal</Label>
            <Input
              id="termRef"
              className="h-11 md:h-9"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              Nunca captures el número de la tarjeta, CVV ni NIP.
            </p>
          </div>
          {result === "APPROVED" ? (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              La terminal mostró el cobro como APROBADO
            </label>
          ) : null}
        </>
      ) : null}

      <div
        className="rounded-lg border p-3 text-sm"
        data-testid="fifo-preview"
        aria-live="polite"
      >
        <p className="font-medium">Vista previa FIFO</p>
        {!validAmount ? (
          <p className="text-muted-foreground text-xs">
            Captura un importe para ver cómo se aplicará.
          </p>
        ) : preview.isLoading ? (
          <p className="text-muted-foreground text-xs">Calculando…</p>
        ) : preview.data && !preview.data.valid ? (
          <p className="text-destructive" role="alert" data-testid="fifo-error">
            {preview.data.message}
          </p>
        ) : preview.data?.valid ? (
          <>
            <ol className="mt-1 space-y-1">
              {preview.data.allocations.map((a) => (
                <li
                  key={a.receivableId}
                  className="flex justify-between gap-2 text-xs"
                >
                  <span>
                    {a.order}. {a.purchaseFolio} · {a.tableName} ·{" "}
                    {a.sessionFolio}
                  </span>
                  <span className="tabular-nums">
                    {fmt(a.amount)} → resta {fmt(a.balanceAfter)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-1 text-xs">
              Deuda después del abono:{" "}
              <strong>{fmt(preview.data.remaining)}</strong>
            </p>
          </>
        ) : null}
      </div>
      <Button
        type="submit"
        className="h-12 w-full text-base"
        disabled={!ready || submit.isPending}
        data-testid="submit-credit-payment"
      >
        {submit.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar abono
      </Button>
    </form>
  )
}

export function VerifyTransferButton({ paymentId }: { paymentId: string }) {
  const router = useRouter()
  const [checked, setChecked] = useState(false)
  const verify = useMutation({
    mutationFn: () =>
      apiRequest(`/api/credits/payments/${paymentId}/confirm`, {
        method: "POST",
        body: { verifiedInBank: true },
      }),
    onSuccess: () => {
      toast.success("Transferencia verificada y aplicada por FIFO")
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo verificar")),
  })
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          data-testid="verified-in-bank"
        />
        Verifiqué el ingreso en la cuenta bancaria
      </label>
      <Button
        className="h-11 w-full sm:w-auto"
        disabled={!checked || verify.isPending}
        onClick={() => verify.mutate()}
        data-testid="verify-transfer"
      >
        {verify.isPending ? <Loader2 className="animate-spin" /> : null}
        Confirmar transferencia
      </Button>
    </div>
  )
}

export function ReversePaymentButton({ paymentId }: { paymentId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [returned, setReturned] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const reverse = useMutation({
    mutationFn: () =>
      apiRequest(`/api/credits/payments/${paymentId}/reverse`, {
        method: "POST",
        body: {
          reason: reason.trim(),
          moneyReturned: true,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      setOpen(false)
      toast.success("Abono revertido")
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo revertir")),
  })
  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => setOpen(true)}
        data-testid="reverse-payment"
      >
        Revertir abono
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !reverse.isPending && setOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revertir abono</AlertDialogTitle>
            <AlertDialogDescription>
              Se registran contraasientos del dinero y de las aplicaciones; nada
              se borra y el comprobante queda anulado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reverse-reason">Motivo</Label>
            <Input
              id="reverse-reason"
              className="h-11 md:h-9"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={returned}
                onChange={(e) => setReturned(e.target.checked)}
              />
              Devolví el dinero al jugador (o anulé el cobro en la terminal)
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverse.isPending}>
              Volver
            </AlertDialogCancel>
            <Button
              disabled={
                reason.trim().length < 10 || !returned || reverse.isPending
              }
              onClick={() => reverse.mutate()}
            >
              {reverse.isPending ? <Loader2 className="animate-spin" /> : null}
              Revertir
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function CustodyDepositForm({
  custodians,
}: {
  custodians: { id: string; name: string; balance: string }[]
}) {
  const router = useRouter()
  const [custodianUserId, setCustodian] = useState(custodians[0]?.id ?? "")
  const [amount, setAmount] = useState("")
  const [reference, setReference] = useState("")
  const [verified, setVerified] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const deposit = useMutation({
    mutationFn: () =>
      apiRequest("/api/credits/administrative/custody/deposit", {
        method: "POST",
        body: {
          custodianUserId,
          amount,
          ...(reference ? { bankReference: reference } : {}),
          depositVerified: verified,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      setAmount("")
      setReference("")
      setVerified(false)
      toast.success("Depósito registrado")
      router.refresh()
    },
    onError: (e) =>
      toast.error(errorText(e, "No se pudo registrar el depósito")),
  })
  const valid =
    custodianUserId && MONEY.test(amount) && /[1-9]/.test(amount) && verified
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !deposit.isPending) deposit.mutate()
      }}
      data-testid="custody-deposit-form"
    >
      <div className="space-y-1">
        <Label htmlFor="custodian">Custodio</Label>
        <NativeSelect
          id="custodian"
          value={custodianUserId}
          onChange={(e) => setCustodian(e.target.value)}
        >
          {custodians.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {fmt(c.balance)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="depositAmount">Importe depositado</Label>
        <Input
          id="depositAmount"
          inputMode="decimal"
          className="h-12 text-lg tabular-nums"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="depositRef">Referencia del depósito (opcional)</Label>
        <Input
          id="depositRef"
          className="h-11 md:h-9"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
        />
        Verifiqué el depósito en la cuenta bancaria
      </label>
      <Button
        type="submit"
        className="h-11 w-full sm:w-auto"
        disabled={!valid || deposit.isPending}
        data-testid="custody-deposit"
      >
        {deposit.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar depósito
      </Button>
    </form>
  )
}
