import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  KeyValue,
  LinkButton,
  PageHeader,
} from "@/modules/admin/components/admin-ui"
import { getBankingDashboard } from "@/modules/banking/banking-query.service"
import { BANKING_BASE } from "@/modules/banking/components/labels"
import { formatMXN } from "@/modules/cash/components/format"

export const metadata = { title: "Bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function BankingDashboard() {
  const user = await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    BANKING_BASE
  )
  const d = await getBankingDashboard()
  const canExport = can(user, PERMISSIONS.REPORTS_EXPORT)
  return (
    <>
      <PageHeader
        title="Bancaje (privado)"
        description="Jugadores financiados por la casa: ciclos de cuatro jugadas, anticipos, reservas y cortes. Nada de esto aparece en la mesa."
        actions={
          canExport ? (
            <a
              href="/api/admin/banking/reports/export?format=xlsx"
              className="inline-flex h-11 items-center rounded-lg border px-3 text-sm md:h-9"
              data-testid="banking-export"
            >
              Exportar XLSX
            </a>
          ) : null
        }
      />
      <p
        className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-xs"
        data-testid="banking-rules"
      >
        Los importes CONTABLES (resultados, participaciones, reservas, pérdidas)
        no son dinero en caja. Solo los pagos ejecutados son movimientos reales.
        No se declara utilidad neta de la casa.
      </p>
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-testid="banking-dashboard"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Operación</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <KeyValue label="Jugadores con acuerdo" testId="dash-active">
                {d.activeAgreements}
              </KeyValue>
              <KeyValue label="Ciclos en curso">{d.cycles.inProgress}</KeyValue>
              <KeyValue label="Listos para corte" testId="dash-ready">
                {d.cycles.ready}
              </KeyValue>
              <KeyValue label="Cortes por aprobar" testId="dash-closings">
                {d.closingsPending}
              </KeyValue>
              <KeyValue label="Retiros por aprobar">
                {d.withdrawalsPending}
              </KeyValue>
              <KeyValue label="Cambios de % por aprobar">
                {d.changesPending}
              </KeyValue>
              <KeyValue label="Regularizaciones abiertas">
                {d.regularizationsOpen}
              </KeyValue>
              <KeyValue label="Ciclos en regularización">
                {d.cycles.regularization}
              </KeyValue>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Importes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">
              Contables (no son dinero)
            </p>
            <dl className="grid grid-cols-2 gap-3">
              <KeyValue label="Reservas positivas" testId="dash-reserves">
                {formatMXN(d.accounting.reserves)}
              </KeyValue>
              <KeyValue label="Pérdidas por recuperar">
                {formatMXN(d.accounting.pendingLosses)}
              </KeyValue>
            </dl>
            <p className="text-muted-foreground text-xs">Dinero real</p>
            <dl className="grid grid-cols-2 gap-3">
              <KeyValue label="Anticipos entregados" testId="dash-advances">
                {formatMXN(d.money.advancesPaid)}
              </KeyValue>
              <KeyValue label="Pagado (total)">
                {formatMXN(d.money.paidTotal)}
              </KeyValue>
              <KeyValue label="Transferencias en trámite">
                {formatMXN(d.money.inTransit)}
              </KeyValue>
              <KeyValue label="Pagos pendientes" testId="dash-pending">
                {formatMXN(d.money.pendingPayables)}
              </KeyValue>
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-wrap gap-2">
        <LinkButton
          href={`${BANKING_BASE}/jugadores`}
          variant="default"
          testId="go-banked-players"
        >
          Jugadores bancados
        </LinkButton>
        <LinkButton href={`${BANKING_BASE}/cortes`}>Cortes</LinkButton>
      </div>
    </>
  )
}
