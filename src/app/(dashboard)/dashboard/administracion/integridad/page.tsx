import Link from "next/link"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { RunIntegrityButton } from "@/modules/admin/components/admin-actions"
import {
  ADMIN_BASE,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { listIntegrityRuns } from "@/modules/integrity/integrity.service"

export const metadata = { title: "Integridad — Poker Manager" }

type Summary = {
  overall?: string
  checks?: number
  error?: number
  warning?: number
  notEvaluated?: number
  incidentsOpened?: number
}

export default async function IntegrityPage() {
  const user = await requirePagePermission(
    PERMISSIONS.AUDIT_READ,
    `${ADMIN_BASE}/integridad`
  )
  const runs = await listIntegrityRuns()
  return (
    <>
      <PageHeader
        title="Integridad financiera y de inventario"
        description="Diagnóstico de SOLO LECTURA: no repara datos, no crea movimientos y no marca como OK lo que no pudo evaluar."
        actions={
          can(user, PERMISSIONS.INTEGRITY_RUN) ? <RunIntegrityButton /> : null
        }
      />
      <Card>
        <CardContent>
          <Table
            head={[
              "Inicio",
              "Resultado",
              "Comprobaciones",
              "Errores",
              "Advertencias",
              "Sin evaluar",
              "Incidencias nuevas",
              "Origen",
            ]}
            testId="integrity-runs"
          >
            {runs.map((r) => {
              const s = (r.summary ?? {}) as Summary
              return (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`${ADMIN_BASE}/integridad/${r.id}`}
                      className="underline-offset-4 hover:underline"
                      data-testid="integrity-run-link"
                    >
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge value={s.overall ?? r.status} />
                  </Td>
                  <Td>{s.checks ?? "—"}</Td>
                  <Td>{s.error ?? "—"}</Td>
                  <Td>{s.warning ?? "—"}</Td>
                  <Td>{s.notEvaluated ?? "—"}</Td>
                  <Td>{s.incidentsOpened ?? 0}</Td>
                  <Td>
                    {r.trigger} · {r.triggeredBy?.name ?? "sistema"}
                  </Td>
                </tr>
              )
            })}
          </Table>
          {runs.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">
              Aún no se ha ejecutado ningún diagnóstico.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
