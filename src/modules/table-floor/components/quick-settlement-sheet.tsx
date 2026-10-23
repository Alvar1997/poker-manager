"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, CircleCheck } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
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
import {
  ConfirmReturnForm,
  SettlementAmountsForm,
  SettlementSignatureCapture,
} from "@/modules/settlements/components/settlement-actions"
import type {
  SettlementSignatureStatusView,
  SettlementSummaryView,
} from "@/modules/settlements/settlement-signature.service"
import type {
  SettlementContext,
  SettlementView,
} from "@/modules/settlements/settlement.service"

import { errorText, type Occupant } from "./use-table-board"

/**
 * Liquidación desde el asiento con los MISMOS servicios del Módulo 11:
 * fichas recibidas (solo valor nominal) → deuda y compensación OPCIONAL
 * (FIFO) → firma obligatoria (incluso con $0) → confirmación física por
 * separado. Al confirmar la recepción el servidor libera el asiento; si
 * falta pagar, la participación queda SETTLING con su cuenta por pagar.
 */
export function QuickSettlementSheet({
  open,
  onOpenChange,
  occupant,
  tableName,
  cashAvailable,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  occupant: Occupant
  tableName: string
  cashAvailable: string
  onChanged: () => void
}) {
  const [settlementId, setSettlementId] = useState<string | null>(
    occupant.settlementInProgress?.id ?? null
  )
  const [finished, setFinished] = useState<string | null>(null)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="quick-settlement-sheet">
        <SheetHeader>
          <SheetTitle>Liquidar a {occupant.player.name}</SheetTitle>
          <SheetDescription>
            {tableName} · asiento {occupant.seatNumber ?? "—"}. Toda liquidación
            requiere la firma del jugador, incluso si devuelve $0.
          </SheetDescription>
        </SheetHeader>
        {finished && settlementId ? (
          <SettlementDone
            settlementId={settlementId}
            status={finished}
            onClose={() => onOpenChange(false)}
          />
        ) : settlementId ? (
          <SettlementProgress
            settlementId={settlementId}
            cashAvailable={cashAvailable}
            onChanged={onChanged}
            onFinished={(status) => {
              setFinished(status)
              onChanged()
            }}
          />
        ) : (
          <SettlementStart
            occupant={occupant}
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

function SettlementStart({
  occupant,
  onCreated,
}: {
  occupant: Occupant
  onCreated: (id: string) => void
}) {
  const ctx = useQuery({
    queryKey: ["settlement-context", occupant.participationId],
    queryFn: () =>
      apiRequest<SettlementContext>(
        `/api/settlements/context?participationId=${occupant.participationId}`
      ),
  })
  if (ctx.isLoading)
    return <p className="text-muted-foreground text-sm">Cargando…</p>
  if (ctx.isError || !ctx.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(ctx.error, "No se pudo preparar la liquidación")}
      </p>
    )
  const c = ctx.data
  if (c.activeSettlement)
    return (
      <Button
        className="h-12 w-full"
        onClick={() => onCreated(c.activeSettlement!.id)}
      >
        Continuar la liquidación {c.activeSettlement.folio}
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
        cancélalas antes de liquidar.
      </p>
    )
  return (
    <div className="space-y-4">
      {c.debts.length > 0 ? (
        <section className="space-y-1">
          <p className="text-sm font-medium">
            Deudas vigentes (más antigua primero)
          </p>
          <ul
            className="divide-y rounded-xl border text-sm"
            data-testid="quick-settlement-debts"
          >
            {c.debts.map((d) => (
              <li key={d.id} className="flex justify-between gap-2 p-2">
                <span>
                  <span className="font-mono">{d.purchaseFolio}</span>
                  <span className="text-muted-foreground block text-xs">
                    {d.tableName} · {d.sessionFolio}
                  </span>
                </span>
                <span className="tabular-nums">{formatMXN(d.balance)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <SettlementAmountsForm
        participationId={occupant.participationId}
        outstanding={c.outstandingDebt}
        onCreated={onCreated}
      />
    </div>
  )
}

function SettlementProgress({
  settlementId,
  cashAvailable,
  onChanged,
  onFinished,
}: {
  settlementId: string
  cashAvailable: string
  onChanged: () => void
  onFinished: (status: string) => void
}) {
  const qc = useQueryClient()
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
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["settlement", settlementId] }),
      qc.invalidateQueries({
        queryKey: ["settlement-signature-status", settlementId],
      }),
      qc.invalidateQueries({ queryKey: ["settlement-prepare", settlementId] }),
    ])
    onChanged()
  }
  if (settlement.isLoading || status.isLoading)
    return (
      <p className="text-muted-foreground text-sm">Cargando liquidación…</p>
    )
  if (!settlement.data || !status.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(
          settlement.error ?? status.error,
          "No se pudo cargar la liquidación"
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
  if (s.status !== "DRAFT" && s.status !== "READY_FOR_CONFIRMATION")
    return (
      <p className="rounded-xl border p-3 text-sm">
        La liquidación {s.folio} ya no está en curso.
      </p>
    )
  const valid = status.data.validSignature
  return (
    <div className="space-y-4">
      {valid?.current ? (
        <section className="space-y-3" data-testid="quick-confirm-return">
          <SummaryRows s={valid.summary} />
          <p className="flex items-center gap-2 text-sm font-medium">
            <CircleCheck className="size-4 text-emerald-600" aria-hidden />
            Firma registrada. Confirma que recibiste las fichas.
          </p>
          <ConfirmReturnForm
            settlementId={s.id}
            version={s.version}
            net={valid.summary.netPayoutAmount}
            cashAvailable={cashAvailable}
            onDone={(st) => (st === "CONFLICT" ? refresh() : onFinished(st))}
          />
        </section>
      ) : (
        <SettlementSignatureStep settlementId={s.id} onDone={refresh} />
      )}
      <Link
        href={`/dashboard/liquidaciones/${s.id}`}
        className={cn(buttonVariants({ variant: "ghost" }), "h-11 w-full")}
      >
        Abrir liquidación completa (editar o cancelar)
      </Link>
    </div>
  )
}

function SummaryRows({ s }: { s: SettlementSummaryView }) {
  const row = (label: string, value: string, strong = false) => (
    <div className={cn("flex justify-between py-1", strong && "font-semibold")}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
  return (
    <dl className="bg-muted/50 divide-y rounded-xl p-3 text-sm">
      {row("Fichas devueltas", formatMXN(s.returnedNominalAmount))}
      {row("Compensación de deuda", `− ${formatMXN(s.offsetAmount)}`)}
      {row("Deuda restante", formatMXN(s.remainingDebt))}
      {row("Pago neto al jugador", formatMXN(s.netPayoutAmount), true)}
    </dl>
  )
}

function SettlementSignatureStep({
  settlementId,
  onDone,
}: {
  settlementId: string
  onDone: () => void
}) {
  const prepared = useQuery({
    queryKey: ["settlement-prepare", settlementId],
    queryFn: () =>
      apiRequest<{ summary: SettlementSummaryView }>(
        `/api/settlements/${settlementId}/signature-summary`,
        { method: "POST" }
      ),
    staleTime: Infinity,
    retry: false,
  })
  if (prepared.isLoading)
    return (
      <p className="text-muted-foreground text-sm">Preparando el resumen…</p>
    )
  if (prepared.isError || !prepared.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(prepared.error, "No se pudo preparar la firma")}
      </p>
    )
  const s = prepared.data.summary
  return (
    <section className="space-y-3" data-testid="quick-settlement-signature">
      <SummaryRows s={s} />
      <SettlementSignatureCapture
        settlementId={settlementId}
        snapshotId={s.snapshotId}
        payloadHash={s.payloadHash}
        onDone={onDone}
      />
    </section>
  )
}

function SettlementDone({
  settlementId,
  status,
  onClose,
}: {
  settlementId: string
  status: string
  onClose: () => void
}) {
  return (
    <div className="space-y-3" data-testid="quick-settlement-done">
      <p className="flex items-start gap-2 rounded-xl border p-3 text-sm font-medium">
        <CircleCheck
          className="mt-0.5 size-5 shrink-0 text-emerald-600"
          aria-hidden
        />
        {status === "COMPLETED"
          ? "Recepción confirmada y liquidación pagada. El asiento quedó libre."
          : "Recepción confirmada. El asiento quedó libre; el pago pendiente sigue en Liquidaciones."}
      </p>
      {status !== "COMPLETED" ? (
        <Link
          href={`/dashboard/liquidaciones/${settlementId}/pagos`}
          className={cn(buttonVariants(), "h-11 w-full")}
        >
          Registrar pago pendiente
        </Link>
      ) : null}
      <Link
        href={`/dashboard/liquidaciones/${settlementId}/comprobante`}
        className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full")}
      >
        Ver comprobante
      </Link>
      <Button variant="outline" className="h-11 w-full" onClick={onClose}>
        Volver a la mesa
      </Button>
    </div>
  )
}
