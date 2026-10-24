"use client"

import { useMutation } from "@tanstack/react-query"
import {
  ArrowRightLeft,
  Armchair,
  CreditCard,
  HandCoins,
  History,
  Loader2,
  LogOut,
  ReceiptText,
  ShoppingCart,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  SEAT_STATE_LABEL,
  seatActions,
} from "@/modules/table-floor/table-floor.math"

import { PokerSeatAvatar } from "./poker-table-felt"
import { purchaseKindLabel } from "./quick-purchase-sheet"
import { errorText, type Occupant } from "./use-table-board"

export type SeatAction = "buy" | "settle" | "out" | "change-seat" | "move"

export type FloorPermissions = {
  manage: boolean
  buy: boolean
  settle: boolean
  sign: boolean
  createPlayers: boolean
  readCredits: boolean
}

/**
 * Asiento ocupado: datos y acciones según el estado DERIVADO del servidor.
 * Las compras acumuladas son lo REGISTRADO en la sesión, no las fichas que
 * el jugador tiene ahora en la mesa.
 */
export function SeatActionSheet({
  open,
  onOpenChange,
  sessionId,
  occupant,
  perms,
  onAction,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  occupant: Occupant
  perms: FloorPermissions
  onAction: (a: SeatAction) => void
  onChanged: () => void
}) {
  const allowed = seatActions(occupant.state)
  const [withdrawing, setWithdrawing] = useState(false)
  const row = (label: string, value: string, testId?: string) => (
    <div className="flex justify-between gap-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="seat-action-sheet">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <PokerSeatAvatar
              name={occupant.player.name}
              state={occupant.state}
              className="size-11 text-sm sm:size-11"
            />
            <div className="min-w-0">
              <SheetTitle data-testid="seat-sheet-player">
                {occupant.player.name}
              </SheetTitle>
              <SheetDescription>
                {occupant.player.nickname
                  ? `${occupant.player.nickname} · `
                  : ""}
                Asiento {occupant.seatNumber ?? "sin asignar"} ·{" "}
                <span data-testid="seat-sheet-state">
                  {SEAT_STATE_LABEL[occupant.state]}
                </span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <dl className="bg-muted/40 mb-4 divide-y rounded-xl px-3 text-sm">
          {row(
            "Compras de la sesión",
            `${occupant.sessionPurchases} (${occupant.rebuys} recompra${occupant.rebuys === 1 ? "" : "s"})`,
            "seat-sheet-purchases"
          )}
          {row(
            "Acumulado registrado",
            formatMXN(occupant.sessionNominal),
            "seat-sheet-nominal"
          )}
          {row(
            "Deuda global",
            formatMXN(occupant.debt.global),
            "seat-sheet-debt"
          )}
          {row("Deuda de esta sesión", formatMXN(occupant.debt.session))}
          {occupant.pendingPurchase
            ? row(
                "Compra en preparación",
                `${occupant.pendingPurchase.folio} · ${formatMXN(occupant.pendingPurchase.nominalAmount)}`
              )
            : null}
          {occupant.settlementInProgress
            ? row("Liquidación en curso", occupant.settlementInProgress.folio)
            : null}
        </dl>
        <p className="text-muted-foreground -mt-2 mb-4 text-xs">
          El acumulado es lo registrado en compras confirmadas de la sesión, no
          las fichas que tiene ahora.
        </p>

        {withdrawing ? (
          <WithdrawForm
            sessionId={sessionId}
            occupant={occupant}
            onCancel={() => setWithdrawing(false)}
            onDone={() => {
              setWithdrawing(false)
              onChanged()
              onOpenChange(false)
            }}
          />
        ) : (
          <div className="grid gap-2">
            {perms.buy && allowed.continuePurchase ? (
              <Button
                className="h-12 text-base"
                onClick={() => onAction("buy")}
                data-testid="seat-continue-purchase"
              >
                <ShoppingCart />
                Continuar compra pendiente
              </Button>
            ) : null}
            {perms.buy && allowed.buy ? (
              <Button
                className="h-12 text-base"
                onClick={() => onAction("buy")}
                data-testid="seat-buy"
              >
                <ShoppingCart />
                {occupant.nextPurchase.purchaseType === "INITIAL_PURCHASE"
                  ? "Compra inicial"
                  : `+ ${purchaseKindLabel(occupant)}`}
              </Button>
            ) : null}
            {perms.settle && allowed.out ? (
              <Button
                variant="outline"
                className="h-12 text-base"
                onClick={() => onAction("out")}
                data-testid="seat-out"
              >
                <LogOut />
                OUT (perdió todas sus fichas)
              </Button>
            ) : null}
            {perms.settle && allowed.settle ? (
              <Button
                variant={occupant.state === "SETTLING" ? "default" : "outline"}
                className="h-12 text-base"
                onClick={() => onAction("settle")}
                data-testid="seat-settle"
              >
                <HandCoins />
                {occupant.state === "SETTLING"
                  ? "Continuar liquidación"
                  : "Cashout (entrega fichas)"}
              </Button>
            ) : null}
            {perms.manage && allowed.move ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-12"
                  onClick={() => onAction("change-seat")}
                  data-testid="seat-change"
                >
                  <Armchair />
                  {occupant.seatNumber === null
                    ? "Asignar asiento"
                    : "Cambiar asiento"}
                </Button>
                <Button
                  variant="outline"
                  className="h-12"
                  onClick={() => onAction("move")}
                  data-testid="seat-move"
                >
                  <ArrowRightLeft />
                  Mover de mesa
                </Button>
              </div>
            ) : null}
            {perms.manage && allowed.withdraw ? (
              <Button
                variant="ghost"
                className="h-11"
                onClick={() => setWithdrawing(true)}
                data-testid="seat-withdraw"
              >
                <LogOut />
                Retirar sin compra
              </Button>
            ) : null}
            <div className="grid grid-cols-3 gap-2 border-t pt-3">
              <Link
                href={`/dashboard/jugadores/${occupant.player.id}`}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-14 flex-col gap-0.5 text-xs"
                )}
              >
                <History />
                Historial
              </Link>
              {perms.readCredits ? (
                <Link
                  href={`/dashboard/creditos/jugadores/${occupant.player.id}`}
                  className={cn(
                    buttonVariants({ variant: "ghost" }),
                    "h-14 flex-col gap-0.5 text-xs"
                  )}
                >
                  <CreditCard />
                  Créditos
                </Link>
              ) : (
                <span />
              )}
              <Link
                href={`/dashboard/compras?sessionId=${sessionId}&playerId=${occupant.player.id}`}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-14 flex-col gap-0.5 text-xs"
                )}
              >
                <ReceiptText />
                Comprobantes
              </Link>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Retiro sin compra: solo si nunca recibió fichas (lo revalida el servidor). */
function WithdrawForm({
  sessionId,
  occupant,
  onCancel,
  onDone,
}: {
  sessionId: string
  occupant: Occupant
  onCancel: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const [key, renew] = useIdempotencyKey()
  const withdraw = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/sessions/${sessionId}/participations/${occupant.participationId}/withdraw`,
        { method: "POST", body: { reason: reason.trim(), idempotencyKey: key } }
      ),
    onSuccess: () => {
      renew()
      toast.success(`${occupant.player.name} se retiró sin compra`)
      onDone()
    },
    onError: (e) => {
      renew()
      toast.error(errorText(e, "No se pudo retirar"))
    },
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (reason.trim().length >= 5 && !withdraw.isPending) withdraw.mutate()
      }}
      data-testid="withdraw-form"
    >
      <p className="text-sm">
        Solo para quien <strong>nunca recibió fichas</strong>. Si ya compró, su
        salida es una liquidación.
      </p>
      <div className="space-y-1">
        <Label htmlFor="withdraw-reason">Motivo</Label>
        <Input
          id="withdraw-reason"
          className="h-12 text-base"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="withdraw-reason"
        />
      </div>
      <Button
        type="submit"
        className="h-12 w-full"
        disabled={reason.trim().length < 5 || withdraw.isPending}
        data-testid="confirm-withdraw"
      >
        {withdraw.isPending ? <Loader2 className="animate-spin" /> : null}
        Retirar de la mesa
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full"
        onClick={onCancel}
      >
        Volver
      </Button>
    </form>
  )
}
