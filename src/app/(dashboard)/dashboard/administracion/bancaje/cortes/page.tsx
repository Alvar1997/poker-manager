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
import { listBankingClosings } from "@/modules/banking/banking-query.service"
import {
  BANKING_BASE,
  CLOSING_STATUS,
} from "@/modules/banking/components/labels"

export const metadata = { title: "Cortes de bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function ClosingsPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/cortes`
  )
  const rows = await listBankingClosings()
  return (
    <>
      <PageHeader
        title="Cortes"
        description="Versiones preparadas, aprobadas digitalmente, rechazadas o sustituidas (snapshot inmutable)."
      />
      <Table
        head={[
          "Jugador",
          "Ciclo",
          "Versión",
          "Estado",
          "Jugador recibe",
          "Reserva",
          "Pago",
          "Arrastre",
          "Preparó",
          "Decidió",
        ]}
        testId="closings-table"
      >
        {rows.map((c) => (
          <tr key={c.id} data-testid="closings-row">
            <Td>{c.cycle.player.name}</Td>
            <Td>
              <Link
                href={`${BANKING_BASE}/ciclos/${c.cycle.id}`}
                className="underline"
              >
                #{c.cycle.number}
              </Link>
            </Td>
            <Td>v{c.version}</Td>
            <Td>
              <StatusBadge value={c.status} label={CLOSING_STATUS[c.status]} />
            </Td>
            <Td>{formatMXN(c.playerShare)}</Td>
            <Td>{formatMXN(c.reserveAmount)}</Td>
            <Td>{formatMXN(c.payAmount)}</Td>
            <Td>{formatMXN(c.carriedLossOut)}</Td>
            <Td>
              {c.preparedBy.name} · {formatDateTime(c.preparedAt)}
            </Td>
            <Td>
              {c.decidedBy
                ? `${c.decidedBy.name} · ${formatDateTime(c.decidedAt!)}`
                : "—"}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
