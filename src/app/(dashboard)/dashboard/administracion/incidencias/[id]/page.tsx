import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { IncidentUpdateForm } from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import {
  assignableUsers,
  getIncident,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUS_LABEL,
} from "@/modules/incidents/incident.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Incidencia — Poker Manager" }

export default async function IncidentPage({
  params,
}: PageProps<"/dashboard/administracion/incidencias/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.AUDIT_READ,
    `${ADMIN_BASE}/incidencias`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const [i, users] = await Promise.all([
    getIncident(id).catch((e: unknown) => {
      if (e instanceof NotFoundError) notFound()
      throw e
    }),
    assignableUsers(),
  ])
  return (
    <>
      <BackLink href={`${ADMIN_BASE}/incidencias`} label="Incidencias" />
      <PageHeader
        title={`${i.folio} · ${i.title}`}
        description={i.description}
      />
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
            <KeyValue label="Estado" testId="incident-status-value">
              <StatusBadge
                value={i.status}
                label={INCIDENT_STATUS_LABEL[i.status]}
              />
            </KeyValue>
            <KeyValue label="Severidad">
              <StatusBadge
                value={i.severity}
                label={INCIDENT_SEVERITY_LABEL[i.severity]}
              />
            </KeyValue>
            <KeyValue label="Origen">{i.source}</KeyValue>
            <KeyValue label="Repeticiones">
              {i.occurrences} · última {formatDateTime(i.lastSeenAt)}
            </KeyValue>
            <KeyValue label="Responsable">{i.assignedTo?.name ?? "—"}</KeyValue>
            <KeyValue label="Entidad">
              {i.entityType ? `${i.entityType} ${i.entityId ?? ""}` : "—"}
            </KeyValue>
            {i.resolution ? (
              <KeyValue label="Resolución">
                {i.resolution} ({i.resolvedBy?.name})
              </KeyValue>
            ) : null}
          </dl>
          {i.finding ? (
            <p className="text-muted-foreground mt-3 text-xs">
              Hallazgo {i.finding.checkCode}:{" "}
              <Link
                href={`${ADMIN_BASE}/integridad/${i.finding.runId}`}
                className="underline"
              >
                ver diagnóstico
              </Link>
              {i.finding.expected ? ` · esperado ${i.finding.expected}` : ""}
              {i.finding.actual ? ` · real ${i.finding.actual}` : ""}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {can(user, PERMISSIONS.INCIDENTS_MANAGE) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Seguimiento</CardTitle>
          </CardHeader>
          <CardContent>
            <IncidentUpdateForm
              id={i.id}
              version={i.version}
              status={i.status}
              assignedToId={i.assignedTo?.id ?? null}
              users={users}
              canResolve={can(user, PERMISSIONS.INCIDENTS_RESOLVE)}
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historial (inmutable)</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm" data-testid="incident-history">
            {i.history.map((h) => (
              <li key={h.id} className="border-b pb-2 last:border-0">
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(h.createdAt)} · {h.actor?.name ?? "Sistema"}
                </span>
                <span className="block">
                  {h.kind}
                  {h.toStatus ? ` → ${h.toStatus}` : ""}
                  {h.notes ? ` · ${h.notes}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  )
}
