import Link from "next/link"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { parseQueryParams } from "@/lib/validation"
import { incidentsQuerySchema } from "@/modules/admin/admin.schemas"
import { UrlFilters } from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  LinkButton,
  PageHeader,
  Pager,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import {
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUS_LABEL,
  listIncidents,
} from "@/modules/incidents/incident.service"

export const metadata = { title: "Incidencias — Poker Manager" }

const BASE = `${ADMIN_BASE}/incidencias`

export default async function IncidentsPage({
  searchParams,
}: PageProps<"/dashboard/administracion/incidencias">) {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_READ, BASE)
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [
      k,
      Array.isArray(v) ? v[0] : v,
    ])
  ) as Record<string, string | undefined>
  let q
  try {
    q = parseQueryParams(
      new URLSearchParams(raw as Record<string, string>),
      incidentsQuerySchema
    )
  } catch {
    q = { page: 1, pageSize: 25 }
  }
  const r = await listIncidents(q)
  return (
    <>
      <PageHeader
        title="Centro de incidencias"
        description="Las incidencias nunca se borran y conservan su historial. Un hallazgo repetido no abre otra incidencia."
        actions={
          can(user, PERMISSIONS.INCIDENTS_MANAGE) ? (
            <LinkButton
              href={`${BASE}/nueva`}
              variant="default"
              testId="new-incident"
            >
              Registrar incidencia
            </LinkButton>
          ) : null
        }
      />
      <p className="text-sm" data-testid="incidents-open-summary">
        Abiertas: crítica {r.openBySeverity.CRITICAL ?? 0} · alta{" "}
        {r.openBySeverity.HIGH ?? 0} · media {r.openBySeverity.MEDIUM ?? 0} ·
        baja {r.openBySeverity.LOW ?? 0}
      </p>
      <UrlFilters
        base={BASE}
        values={raw}
        fields={[
          {
            name: "status",
            label: "Estado",
            type: "select",
            options: Object.entries(INCIDENT_STATUS_LABEL).map(
              ([id, label]) => ({ id, label })
            ),
          },
          {
            name: "severity",
            label: "Severidad",
            type: "select",
            options: Object.entries(INCIDENT_SEVERITY_LABEL).map(
              ([id, label]) => ({ id, label })
            ),
          },
          {
            name: "source",
            label: "Origen",
            type: "select",
            options: [
              "MANUAL",
              "INTEGRITY",
              "BACKUP",
              "RESTORE",
              "SECURITY",
            ].map((s) => ({ id: s, label: s })),
          },
        ]}
      />
      <Card>
        <CardContent className="space-y-3">
          <Table
            head={[
              "Folio",
              "Título",
              "Severidad",
              "Estado",
              "Origen",
              "Repeticiones",
              "Responsable",
              "Creada",
            ]}
            testId="incidents-table"
          >
            {r.items.map((i) => (
              <tr key={i.id} data-testid={`incident-row-${i.folio}`}>
                <Td>
                  <Link
                    href={`${BASE}/${i.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                    data-testid="incident-link"
                  >
                    {i.folio}
                  </Link>
                </Td>
                <Td>{i.title}</Td>
                <Td>
                  <StatusBadge
                    value={i.severity}
                    label={INCIDENT_SEVERITY_LABEL[i.severity]}
                  />
                </Td>
                <Td>
                  <StatusBadge
                    value={i.status}
                    label={INCIDENT_STATUS_LABEL[i.status]}
                  />
                </Td>
                <Td>{i.source}</Td>
                <Td>{i.occurrences}</Td>
                <Td>{i.assignedTo?.name ?? "—"}</Td>
                <Td>{formatDateTime(i.createdAt)}</Td>
              </tr>
            ))}
          </Table>
          <Pager
            base={BASE}
            query={raw}
            page={r.page}
            pageSize={r.pageSize}
            total={r.total}
          />
        </CardContent>
      </Card>
    </>
  )
}
