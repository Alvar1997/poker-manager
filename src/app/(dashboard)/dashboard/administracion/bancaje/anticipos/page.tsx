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
import { listBankingMoney } from "@/modules/banking/banking-query.service"
import {
  ADVANCE_STATUS,
  BANKING_BASE,
  CHANNEL,
} from "@/modules/banking/components/labels"

export const metadata = { title: "Anticipos — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function AdvancesPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/anticipos`
  )
  const players = await listBankingMoney()
  const rows = players.flatMap((p) =>
    p.advances.map((a) => ({ ...a, player: p.player }))
  )
  return (
    <>
      <PageHeader
        title="Anticipos"
        description="Solo tras una jugada ganadora confirmada, dentro del límite garantizado. Autorización verbal o por mensaje registrada por el cajero; lo pagado son desembolsos reales."
      />
      <Table
        head={[
          "Jugador",
          "Ciclo",
          "Autorizado",
          "Pagado",
          "En trámite",
          "Autorizó",
          "Estado",
          "Registrado",
        ]}
        testId="advances-table"
      >
        {rows.map((a) => (
          <tr key={a.id} data-testid="advances-row">
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${a.player.id}`}
                className="underline"
              >
                {a.player.name}
              </Link>
            </Td>
            <Td>#{a.cycleNumber}</Td>
            <Td>{formatMXN(a.authorized)}</Td>
            <Td>{formatMXN(a.paid)}</Td>
            <Td>{formatMXN(a.inTransit)}</Td>
            <Td>
              {a.authorizerName} ({CHANNEL[a.channel]})
            </Td>
            <Td>
              <StatusBadge value={a.status} label={ADVANCE_STATUS[a.status]} />
            </Td>
            <Td>{formatDateTime(a.recordedAt)}</Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
