import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  ADMIN_BASE,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { CATEGORY_LABEL } from "@/modules/integrity/integrity.math"
import { getIntegrityRun } from "@/modules/integrity/integrity.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Diagnóstico de integridad — Poker Manager" }

export default async function IntegrityRunPage({
  params,
}: PageProps<"/dashboard/administracion/integridad/[id]">) {
  await requirePagePermission(
    PERMISSIONS.AUDIT_READ,
    `${ADMIN_BASE}/integridad`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const run = await getIntegrityRun(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const categories = [...new Set(run.findings.map((f) => f.category))]
  return (
    <>
      <BackLink href={`${ADMIN_BASE}/integridad`} label="Integridad" />
      <PageHeader
        title="Diagnóstico de integridad"
        description={`${formatDateTime(run.startedAt)} · ${run.summary?.checks ?? 0} comprobaciones · ${run.summary?.error ?? 0} errores · ${run.summary?.warning ?? 0} advertencias · ${run.summary?.notEvaluated ?? 0} sin evaluar`}
        actions={
          <StatusBadge
            value={run.summary?.overall ?? run.status}
            testId="integrity-overall"
          />
        }
      />
      {run.error ? (
        <p className="text-destructive text-sm">{run.error}</p>
      ) : null}
      {categories.map((cat) => (
        <Card key={cat} data-testid={`integrity-category-${cat}`}>
          <CardHeader>
            <CardTitle className="text-base">
              {CATEGORY_LABEL[cat] ?? cat}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {run.findings
                .filter((f) => f.category === cat)
                .map((f) => (
                  <li
                    key={f.id}
                    className="rounded-md border p-2"
                    data-testid={`finding-${f.checkCode}`}
                    data-status={f.status}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs">{f.checkCode}</span>
                      <span className="flex gap-1">
                        <StatusBadge value={f.status} />
                        {f.status !== "OK" ? (
                          <StatusBadge value={f.severity} />
                        ) : null}
                      </span>
                    </div>
                    <p className="mt-1">{f.explanation}</p>
                    {f.expected || f.actual ? (
                      <p className="text-muted-foreground text-xs">
                        {f.expected ? `Esperado: ${f.expected} · ` : ""}
                        {f.actual ? `Real: ${f.actual}` : ""}
                        {f.difference ? ` · Diferencia: ${f.difference}` : ""}
                      </p>
                    ) : null}
                    {f.entityId ? (
                      <p className="text-muted-foreground text-xs">
                        {f.entityType} {f.entityId}
                      </p>
                    ) : null}
                    {f.incidents.length ? (
                      <p className="text-xs">
                        Incidencia:{" "}
                        {f.incidents.map((i) => (
                          <Link
                            key={i.id}
                            href={`${ADMIN_BASE}/incidencias/${i.id}`}
                            className="underline"
                          >
                            {i.folio}
                          </Link>
                        ))}
                      </p>
                    ) : null}
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ))}
      <p className="text-muted-foreground text-xs">
        Las deudas y obligaciones pendientes, las transferencias por verificar y
        las fichas en circulación son estados legítimos (información), no
        errores.
      </p>
    </>
  )
}
