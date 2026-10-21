import Link from "next/link"
import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import { getPlayerCreditReport } from "@/modules/reports/credit-report.service"
import { CreditSessions } from "@/modules/reports/components/credit-tree"
import {
  ExportButton,
  Note,
  REPORTS_BASE,
  Stat,
  StatGrid,
} from "@/modules/reports/components/report-ui"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { filtersToQuery, pageFilters } from "@/modules/reports/report.filters"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Estado de cuenta por sesión — Poker Manager" }

export default async function PlayerCreditReportPage({
  params,
  searchParams,
}: PageProps<"/dashboard/reportes/creditos/[playerId]">) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORTS_FINANCIAL,
    `${REPORTS_BASE}/creditos`
  )
  const { playerId } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(playerId)) notFound()
  const { filters } = pageFilters("credits", await searchParams)
  const r = await getPlayerCreditReport(playerId, filters).catch(
    (e: unknown) => {
      if (e instanceof NotFoundError) notFound()
      throw e
    }
  )
  // Conserva TODOS los filtros del listado (persistencia al volver).
  const back = `${REPORTS_BASE}/creditos${filtersToQuery(filters)}`
  return (
    <>
      <BackLink href={back} label="Reporte de créditos" />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1
            className="text-xl font-semibold"
            data-testid="report-player-name"
          >
            {r.player.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            Estado de cuenta por sesión de origen y por compra o recompra.
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <ExportButton report="credits" filters={{ ...filters, playerId }} />
          {can(user, PERMISSIONS.CREDITS_OPERATE) &&
          r.totals.balance !== "0.00" ? (
            <Link
              href={`/dashboard/creditos/abonos/nuevo?playerId=${playerId}`}
              className={cn(buttonVariants(), "h-11 w-full sm:w-auto md:h-9")}
              data-testid="report-register-payment"
            >
              Registrar abono (Módulo 10)
            </Link>
          ) : null}
        </div>
      </div>
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <Card>
        <CardContent>
          <StatGrid>
            <Stat
              label="Deuda total"
              value={r.totals.balance}
              strong
              testId="report-player-balance"
            />
            <Stat
              label="Sesiones con saldo"
              value={r.totals.sessionsWithBalance}
              money={false}
              testId="report-player-sessions-with-balance"
            />
            <Stat
              label="Deuda más antigua"
              value={
                r.totals.oldestOpenDebtAt
                  ? formatDate(r.totals.oldestOpenDebtAt)
                  : "—"
              }
              money={false}
            />
            <Stat
              label="Crédito original acumulado"
              value={r.totals.original}
              testId="report-player-original"
            />
            <Stat
              label="Abonos acumulados"
              value={r.totals.paymentsApplied}
              testId="report-player-paid"
            />
            <Stat label="Compensaciones" value={r.totals.offsets} />
            <Stat
              label="Transferencias por verificar"
              value={r.pendingTransfers.amount}
              hint="No reducen la deuda hasta verificarse."
            />
            <Stat
              label="Recibido sin aplicar"
              value={r.unappliedFunds}
              hint="Por devolver; no es saldo a favor."
            />
          </StatGrid>
        </CardContent>
      </Card>
      <CreditSessions sessions={r.sessions} />
      <Note>
        Cada obligación conserva su sesión, mesa y compra de origen. Los abonos
        generales se aplican por FIFO a la deuda más antigua; los pagos
        vinculados a una compra (transferencia verificada después) se quedan en
        esa compra. La fecha real de cada aplicación se muestra aparte de la
        fecha de origen de la deuda.
      </Note>
    </>
  )
}
