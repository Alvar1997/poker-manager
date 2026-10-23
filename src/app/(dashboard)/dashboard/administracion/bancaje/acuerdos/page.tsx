import Link from "next/link"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { listBankedPlayers } from "@/modules/banking/banking-query.service"
import { BANKING_BASE } from "@/modules/banking/components/labels"

export const metadata = { title: "Acuerdos de bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function AgreementsPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/acuerdos`
  )
  const rows = await listBankedPlayers()
  return (
    <>
      <PageHeader
        title="Acuerdos"
        description="Porcentajes vigentes por jugador. Cada cambio crea una versión nueva (el historial está en la ficha del jugador)."
      />
      <Table
        head={["Jugador", "Estado", "% jugador", "% casa"]}
        testId="agreements-table"
      >
        {rows.map((r) => (
          <tr key={r.agreementId}>
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${r.player.id}`}
                className="underline"
              >
                {r.player.name}
              </Link>
            </Td>
            <Td>
              <StatusBadge
                value={r.status}
                label={r.status === "ACTIVE" ? "Vigente" : "Terminado"}
              />
            </Td>
            <Td>{r.playerPercent}%</Td>
            <Td>{r.housePercent}%</Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
