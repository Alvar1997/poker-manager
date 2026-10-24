import { notFound } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import {
  RakeCorrectionForm,
  RakeCountForm,
  RakeEntryForm,
  RakeModeForm,
} from "@/modules/rake/components/rake-actions"
import { getTableRake } from "@/modules/rake/rake.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../../../back-link"

export const metadata = { title: "Rake de la mesa — Poker Manager" }

const MODE: Record<string, string> = {
  MANUAL: "Captura manual",
  FINAL_COUNT: "Conteo final",
}
const STATUS: Record<string, string> = {
  OPEN: "Mesa abierta",
  COUNT_PENDING: "Falta contar el recipiente",
  NOT_VERIFIED: "Sin conteo de comprobación",
  RECONCILED: "Conciliado",
  DIFFERENCE: "Con diferencia",
}

/**
 * Rake de la casa por mesa (Módulo 18). Las propinas al staff NO se
 * descuentan del rake: se capturan aparte en la sesión → Propinas.
 */
export default async function TableRakePage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/mesas/[tableId]/rake">) {
  const { id, tableId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.RAKE_READ,
    `${SESSIONS_BASE}/${id}/mesas/${tableId}`
  )
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(tableId)
  )
    notFound()
  const r = await getTableRake(id, tableId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const live = r.session.status === "OPEN" || r.session.status === "CLOSING"
  const operate = live && can(user, PERMISSIONS.RAKE_OPERATE)
  const hasOpen = r.cycles.some((c) => c.status === "OPEN")
  const closedUncounted = r.cycles.filter(
    (c) => c.status === "CLOSED" && !c.count
  )
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/mesas/${tableId}`}
        label={r.table.name}
      />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Rake · {r.table.name}</h1>
        <p className="text-muted-foreground text-sm">
          {r.session.folio} · modalidad{" "}
          <strong data-testid="rake-mode-label">
            {MODE[r.table.rakeMode]}
          </strong>
          . El rake es de la casa; las propinas directas al staff no lo reducen.
        </p>
      </div>
      <dl
        className="grid grid-cols-2 gap-3 rounded-xl border p-3 text-sm sm:grid-cols-4"
        data-testid="rake-totals"
      >
        <div>
          <dt className="text-muted-foreground text-xs">Rake reconocido</dt>
          <dd className="font-semibold tabular-nums" data-testid="rake-total">
            {formatMXN(r.totals.recognized)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Movimientos</dt>
          <dd className="tabular-nums">
            {r.cycles.reduce((a, c) => a + c.movementCount, 0)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Ciclos sin conteo</dt>
          <dd>{r.totals.cyclesPendingCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Con diferencia</dt>
          <dd>{r.totals.cyclesWithDifference}</dd>
        </div>
      </dl>
      {operate &&
      r.table.rakeMode === "MANUAL" &&
      (hasOpen || closedUncounted.length > 0) ? (
        <Card>
          <CardContent className="pt-4">
            <RakeEntryForm
              sessionId={id}
              tableId={tableId}
              closedCycles={closedUncounted.map((c) => ({
                id: c.id,
                label: `Ciclo #${c.cycleNumber}`,
              }))}
            />
          </CardContent>
        </Card>
      ) : null}
      {r.cycles.map((c) => (
        <section
          key={c.id}
          className="space-y-2 rounded-xl border p-3"
          data-testid="rake-cycle"
          data-status={c.rakeStatus}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Ciclo #{c.cycleNumber} · {MODE[c.mode]}
            </h2>
            <span className="text-xs" data-testid="rake-cycle-status">
              {STATUS[c.rakeStatus]}
            </span>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Registrado</dt>
              <dd className="tabular-nums">{formatMXN(c.registered)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Contado</dt>
              <dd className="tabular-nums" data-testid="rake-counted">
                {c.counted ? formatMXN(c.counted) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Diferencia</dt>
              <dd className="tabular-nums" data-testid="rake-difference">
                {c.difference ? formatMXN(c.difference) : "—"}
              </dd>
            </div>
          </dl>
          {c.movements.length > 0 ? (
            <ul
              className="divide-y rounded-lg border text-sm"
              data-testid="rake-history"
            >
              {c.movements.map((m) => (
                <li key={m.id} className="flex justify-between gap-2 p-2">
                  <span>
                    {formatDateTime(m.effectiveAt)}
                    {m.late ? (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        · capturado {formatDateTime(m.recordedAt)}
                      </span>
                    ) : null}
                    {m.kind === "CORRECTION"
                      ? ` · corrección: ${m.reason}`
                      : ""}
                  </span>
                  <span className="tabular-nums">
                    {formatMXN(m.amount)}{" "}
                    <span className="text-muted-foreground text-xs">
                      (acum. {formatMXN(m.cumulative)})
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {operate && c.status === "CLOSED" && !c.count ? (
            <RakeCountForm
              sessionId={id}
              tableId={tableId}
              cycleId={c.id}
              registered={c.registered}
              mode={c.mode}
            />
          ) : null}
          {c.rakeStatus === "DIFFERENCE" && c.difference ? (
            <p
              className="rounded-lg border border-amber-500/60 p-3 text-sm"
              role="status"
              data-testid="rake-difference-hint"
            >
              {c.difference.startsWith("-")
                ? `El conteo encontró ${formatMXN(c.difference.slice(1))} MENOS de lo registrado. Si fue un error de captura, corrígelo; si no, la diferencia se conserva.`
                : `El conteo encontró ${formatMXN(c.difference)} que no se registraron durante la mesa. Para que cuenten como rake, usa «Corregir» → «Diferencia del conteo» con el motivo.`}
            </p>
          ) : null}
          {operate &&
          (c.movements.some((m) => m.kind === "MANUAL_ENTRY") || c.count) ? (
            <RakeCorrectionForm
              countTarget={!!c.count}
              sessionId={id}
              tableId={tableId}
              cycleId={c.id}
              targets={c.movements
                .filter((m) => m.kind === "MANUAL_ENTRY")
                .map((m) => ({
                  id: m.id,
                  label: `${formatDateTime(m.effectiveAt)} · ${formatMXN(m.amount)}`,
                }))}
              suggested={
                c.rakeStatus === "DIFFERENCE"
                  ? (c.difference ?? undefined)
                  : undefined
              }
            />
          ) : null}
        </section>
      ))}
      {can(user, PERMISSIONS.RAKE_AUTHORIZE) ? (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <h2 className="text-sm font-semibold">Modalidad de la mesa</h2>
            <p className="text-muted-foreground text-xs">
              Se cambia con la mesa cerrada y sin rake pendiente de contar
              (evita duplicar registros).
            </p>
            <RakeModeForm tableId={tableId} mode={r.table.rakeMode} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
