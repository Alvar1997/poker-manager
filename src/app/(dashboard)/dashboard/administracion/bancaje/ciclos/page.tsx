import Link from "next/link"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { formatDateTime } from "@/lib/format"
import { listBankingCycles } from "@/modules/banking/banking-query.service"
import { BANKING_BASE, CYCLE_STATUS } from "@/modules/banking/components/labels"

export const metadata = { title: "Ciclos de bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function CyclesPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/ciclos`
  )
  const rows = await listBankingCycles()
  return (
    <>
      <PageHeader
        title="Ciclos"
        description="Cada ciclo comprende exactamente cuatro jugadas (sesiones distintas), no días ni compras."
      />
      <Table
        head={["Jugador", "Ciclo", "Jugadas", "Estado", "Inicio", "Cierre"]}
        testId="cycles-table"
      >
        {rows.map((c) => (
          <tr key={c.id} data-testid="cycles-row">
            <Td>{c.player.name}</Td>
            <Td>
              <Link
                href={`${BANKING_BASE}/ciclos/${c.id}`}
                className="underline"
              >
                #{c.number}
              </Link>
            </Td>
            <Td>{c.confirmed}/4</Td>
            <Td>
              <StatusBadge value={c.status} label={CYCLE_STATUS[c.status]} />
            </Td>
            <Td>{formatDateTime(c.startedAt)}</Td>
            <Td>{c.closedAt ? formatDateTime(c.closedAt) : "—"}</Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
