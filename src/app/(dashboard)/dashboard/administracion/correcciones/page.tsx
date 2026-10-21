import Link from "next/link"

import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { parseQueryParams } from "@/lib/validation"
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
import { formatMXN } from "@/modules/cash/components/format"
import {
  CORRECTION_STATUS_LABEL,
  CORRECTION_TYPE_META,
} from "@/modules/corrections/correction.rules"
import { correctionsQuerySchema } from "@/modules/corrections/correction.schemas"
import { listCorrections } from "@/modules/corrections/correction.service"

export const metadata = { title: "Correcciones excepcionales — Poker Manager" }

const BASE = `${ADMIN_BASE}/correcciones`

export default async function CorrectionsPage({
  searchParams,
}: PageProps<"/dashboard/administracion/correcciones">) {
  await requirePagePermission(PERMISSIONS.CORRECTIONS_REQUEST, BASE)
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
      correctionsQuerySchema
    )
  } catch {
    q = { page: 1, pageSize: 25 }
  }
  const r = await listCorrections(q)
  return (
    <>
      <PageHeader
        title="Correcciones excepcionales"
        description="Aprobar NO modifica saldos: solo se marca «ejecutada» al enlazar la operación real de su módulo."
        actions={
          <LinkButton
            href={`${BASE}/nueva`}
            variant="default"
            testId="new-correction"
          >
            Solicitar corrección
          </LinkButton>
        }
      />
      <UrlFilters
        base={BASE}
        values={raw}
        fields={[
          {
            name: "status",
            label: "Estado",
            type: "select",
            options: Object.entries(CORRECTION_STATUS_LABEL).map(
              ([id, label]) => ({ id, label })
            ),
          },
          {
            name: "type",
            label: "Tipo",
            type: "select",
            options: Object.entries(CORRECTION_TYPE_META).map(([id, m]) => ({
              id,
              label: m.label,
            })),
          },
        ]}
      />
      <Card>
        <CardContent className="space-y-3">
          <Table
            head={[
              "Folio",
              "Tipo",
              "Módulo",
              "Importe",
              "Estado",
              "Solicitó",
              "Fecha",
              "Decisión",
            ]}
            testId="corrections-table"
          >
            {r.items.map((c) => (
              <tr key={c.id} data-testid={`correction-row-${c.folio}`}>
                <Td>
                  <Link
                    href={`${BASE}/${c.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {c.folio}
                  </Link>
                </Td>
                <Td>
                  {c.typeLabel}
                  {c.module16 ? (
                    <span className="text-muted-foreground block text-xs">
                      Módulo 16 · se ejecuta en Operaciones especiales
                    </span>
                  ) : null}
                </Td>
                <Td>{c.module}</Td>
                <Td className="tabular-nums">
                  {c.amount ? formatMXN(c.amount) : "—"}
                </Td>
                <Td>
                  <StatusBadge value={c.status} label={c.statusLabel} />
                </Td>
                <Td>{c.requestedBy.name}</Td>
                <Td>{formatDateTime(c.requestedAt)}</Td>
                <Td>
                  {c.decision
                    ? `${c.decision.decidedBy.name} (${c.decision.decidedRole})`
                    : "—"}
                </Td>
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
