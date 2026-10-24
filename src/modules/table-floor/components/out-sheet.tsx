"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { apiRequest } from "@/lib/api-client"
import { formatMXN } from "@/modules/cash/components/format"
import { NewCreditPaymentForm } from "@/modules/credits/components/credit-actions"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import type { SettlementSignatureStatusView } from "@/modules/settlements/settlement-signature.service"
import type {
  SettlementContext,
  SettlementView,
} from "@/modules/settlements/settlement.service"

import {
  SettlementDone,
  SettlementSignatureStep,
} from "./quick-settlement-sheet"
import { errorText, type Occupant } from "./use-table-board"

/**
 * OUT: el jugador perdió todas sus fichas. Es una liquidación SIMPLIFICADA
 * con retorno $0 de los MISMOS servicios del Módulo 11: la confirmación de
 * retorno cero se captura AQUÍ una sola vez (se guarda en la base), no hay
 * pantalla de «fichas recibidas», no hay entrada de inventario ni pago al
 * jugador, y sus deudas siguen vigentes. Abonar es OPCIONAL y usa el abono
 * real del Módulo 10 (FIFO). La firma sigue siendo obligatoria.
 */
export function OutSheet({
  open,
  onOpenChange,
  occupant,
  tableName,
  session,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  occupant: Occupant
  tableName: string
  session: { id: string; folio: string }
  onChanged: () => void
}) {
  const [settlementId, setSettlementId] = useState<string | null>(
    occupant.settlementInProgress?.id ?? null
  )
  const [finished, setFinished] = useState<string | null>(null)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="out-sheet">
        <SheetHeader>
          <SheetTitle>OUT · {occupant.player.name}</SheetTitle>
          <SheetDescription>
            {tableName} · asiento {occupant.seatNumber ?? "—"}. El jugador
            terminó sin fichas; sus deudas permanecen vigentes.
          </SheetDescription>
        </SheetHeader>
        {finished && settlementId ? (
          <SettlementDone
            settlementId={settlementId}
            status={finished}
            onClose={() => onOpenChange(false)}
          />
        ) : settlementId ? (
          <OutProgress
            settlementId={settlementId}
            onChanged={onChanged}
            onFinished={(s) => {
              setFinished(s)
              onChanged()
            }}
          />
        ) : (
          <OutStart
            occupant={occupant}
            session={session}
            onCreated={(id) => {
              setSettlementId(id)
              onChanged()
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function Row({
  label,
  value,
  strong,
  testId,
}: {
  label: string
  value: string
  strong?: boolean
  testId?: string
}) {
  return (
    <div
      className={`flex justify-between py-1 ${strong ? "font-semibold" : ""}`}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

function OutStart({
  occupant,
  session,
  onCreated,
}: {
  occupant: Occupant
  session: { id: string; folio: string }
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const [noChips, setNoChips] = useState(false)
  const [paying, setPaying] = useState(false)
  const [key] = useIdempotencyKey()
  const ctxKey = ["settlement-context", occupant.participationId]
  const ctx = useQuery({
    queryKey: ctxKey,
    queryFn: () =>
      apiRequest<SettlementContext>(
        `/api/settlements/context?participationId=${occupant.participationId}`
      ),
  })
  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>("/api/settlements", {
        method: "POST",
        body: {
          participationId: occupant.participationId,
          returnedNominalAmount: "0",
          offsetDecision: "NO_COMPENSATE",
          exitKind: "OUT",
          idempotencyKey: key,
        },
      }),
    onSuccess: (s) => onCreated(s.id),
    onError: (e) => toast.error(errorText(e, "No se pudo iniciar el OUT")),
  })
  if (ctx.isLoading)
    return <p className="text-muted-foreground text-sm">Cargando…</p>
  if (ctx.isError || !ctx.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(ctx.error, "No se pudo preparar el OUT")}
      </p>
    )
  const c = ctx.data
  if (c.activeSettlement)
    return (
      <Button
        className="h-12 w-full"
        onClick={() => onCreated(c.activeSettlement!.id)}
      >
        Continuar {c.activeSettlement.folio}
      </Button>
    )
  if (c.pendingPurchases.length > 0)
    return (
      <p
        className="flex items-start gap-2 rounded-xl border p-3 text-sm"
        role="alert"
      >
        <CircleAlert
          className="mt-0.5 size-4 shrink-0 text-amber-600"
          aria-hidden
        />
        Tiene compras sin entregar (
        {c.pendingPurchases.map((p) => p.folio).join(", ")}): confírmalas o
        cancélalas antes del OUT.
      </p>
    )
  const purchased = c.purchasedInSession
  const applied = c.debts.reduce((a, d) => a + Number(d.appliedAmount), 0)
  return (
    <div className="space-y-4">
      <dl
        className="bg-muted/50 divide-y rounded-xl p-3 text-sm"
        data-testid="out-summary"
      >
        <Row
          label={`Compras y recompras (${purchased.count})`}
          value={formatMXN(purchased.nominal)}
        />
        <Row label="· pagadas" value={formatMXN(purchased.paid)} />
        <Row label="· a crédito" value={formatMXN(purchased.credit)} />
        <Row label="Valor nominal devuelto" value={formatMXN("0")} />
        <Row
          label="Resultado individual"
          value={formatMXN((-Number(purchased.nominal)).toFixed(2))}
          testId="out-result"
        />
        <Row label="Abonos previos" value={formatMXN(applied.toFixed(2))} />
        <Row
          label="Deuda vigente (saldo actual)"
          value={formatMXN(c.outstandingDebt)}
          strong
          testId="out-debt"
        />
      </dl>
      <p className="rounded-xl border p-3 text-sm">
        El jugador terminó sin fichas. Sus deudas pendientes permanecerán
        vigentes.
      </p>
      {Number(c.outstandingDebt) > 0 ? (
        <section className="rounded-xl border p-3">
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between text-sm font-medium"
            aria-expanded={paying}
            onClick={() => setPaying((v) => !v)}
            data-testid="out-toggle-payment"
          >
            Registrar abono con dinero real (opcional)
            <span aria-hidden>{paying ? "−" : "+"}</span>
          </button>
          {paying ? (
            <div className="pt-3" data-testid="out-payment">
              <NewCreditPaymentForm
                playerId={occupant.player.id}
                outstanding={c.outstandingDebt}
                openSession={session}
                onDone={async () => {
                  setPaying(false)
                  await qc.invalidateQueries({ queryKey: ctxKey })
                }}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      <label className="flex min-h-11 items-start gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="mt-0.5 size-5"
          checked={noChips}
          onChange={(e) => setNoChips(e.target.checked)}
          data-testid="out-no-chips"
        />
        Confirmo que el jugador terminó sin fichas y no conserva fichas de esta
        participación
      </label>
      <Button
        className="h-12 w-full text-base"
        disabled={!noChips || create.isPending}
        onClick={() => create.mutate()}
        data-testid="out-continue"
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : null}
        Continuar a la firma
      </Button>
    </div>
  )
}

function OutProgress({
  settlementId,
  onChanged,
  onFinished,
}: {
  settlementId: string
  onChanged: () => void
  onFinished: (status: string) => void
}) {
  const qc = useQueryClient()
  const [key] = useIdempotencyKey()
  const settlement = useQuery({
    queryKey: ["settlement", settlementId],
    queryFn: () =>
      apiRequest<SettlementView>(`/api/settlements/${settlementId}`),
  })
  const status = useQuery({
    queryKey: ["settlement-signature-status", settlementId],
    queryFn: () =>
      apiRequest<SettlementSignatureStatusView>(
        `/api/settlements/${settlementId}/signature-summary`
      ),
  })
  const confirm = useMutation({
    mutationFn: (version: number) =>
      apiRequest<{ status: string }>(
        `/api/settlements/${settlementId}/confirm-return`,
        {
          method: "POST",
          // Retorno cero ya confirmado al iniciar el OUT: sin segunda pregunta.
          body: {
            expectedVersion: version,
            zeroReturnConfirmed: true,
            idempotencyKey: key,
          },
        }
      ),
    onSuccess: (s) => {
      toast.success("OUT registrado: el asiento quedó libre.")
      onFinished(s.status)
    },
    onError: (e) => toast.error(errorText(e, "No se pudo confirmar el OUT")),
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["settlement", settlementId] }),
      qc.invalidateQueries({
        queryKey: ["settlement-signature-status", settlementId],
      }),
    ])
    onChanged()
  }
  if (settlement.isLoading || status.isLoading)
    return <p className="text-muted-foreground text-sm">Cargando…</p>
  if (!settlement.data || !status.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(
          settlement.error ?? status.error,
          "No se pudo cargar el OUT"
        )}
      </p>
    )
  const s = settlement.data
  if (s.receivedAt)
    return (
      <SettlementDone
        settlementId={s.id}
        status={s.status}
        onClose={() => onFinished(s.status)}
      />
    )
  if (status.data.validSignature?.current)
    return (
      <div className="space-y-3" data-testid="out-confirm-step">
        <p className="rounded-xl border p-3 text-sm">
          Firma registrada. Retorno de fichas: <strong>$0</strong>. Pago al
          jugador: <strong>$0</strong>. Sus deudas siguen vigentes.
        </p>
        <Button
          className="h-12 w-full text-base"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate(s.version)}
          data-testid="out-confirm"
        >
          {confirm.isPending ? <Loader2 className="animate-spin" /> : null}
          Confirmar OUT
        </Button>
      </div>
    )
  return <SettlementSignatureStep settlementId={s.id} onDone={refresh} />
}
