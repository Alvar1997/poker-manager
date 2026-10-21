import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { listCreditPayments } from "@/modules/reports/credit-report.service"
import {
  ExportButton,
  METHOD_LABEL,
  Money,
  Note,
  PAYMENT_STATUS_LABEL,
  Pagination,
  REPORTS_BASE,
  ReportHeader,
  Stat,
  StatGrid,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"
import { purchaseTypeLabel } from "@/modules/reports/report.math"

export const metadata = { title: "Reporte de abonos — Poker Manager" }

const BASE = `${REPORTS_BASE}/abonos`

export default async function PaymentsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/abonos">) {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, BASE)
  const { filters } = pageFilters("payments", await searchParams)
  const [r, options] = await Promise.all([
    listCreditPayments(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Abonos"
        description="Cada abono una sola vez, con su fecha real y sus aplicaciones FIFO a las sesiones y compras de origen."
        actions={<ExportButton report="payments" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={[
          "playerId",
          "sessionId",
          "method",
          "status",
          "operatorId",
          "paymentFrom",
          "paymentTo",
        ]}
        statuses={Object.entries(PAYMENT_STATUS_LABEL).map(([id, label]) => ({
          id,
          label,
        }))}
        options={options}
      />
      <Card>
        <CardContent>
          <StatGrid>
            <Stat
              label="Recibido (abonos confirmados)"
              value={r.totals.received}
              strong
              testId="payments-received"
            />
            <Stat
              label="Aplicado neto"
              value={r.totals.appliedNet}
              testId="payments-applied"
            />
            <Stat label="Recibido sin aplicar" value={r.totals.unapplied} />
            <Stat
              label="Abonos confirmados"
              value={r.totals.confirmedCount}
              money={false}
            />
          </StatGrid>
        </CardContent>
      </Card>
      <ul className="space-y-2" data-testid="payments-list">
        {r.items.map((p) => (
          <li key={p.id}>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap justify-between gap-2 text-sm">
                  <span>
                    {p.folio} ·{" "}
                    <Link
                      href={`${REPORTS_BASE}/creditos/${p.player.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {p.player.name}
                    </Link>
                  </span>
                  <span
                    className="tabular-nums"
                    data-testid={`payment-${p.folio}-amount`}
                  >
                    <Money value={p.amount} />
                  </span>
                </CardTitle>
                <p className="text-muted-foreground text-xs">
                  Pagado: {formatDateTime(p.paidAt)} ·{" "}
                  {METHOD_LABEL[p.method] ?? p.method} ·{" "}
                  {p.origin === "SESSION"
                    ? `En sesión ${p.collectedInSession?.folio ?? ""}`
                    : "Administrativo (fuera de sesión)"}{" "}
                  · {PAYMENT_STATUS_LABEL[p.status] ?? p.status} · Registró{" "}
                  {p.operator.name}
                  {p.financialFolio ? ` · ${p.financialFolio}` : ""}
                </p>
              </CardHeader>
              <CardContent>
                <ol
                  className="space-y-1 text-xs"
                  data-testid={`payment-${p.folio}-allocations`}
                >
                  {p.allocations.map((a) => (
                    <li key={a.id} className="flex justify-between gap-2">
                      <span>
                        {a.kind === "REVERSAL"
                          ? "Reverso · "
                          : `#${a.order} · `}
                        Sesión de origen {a.originSession.folio} ·{" "}
                        {purchaseTypeLabel(
                          a.purchase.type,
                          a.purchase.rebuyNumber
                        )}{" "}
                        {a.purchase.folio} · {a.purchase.table}
                      </span>
                      <span className="tabular-nums">
                        {a.kind === "REVERSAL" ? "−" : ""}
                        <Money value={a.amount} />
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <Pagination
        base={BASE}
        filters={filters}
        page={r.page}
        pageSize={r.pageSize}
        total={r.total}
      />
      <Note>
        Un abono puede aplicarse a varias sesiones de origen: el recibido se
        suma una sola vez por abono y las aplicaciones suman lo aplicado. El
        filtro de sesión incluye la sesión de cobro y las sesiones de origen de
        las deudas afectadas.
      </Note>
    </>
  )
}
