import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { CorrectionActions } from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { getCorrection } from "@/modules/corrections/correction.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Solicitud de corrección — Poker Manager" }

export default async function CorrectionPage({
  params,
}: PageProps<"/dashboard/administracion/correcciones/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.CORRECTIONS_REQUEST,
    `${ADMIN_BASE}/correcciones`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const c = await getCorrection(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  return (
    <>
      <BackLink href={`${ADMIN_BASE}/correcciones`} label="Correcciones" />
      <PageHeader title={`Solicitud ${c.folio}`} description={c.typeLabel} />
      <Card>
        <CardContent className="space-y-3">
          <p data-testid="correction-status">
            <StatusBadge value={c.status} label={c.statusLabel} />
          </p>
          {c.module16 ? (
            <p
              className="rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs"
              data-testid="correction-m16"
            >
              Proceso del Módulo 16: aprobar no ejecuta nada. Se ejecuta en
              Operaciones especiales, que exige los hechos reales (fichas
              recibidas, firma, pagos) y enlaza esta solicitud solo cuando los
              efectos quedan registrados.{" "}
              {c.specialOperationHref && c.status === "APPROVED" ? (
                <Link
                  href={c.specialOperationHref}
                  className="font-medium underline"
                  data-testid="correction-open-special"
                >
                  Ir a Operaciones especiales
                </Link>
              ) : null}
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
            <KeyValue label="Operación original">
              {c.target?.label ?? `${c.targetType} ${c.targetId}`}
            </KeyValue>
            <KeyValue label="Módulo afectado">{c.module}</KeyValue>
            <KeyValue label="Importe involucrado">
              {c.amount ? formatMXN(c.amount) : "—"}
            </KeyValue>
            <KeyValue label="Solicitó">
              {c.requestedBy.name} · {formatDateTime(c.requestedAt)}
            </KeyValue>
            <KeyValue label="Decisión">
              {c.decision
                ? `${c.decision.decision} por ${c.decision.decidedBy.name} (${c.decision.decidedRole}) · ${formatDateTime(c.decision.decidedAt)}`
                : "Pendiente"}
            </KeyValue>
            <KeyValue label="Ejecución">
              {c.executionReference
                ? `${c.executionReference.type} ${c.executionReference.id} · ejecutó ${c.executionReference.executedBy?.name ?? "—"}`
                : c.executionService
                  ? `Pendiente · ${c.executionService}`
                  : "Sin servicio de ejecución"}
            </KeyValue>
          </dl>
          <div className="text-sm">
            <p className="text-muted-foreground text-xs">Motivo</p>
            <p>{c.reason}</p>
          </div>
          {c.evidenceNote ? (
            <p className="text-sm">Evidencia: {c.evidenceNote}</p>
          ) : null}
          {c.target?.moduleBlocker ? (
            <p
              className="text-destructive text-xs"
              data-testid="correction-blocker"
            >
              Restricción del módulo de origen: {c.target.moduleBlocker}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Acciones</CardTitle>
        </CardHeader>
        <CardContent>
          <CorrectionActions
            id={c.id}
            version={c.version}
            status={c.status}
            canAuthorize={can(user, PERMISSIONS.CORRECTIONS_OPERATE)}
            executable={c.executable}
            isRequester={c.requestedBy.id === user.id}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historial (inmutable)</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm" data-testid="correction-history">
            {c.events.map((e) => (
              <li key={e.id} className="border-b pb-2 last:border-0">
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(e.createdAt)} · {e.actor.name}
                </span>
                <span className="block">
                  {e.kind}
                  {e.toStatus ? ` → ${e.toStatus}` : ""}
                  {e.notes ? ` · ${e.notes}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  )
}
