import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  ReturnToOpenForm,
  StartClosingButton,
} from "@/modules/closure/components/closure-actions"
import {
  ChipFigures,
  closureBase,
  FindingList,
  MoneyRow,
  ReadinessList,
} from "@/modules/closure/components/closure-ui"
import { getClosureOverview } from "@/modules/closure/closure.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../load-session"
import { ClosureHeader } from "./closure-header"

export const metadata = { title: "Cierre de sesión — Poker Manager" }

export default async function ClosurePanelPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre`
  )
  const session = await loadSession(id, user)
  const o = await getClosureOverview(id)
  const canManage = can(user, PERMISSIONS.SESSIONS_MANAGE)
  const canAuthorize = can(user, PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
  const closing = session.status === "CLOSING"
  const blocking = o.precheck.findings.filter((f) => f.severity === "BLOCKING")
  const warnings = o.precheck.findings.filter((f) => f.severity === "WARNING")
  const openDiscrepancies = o.discrepancies.filter((d) => d.status === "OPEN")

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Cierre"
        description="Una caja central y un inventario compartido: cada mesa cierra su ciclo por separado y al final se hace UN arqueo global de fichas y el arqueo de efectivo. La caja termina en $0.00."
      />

      {session.status === "CLOSED" && o.report ? (
        <Card>
          <CardContent className="space-y-2 text-sm">
            <p data-testid="closure-closed">
              Sesión cerrada el {formatDateTime(session.closedAt!)}. Folio de
              cierre <span className="font-mono">{o.report.folio}</span>.
            </p>
            <Link
              href={`${closureBase(id)}/comprobante`}
              className={cn(buttonVariants(), "h-11 md:h-9")}
            >
              Ver comprobante de cierre
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {session.status === "OPEN" ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Iniciar el cierre
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Al iniciar, la sesión pasa a «En cierre»: se bloquean compras,
              recompras, nuevas participaciones, transferencias entre mesas,
              nuevas liquidaciones y la apertura de mesas.
            </p>
            {blocking.length > 0 ? (
              <p className="text-destructive" data-testid="closure-blocked">
                Hay {blocking.length} bloqueo(s): resuélvelos antes de iniciar.
              </p>
            ) : null}
            {canManage ? (
              <StartClosingButton
                sessionId={id}
                disabled={blocking.length > 0}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {blocking.length > 0 || warnings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Prevalidación
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FindingList findings={[...blocking, ...warnings]} />
          </CardContent>
        </Card>
      ) : null}

      {closing ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Requisitos del cierre definitivo
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ReadinessList checks={o.readiness.checks} />
            <Link
              href={`${closureBase(id)}/resumen`}
              className={cn(buttonVariants(), "h-11 md:h-9")}
              data-testid="go-closure-summary"
            >
              {canAuthorize ? "Revisar y confirmar" : "Ver resumen"}
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Fichas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChipFigures {...o.inventory.position} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Situación
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <div className="flex justify-between py-1 text-sm">
              <dt className="text-muted-foreground">Mesas / ciclos cerrados</dt>
              <dd data-testid="closure-cycles">
                {o.financial.tables.operated} ·{" "}
                {o.financial.tables.cyclesClosed} cerrados,{" "}
                {o.financial.tables.cyclesOpen} abiertos
              </dd>
            </div>
            <div className="flex justify-between py-1 text-sm">
              <dt className="text-muted-foreground">
                Diferencias sin resolver
              </dt>
              <dd data-testid="closure-open-discrepancies">
                {openDiscrepancies.length}
              </dd>
            </div>
            <MoneyRow
              label="Efectivo esperado en caja"
              value={o.cash.expected}
              testId="closure-cash-expected"
            />
            <MoneyRow
              label="Deudas pendientes (sobreviven)"
              value={o.financial.credits.outstanding}
            />
            <MoneyRow
              label="Pagos pendientes a jugadores (sobreviven)"
              value={o.financial.settlements.pendingAmount}
            />
            <div className="flex justify-between py-1 text-sm">
              <dt className="text-muted-foreground">Responsable del cierre</dt>
              <dd>{o.closure?.startedBy.name ?? "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {closing && canManage ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              ¿Falta registrar algo?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnToOpenForm sessionId={id} />
          </CardContent>
        </Card>
      ) : null}

      {o.attempts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Intentos de cierre
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm" data-testid="closure-attempts">
              {o.attempts.map((a) => (
                <li key={a.id} className="flex flex-col gap-0.5">
                  <span>
                    #{a.attemptNumber} ·{" "}
                    {a.status === "IN_PROGRESS"
                      ? "En curso"
                      : a.status === "COMPLETED"
                        ? "Completado"
                        : "Regresó a Abierta"}{" "}
                    · {a.startedBy.name} · {formatDateTime(a.startedAt)}
                  </span>
                  {a.returnReason ? (
                    <span className="text-muted-foreground text-xs">
                      Motivo: {a.returnReason}
                      {a.forgottenOperationAt
                        ? ` (operación informada a las ${formatDateTime(a.forgottenOperationAt)})`
                        : ""}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
