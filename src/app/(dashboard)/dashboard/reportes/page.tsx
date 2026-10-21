import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { DashboardLive } from "@/modules/reports/components/dashboard-live"
import {
  ExportButton,
  Note,
  REPORTS_BASE,
  ReportHeader,
} from "@/modules/reports/components/report-ui"
import { getDashboard } from "@/modules/reports/dashboard-report.service"

export const metadata = { title: "Reportes — Poker Manager" }

export default async function ReportsDashboardPage() {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, REPORTS_BASE)
  const initial = await getDashboard()
  return (
    <>
      <ReportHeader
        title="Dashboard de reportes"
        description="Indicadores de la sesión vigente y del negocio. Cada cifra indica su periodo; no se suman periodos distintos."
        actions={<ExportButton report="dashboard" filters={{}} />}
      />
      <DashboardLive initial={initial} />
      <Note>
        Las compras a crédito no son ingreso de efectivo, las fichas en
        circulación no son utilidad y los depósitos de terminal no se suman otra
        vez (el cobro se reconoce al aprobarse). No se declara utilidad neta.
        Los datos se actualizan al volver a esta pantalla, al recuperar el foco,
        tras registrar movimientos y con «Actualizar»; no hay sincronización
        instantánea entre dispositivos.
      </Note>
    </>
  )
}
