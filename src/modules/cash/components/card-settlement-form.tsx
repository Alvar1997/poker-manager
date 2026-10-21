"use client"

import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

type CardPayment = {
  id: string
  kind: "PURCHASE" | "CREDIT_PAYMENT"
  method: string
  amount: string
  terminalReference: string | null
  reference: { folio: string; playerName: string; context: string }
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})

/**
 * Registra el depósito de la terminal que liquida cobros aprobados. El
 * bruto lo calcula el servidor; aquí solo se suman los importes mostrados
 * como referencia visual (centavos enteros, sin flotantes).
 */
export function CardSettlementForm({ payments }: { payments: CardPayment[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<string[]>([])
  const [deposited, setDeposited] = useState("")
  const [reference, setReference] = useState("")
  const [notes, setNotes] = useState("")
  const [verified, setVerified] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const cents = (v: string) => {
    const [i, d = ""] = v.split(".")
    return Number(i) * 100 + Number((d + "00").slice(0, 2))
  }
  const grossCents = payments
    .filter((p) => selected.includes(p.id))
    .reduce((acc, p) => acc + cents(p.amount), 0)
  const save = useMutation({
    mutationFn: () =>
      apiRequest("/api/cash-box/card-settlements", {
        method: "POST",
        body: {
          paymentIds: selected,
          depositedAmount: deposited,
          ...(reference ? { bankReference: reference } : {}),
          ...(notes ? { notes } : {}),
          depositVerified: verified,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      toast.success("Depósito registrado")
      renew()
      setSelected([])
      setDeposited("")
      setReference("")
      setNotes("")
      setVerified(false)
      router.refresh()
    },
    onError: (e) =>
      toast.error(
        e instanceof ApiClientError
          ? (e.fieldIssues[0]?.message ?? e.message)
          : "No se pudo registrar"
      ),
  })
  const valid =
    selected.length > 0 && /^\d{1,10}(\.\d{1,2})?$/.test(deposited) && verified
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !save.isPending) save.mutate()
      }}
    >
      <ul className="space-y-2">
        {payments.map((p) => (
          <li key={p.id}>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  setSelected((s) =>
                    e.target.checked
                      ? [...s, p.id]
                      : s.filter((x) => x !== p.id)
                  )
                }
              />
              <span className="flex-1">
                <span className="font-medium">
                  {mxn.format(p.amount as unknown as number)}
                </span>{" "}
                · {p.method === "CARD_DEBIT" ? "Débito" : "Crédito"} ·{" "}
                {p.terminalReference ?? "sin folio"}
                <span className="text-muted-foreground block text-xs">
                  {p.reference.folio} · {p.reference.playerName} ·{" "}
                  {p.reference.context}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-sm" data-testid="settlement-gross">
        Bruto seleccionado: {mxn.format(grossCents / 100)}
      </p>
      <div className="space-y-1">
        <Label htmlFor="deposited">Importe depositado en el banco</Label>
        <Input
          id="deposited"
          inputMode="decimal"
          className="h-12 text-lg tabular-nums"
          value={deposited}
          onChange={(e) => setDeposited(e.target.value.replace(/[^\d.]/g, ""))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bankRef">Referencia del depósito (opcional)</Label>
        <Input
          id="bankRef"
          className="h-11 md:h-9"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="settleNotes">
          Notas (obligatorias si el depósito es menor que el bruto)
        </Label>
        <Input
          id="settleNotes"
          className="h-11 md:h-9"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
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
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={!valid || save.isPending}
      >
        {save.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar depósito
      </Button>
    </form>
  )
}
