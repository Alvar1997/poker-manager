import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  REPORTS_BASE,
  SESSION_STATUS_LABEL,
  Stat,
  StatGrid,
  Td,
} from "@/modules/reports/components/report-ui"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { filtersToQuery, pageFilters } from "@/modules/reports/report.filters"
import { getSessionReport } from "@/modules/reports/session-report.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Detalle de sesión — Poker Manager" }

export default async function SessionReportPage({
  params,
  searchParams,
}: PageProps<"/dashboard/reportes/sesiones/[id]">) {
  await requirePagePermission(
    PERMISSIONS.REPORTS_VIEW,
    `${REPORTS_BASE}/sesiones`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const { filters } = pageFilters("sessions", await searchParams)
  const s = await getSessionReport(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const m = s.metrics
  return (
    <>
      <BackLink
        href={`${REPORTS_BASE}/sesiones${filtersToQuery(filters)}`}
        label="Reporte de sesiones"
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1
            className="text-xl font-semibold"
            data-testid="session-report-folio"
          >
            Sesión {s.folio}
          </h1>
          <p className="text-muted-foreground text-sm">
            {SESSION_STATUS_LABEL[s.status] ?? s.status} · fecha operativa{" "}
            {s.operatedDay}
            {s.openedAt ? ` · abrió ${formatDateTime(s.openedAt)}` : ""}
            {s.closedAt ? ` · cerró ${formatDateTime(s.closedAt)}` : ""}
          </p>
        </div>
        <ExportButton report="credits" filters={{ sessionId: s.id }} />
      </div>
      <RefreshOnFocus generatedAt={new Date().toISOString()} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actividad (nominal)</CardTitle>
        </CardHeader>
        <CardContent>
          <StatGrid>
            <Stat label="Mesas utilizadas" value={m.tablesUsed} money={false} />
            <Stat label="Ciclos" value={m.cycles} money={false} />
            <Stat label="Jugadores distintos" value={m.players} money={false} />
            <Stat
              label={`Compras iniciales (${m.initialCount})`}
              value={m.initialNominal}
            />
            <Stat
              label={`Recompras (${m.rebuyCount})`}
              value={m.rebuyNominal}
            />
            <Stat label="Nominal entregado" value={m.deliveredNominal} />
            <Stat label="Nominal devuelto" value={m.returnedNominal} />
            <Stat
              label="Diferencia nominal (entregado − devuelto)"
              value={m.netNotReturned}
              hint="Con todos los jugadores terminados debe ser $0 (nadie se lleva fichas); si no, se concilia en el cierre. No es utilidad."
            />
          </StatGrid>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dinero de la sesión</CardTitle>
        </CardHeader>
        <CardContent>
          <StatGrid>
            <Stat label="Cobros en efectivo" value={m.collections.cash} />
            <Stat
              label="Transferencias verificadas"
              value={m.collections.transferConfirmed}
            />
            <Stat
              label="Terminal aprobada"
              value={m.collections.cardApproved}
            />
            <Stat
              label="Transferencias pendientes"
              value={m.collections.transferPending}
              hint="No son cobro."
            />
            <Stat
              label={`Abonos registrados (${m.debtPaymentsInSession.count})`}
              value={m.debtPaymentsInSession.amount}
            />
            <Stat label="Liquidaciones pagadas" value={m.payables.executed} />
          </StatGrid>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-testid="session-historical">
          <CardHeader>
            <CardTitle className="text-base">
              Vista histórica del cierre
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              Comprobante inmutable; los pagos posteriores no lo cambian.
            </p>
          </CardHeader>
          <CardContent>
            {s.historical ? (
              <StatGrid>
                <Stat
                  label="Créditos originados"
                  value={s.historical.creditsOriginated}
                />
                <Stat
                  label="Deuda pendiente al cierre"
                  value={s.historical.creditsOutstandingAtClosure}
                  strong
                  testId="historical-debt"
                />
                <Stat
                  label="Por pagar al cierre"
                  value={s.historical.payablesPendingAtClosure}
                />
                <Stat
                  label="Circulación global al cierre"
                  value={s.historical.globalCirculationAtClosure}
                />
                <Stat label="Efectivo final" value={s.historical.cashFinal} />
                <Stat
                  label="Comprobante"
                  value={s.historical.reportFolio}
                  money={false}
                />
              </StatGrid>
            ) : (
              <p className="text-muted-foreground text-sm">
                La sesión no tiene comprobante de cierre.
              </p>
            )}
          </CardContent>
        </Card>
        <Card data-testid="session-current">
          <CardHeader>
            <CardTitle className="text-base">
              Vista actual de obligaciones originadas aquí
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              Derivada de los movimientos vigentes (cambia con pagos
              posteriores).
            </p>
          </CardHeader>
          <CardContent>
            <StatGrid>
              <Stat
                label="Deuda actual"
                value={s.current.creditsOutstanding}
                strong
                testId="current-debt"
              />
              <Stat
                label="Abonos y pagos aplicados"
                value={s.current.paymentsAppliedSinceOrigin}
              />
              <Stat label="Compensaciones" value={s.current.offsets} />
              <Stat label="Reversos" value={s.current.reversals} />
              <Stat label="Por pagar hoy" value={s.current.payablesPending} />
              <Stat
                label="Transferencias de pago en curso"
                value={s.current.payablesInTransit}
              />
            </StatGrid>
          </CardContent>
        </Card>
      </div>

      {s.closure ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cierre</CardTitle>
          </CardHeader>
          <CardContent>
            <StatGrid>
              <Stat
                label="Diferencia de fichas"
                value={s.closure.chipCount?.difference ?? null}
              />
              <Stat
                label="Efectivo contado"
                value={s.closure.cashCount?.counted ?? null}
              />
              <Stat
                label="Efectivo retirado"
                value={s.closure.withdrawal?.amount ?? null}
                hint={
                  s.closure.withdrawal
                    ? `Recibió ${s.closure.withdrawal.recipientName}`
                    : undefined
                }
              />
              <Stat
                label={`Ajustes autorizados (${s.closure.adjustmentsCount})`}
                value={s.closure.adjustmentsTotal}
              />
              <Stat
                label="Autorizó el cierre"
                value={s.closure.approvedBy?.name ?? "—"}
                money={false}
              />
            </StatGrid>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Deudores de la sesión (hoy)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={["Jugador", "Crédito original", "Abonos", "Deuda actual"]}
            testId="session-debtors"
          >
            {s.current.players.map((p) => (
              <tr key={p.player.id}>
                <Td>
                  <Link
                    href={`${REPORTS_BASE}/creditos/${p.player.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {p.player.name}
                  </Link>
                </Td>
                <Td num>
                  <Money value={p.original} />
                </Td>
                <Td num>
                  <Money value={p.paymentsApplied} />
                </Td>
                <Td num>
                  <Money value={p.balance} />
                </Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mesas y ciclos</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={[
              "Mesa",
              "Ciclo",
              "Participantes",
              "Entregado",
              "Devuelto",
              "Transf. entrada/salida",
            ]}
          >
            {s.tables.map((t) => (
              <tr key={t.id}>
                <Td>{t.table.name}</Td>
                <Td num>{t.cycleNumber}</Td>
                <Td num>{t.participants}</Td>
                <Td num>
                  <Money value={t.deliveredNominal} />
                </Td>
                <Td num>
                  <Money value={t.returnedNominal} />
                </Td>
                <Td num>
                  {t.transfersIn} / {t.transfersOut}
                </Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      <Note>
        La fecha operativa de la sesión no es la fecha de los pagos posteriores:
        esos se consultan en el reporte de abonos con su fecha real.
      </Note>
    </>
  )
}
