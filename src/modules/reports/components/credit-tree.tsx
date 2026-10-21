import { ChevronDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { formatDate, formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  DEBT_STATUS_LABEL,
  METHOD_LABEL,
  SESSION_STATUS_LABEL,
} from "@/modules/reports/components/report-ui"
import type {
  AtClosureView,
  DebtNode,
  SessionNode,
} from "@/modules/reports/report.math"

/**
 * Estado de cuenta en TRES niveles (Módulo 14): sesión de ORIGEN → compra o
 * recompra → aplicaciones. Expandible con <details> (funciona sin JS y es
 * cómodo en celular). La deuda AL CIERRE (histórica) y la deuda ACTUAL se
 * muestran en bloques distintos y nunca se mezclan.
 */

const CHANNEL: Record<string, string> = {
  VERBAL: "Verbal",
  MESSAGE: "Mensaje",
}

function Row({
  label,
  value,
  testId,
  strong,
}: {
  label: string
  value: string
  testId?: string
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn("tabular-nums", strong && "font-semibold")}
        data-testid={testId}
      >
        {formatMXN(value)}
      </dd>
    </div>
  )
}

function ClosureCompare({
  c,
  testPrefix,
}: {
  c: AtClosureView
  testPrefix: string
}) {
  return (
    <div
      className="rounded-md border border-dashed p-2 text-xs"
      data-testid={`${testPrefix}-closure`}
    >
      <p className="mb-1 font-medium">Deuda al cierre vs. deuda actual</p>
      <dl className="space-y-0.5">
        <Row
          label="Deuda al cierre (histórica)"
          value={c.balanceAtClosure}
          testId={`${testPrefix}-at-closure`}
        />
        {c.paymentsAfter !== "0.00" ? (
          <Row label="− Abonos posteriores (FIFO)" value={c.paymentsAfter} />
        ) : null}
        {c.linkedPaymentsAfter !== "0.00" ? (
          <Row
            label="− Pagos vinculados posteriores"
            value={c.linkedPaymentsAfter}
          />
        ) : null}
        {c.offsetsAfter !== "0.00" ? (
          <Row label="− Compensaciones posteriores" value={c.offsetsAfter} />
        ) : null}
        {c.reversalsAfter !== "0.00" ? (
          <Row label="+ Reversos posteriores" value={c.reversalsAfter} />
        ) : null}
        <Row
          label="= Deuda actual originada en la sesión"
          value={c.currentBalance}
          testId={`${testPrefix}-current`}
          strong
        />
      </dl>
      {!c.reconciles ? (
        <p className="text-destructive mt-1">
          La conciliación no cierra: revisa los movimientos de esta deuda.
        </p>
      ) : null}
    </div>
  )
}

function DebtDetails({ d }: { d: DebtNode }) {
  return (
    <details
      className="group rounded-md border"
      data-testid={`credit-debt-${d.purchase.folio}`}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 p-2 text-sm">
        <span className="min-w-0">
          <span className="font-medium">{d.purchase.typeLabel}</span>{" "}
          <span className="text-muted-foreground text-xs">
            {d.purchase.folio} · {d.table.name}
            {d.cycleNumber ? ` · ciclo ${d.cycleNumber}` : ""}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className="font-semibold tabular-nums"
            data-testid={`credit-debt-${d.purchase.folio}-balance`}
          >
            {formatMXN(d.balance)}
          </span>
          <ChevronDown
            className="size-4 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="space-y-2 border-t p-2 text-xs">
        <dl className="space-y-0.5">
          <Row
            label="Crédito original"
            value={d.original}
            testId={`credit-debt-${d.purchase.folio}-original`}
          />
          <Row label="Abonos aplicados (FIFO)" value={d.payments} />
          <Row label="Pagos vinculados a la compra" value={d.linkedPayments} />
          <Row label="Compensaciones con fichas" value={d.offsets} />
          {d.reversals !== "0.00" ? (
            <Row label="Reversos" value={d.reversals} />
          ) : null}
          <Row label="Saldo pendiente" value={d.balance} strong />
        </dl>
        <p className="text-muted-foreground">
          Estado:{" "}
          <Badge variant="outline">
            {DEBT_STATUS_LABEL[d.status] ?? d.status}
          </Badge>{" "}
          · Origen: {formatDateTime(d.createdAt)} · Valor nominal de la compra{" "}
          {formatMXN(d.purchase.nominalAmount)}
        </p>
        <p className="text-muted-foreground">
          Autorizó: {d.authorization.partnerName} (
          {CHANNEL[d.authorization.channel] ?? d.authorization.channel}) ·
          Firma:{" "}
          {d.signature
            ? `${d.signature.status === "VALID" ? "válida" : d.signature.status}${d.signature.signedAt ? `, ${formatDateTime(d.signature.signedAt)}` : ""}`
            : "—"}
        </p>
        {d.atClosure ? (
          <ClosureCompare
            c={d.atClosure}
            testPrefix={`credit-debt-${d.purchase.folio}`}
          />
        ) : null}
        <div>
          <p className="mb-1 font-medium">Aplicaciones</p>
          {d.applications.length === 0 ? (
            <p className="text-muted-foreground">
              Sin pagos ni compensaciones.
            </p>
          ) : (
            <ol
              className="space-y-1"
              data-testid={`credit-debt-${d.purchase.folio}-apps`}
            >
              {d.applications.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap justify-between gap-1 border-b pb-1 last:border-0"
                  data-testid="credit-application"
                >
                  <span>
                    {a.classLabel}
                    {a.paymentFolio ? ` · ${a.paymentFolio}` : ""}
                    {a.settlementFolio ? ` · ${a.settlementFolio}` : ""}
                    {a.paymentMethod
                      ? ` · ${METHOD_LABEL[a.paymentMethod] ?? a.paymentMethod}`
                      : ""}
                    <span className="text-muted-foreground block">
                      Fecha real: {formatDateTime(a.appliedAt)}
                      {a.collectedInSessionFolio
                        ? ` · cobrado en ${a.collectedInSessionFolio}`
                        : a.paymentOrigin === "ADMINISTRATIVE"
                          ? " · fuera de sesión"
                          : ""}
                      {a.paymentTotal && a.paymentTotal !== a.amount
                        ? ` · abono total ${formatMXN(a.paymentTotal)}`
                        : ""}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {a.class === "REVERSAL" ? "+" : "−"}
                    {formatMXN(a.amount)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </details>
  )
}

export function CreditSessions({ sessions }: { sessions: SessionNode[] }) {
  if (sessions.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Sin obligaciones para los filtros.
      </p>
    )
  return (
    <ul className="space-y-2" data-testid="credit-sessions">
      {sessions.map((s) => (
        <li key={s.session.id}>
          <details
            className="group rounded-lg border"
            data-testid={`credit-session-${s.session.folio}`}
          >
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 p-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  Sesión {s.session.folio}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(s.session.operatedAt)} ·{" "}
                  {SESSION_STATUS_LABEL[s.session.status] ?? s.session.status} ·{" "}
                  {s.debtsCount} obligación(es)
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-right">
                  <span className="text-muted-foreground block text-[11px]">
                    Debe
                  </span>
                  <span
                    className="font-semibold tabular-nums"
                    data-testid={`credit-session-${s.session.folio}-balance`}
                  >
                    {formatMXN(s.balance)}
                  </span>
                </span>
                <ChevronDown
                  className="size-4 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </span>
            </summary>
            <div className="space-y-3 border-t p-3">
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Crédito original</dt>
                  <dd
                    className="tabular-nums"
                    data-testid={`credit-session-${s.session.folio}-original`}
                  >
                    {formatMXN(s.original)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Abonos aplicados</dt>
                  <dd
                    className="tabular-nums"
                    data-testid={`credit-session-${s.session.folio}-paid`}
                  >
                    {formatMXN(s.paymentsApplied)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Compensaciones</dt>
                  <dd className="tabular-nums">{formatMXN(s.offsets)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Saldo actual</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMXN(s.balance)}
                  </dd>
                </div>
              </dl>
              {s.reversals !== "0.00" ? (
                <p className="text-muted-foreground text-xs">
                  Reversos de aplicaciones: {formatMXN(s.reversals)}
                </p>
              ) : null}
              {s.atClosure ? (
                <ClosureCompare
                  c={s.atClosure}
                  testPrefix={`credit-session-${s.session.folio}`}
                />
              ) : (
                <p className="text-muted-foreground text-xs">
                  Sesión aún no cerrada: no hay deuda histórica al cierre.
                </p>
              )}
              <div className="space-y-2">
                <p className="text-xs font-medium">Compras y recompras</p>
                {s.debts.map((d) => (
                  <DebtDetails key={d.id} d={d} />
                ))}
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  )
}
