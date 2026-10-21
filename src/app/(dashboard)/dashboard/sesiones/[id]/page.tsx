import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { CancelSessionButton } from "@/modules/sessions/components/session-actions"
import {
  SESSIONS_BASE,
  SessionStatusBadge,
} from "@/modules/sessions/components/session-ui"
import { getStatusHistory } from "@/modules/sessions/session.service"
import { SESSION_STATUS_LABEL } from "@/modules/sessions/session.state"

import { BackLink } from "../back-link"
import { loadSession } from "../load-session"

export const metadata = { title: "Sesión — Poker Manager" }

export default async function SessionPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}`
  )
  const session = await loadSession(id, user)
  const history = await getStatusHistory(id)
  const canManage = can(user, PERMISSIONS.SESSIONS_MANAGE)
  const preparing =
    session.status === "DRAFT" || session.status === "PREPARATION"

  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd data-testid={testId}>{value ?? "—"}</dd>
    </div>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackLink href={SESSIONS_BASE} label="Sesiones" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1
          className="font-mono text-2xl font-semibold"
          data-testid="session-folio"
        >
          {session.folio}
        </h1>
        <SessionStatusBadge status={session.status} />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        {preparing ? (
          <Link
            href={`${SESSIONS_BASE}/${id}/preparacion`}
            className={cn(buttonVariants(), "h-11 md:h-9")}
            data-testid="go-preparation"
          >
            {session.canManagePreparation
              ? "Continuar preparación"
              : "Ver preparación"}
          </Link>
        ) : null}
        {session.status === "OPEN" ? (
          <Link
            href={`${SESSIONS_BASE}/${id}/mesas`}
            className={cn(buttonVariants(), "h-11 md:h-9")}
            data-testid="go-tables"
          >
            Mesas
          </Link>
        ) : null}
        {session.status === "OPEN" ||
        session.status === "CLOSING" ||
        session.status === "CLOSED" ? (
          <Link
            href={`${SESSIONS_BASE}/${id}/cierre`}
            className={cn(
              buttonVariants({
                variant: session.status === "CLOSING" ? "default" : "outline",
              }),
              "h-11 md:h-9"
            )}
            data-testid="go-closure"
          >
            {session.status === "CLOSED"
              ? "Cierre y comprobante"
              : session.status === "CLOSING"
                ? "Continuar cierre"
                : "Cierre de sesión"}
          </Link>
        ) : null}
        {preparing && canManage && session.canManagePreparation ? (
          <CancelSessionButton sessionId={id} />
        ) : null}
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {row("Creada por (responsable)", session.createdBy.name)}
            {row("Creada", formatDateTime(session.createdAt))}
            {row(
              "Preparación iniciada",
              session.preparationStartedAt
                ? formatDateTime(session.preparationStartedAt)
                : null
            )}
            {row(
              "Apertura real",
              session.openedAt ? formatDateTime(session.openedAt) : null,
              "session-opened-at"
            )}
            {row("Abrió", session.openedBy?.name)}
            {row(
              "Mesas abiertas",
              session.status === "OPEN" ? "Se gestionan en Mesas" : "0",
              "session-open-tables"
            )}
            {session.cancelledAt
              ? row(
                  "Cancelada",
                  `${formatDateTime(session.cancelledAt)} · ${session.cancelledBy?.name ?? ""}`
                )
              : null}
            {session.cancellationReason
              ? row("Motivo de cancelación", session.cancellationReason)
              : null}
            {session.closedAt
              ? row("Cierre", formatDateTime(session.closedAt))
              : null}
          </dl>
          {session.opening ? (
            <p
              className="text-muted-foreground border-t pt-3 text-xs"
              data-testid="opening-evidence"
            >
              Apertura confirmada por {session.opening.confirmedBy?.name} con
              caja inicial ${session.opening.openingCashAmount}
              {session.opening.superadminIntervention
                ? " (intervención de superadministrador)"
                : ""}
              .{" "}
              <Link
                className="underline"
                href={`/dashboard/inventario/fichas/arqueos/${session.opening.chipStockCountId}`}
              >
                Ver arqueo de fichas
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Historial de estados
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm" data-testid="status-history">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {h.fromStatus
                    ? `${SESSION_STATUS_LABEL[h.fromStatus]} → `
                    : ""}
                  {SESSION_STATUS_LABEL[h.toStatus]}
                  {h.reason ? ` · ${h.reason}` : ""}
                </span>
                <span className="text-muted-foreground text-xs">
                  {h.changedBy?.name ?? "Sistema"} ·{" "}
                  {formatDateTime(h.changedAt)}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
