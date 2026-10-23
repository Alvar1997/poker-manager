import Link from "next/link"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { PageHeader, Table, Td } from "@/modules/admin/components/admin-ui"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { listBankingMoney } from "@/modules/banking/banking-query.service"
import { BANKING_BASE } from "@/modules/banking/components/labels"

export const metadata = { title: "Reservas — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function ReservesPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/reservas`
  )
  const players = await listBankingMoney()
  return (
    <>
      <PageHeader
        title="Reservas"
        description="Saldo contable privado de cada jugador (no es dinero en caja). Se deriva de su libro de movimientos."
      />
      <Table
        head={[
          "Jugador",
          "Saldo",
          "Retirable",
          "Déficit de ciclos abiertos",
          "Movimientos",
          "Último",
        ]}
        testId="reserves-table"
      >
        {players.map((p) => (
          <tr key={p.player.id} data-testid="reserves-row">
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${p.player.id}`}
                className="underline"
              >
                {p.player.name}
              </Link>
            </Td>
            <Td>{formatMXN(p.reserve.balance)}</Td>
            <Td>{formatMXN(p.reserve.withdrawable)}</Td>
            <Td>{formatMXN(p.reserve.openCyclesDeficit)}</Td>
            <Td>{p.reserve.movements.length}</Td>
            <Td>
              {p.reserve.movements[0]
                ? formatDateTime(p.reserve.movements[0].createdAt)
                : "—"}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
