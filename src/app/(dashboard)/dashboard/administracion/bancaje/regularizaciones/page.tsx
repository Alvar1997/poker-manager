import Link from "next/link"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { listBankingRegularizations } from "@/modules/banking/banking-query.service"
import {
  BANKING_BASE,
  REG_KIND,
  REG_STATUS,
} from "@/modules/banking/components/labels"

export const metadata = { title: "Regularizaciones de bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function RegularizationsPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/regularizaciones`
  )
  const rows = await listBankingRegularizations()
  return (
    <>
      <PageHeader
        title="Regularizaciones"
        description="Expedientes caso por caso (anticipos excedidos y discrepancias físicas). Visibles hasta resolverse; nunca crean deuda ordinaria."
      />
      <Table
        head={[
          "Jugador",
          "Tipo",
          "Importe",
          "Estado",
          "Tratamiento",
          "Recuperado",
          "Recibido",
          "Abierta",
        ]}
        testId="regularizations-table"
      >
        {rows.map((r) => (
          <tr key={r.id} data-testid="regularizations-row">
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${r.player.id}`}
                className="underline"
              >
                {r.player.name}
              </Link>
            </Td>
            <Td>{REG_KIND[r.kind]}</Td>
            <Td>{formatMXN(r.amount)}</Td>
            <Td>
              <StatusBadge value={r.status} label={REG_STATUS[r.status]} />
            </Td>
            <Td>{r.resolution ?? "Pendiente de decisión"}</Td>
            <Td>{formatMXN(r.recovered)}</Td>
            <Td>{formatMXN(r.received)}</Td>
            <Td>{formatDateTime(r.openedAt)}</Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
