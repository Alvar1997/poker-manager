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
  BANKING_BASE,
  WITHDRAWAL_STATUS,
} from "@/modules/banking/components/labels"

export const metadata = { title: "Retiros de reserva — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function WithdrawalsPage() {
  await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/retiros`
  )
  const players = await listBankingMoney()
  const rows = players.flatMap((p) =>
    p.withdrawals.map((w) => ({ ...w, player: p.player }))
  )
  return (
    <>
      <PageHeader
        title="Retiros de reserva"
        description="Requieren aprobación DIGITAL de un PARTNER o SUPERADMIN; el pago es un desembolso real (parcial o total)."
      />
      <Table
        head={[
          "Jugador",
          "Solicitado",
          "Aprobado",
          "Pagado",
          "En trámite",
          "Estado",
          "Solicitó",
          "Decidió",
        ]}
        testId="withdrawals-table"
      >
        {rows.map((w) => (
          <tr key={w.id} data-testid="withdrawals-row">
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${w.player.id}`}
                className="underline"
              >
                {w.player.name}
              </Link>
            </Td>
            <Td>{formatMXN(w.requested)}</Td>
            <Td>{w.approved ? formatMXN(w.approved) : "—"}</Td>
            <Td>{formatMXN(w.paid)}</Td>
            <Td>{formatMXN(w.inTransit)}</Td>
            <Td>
              <StatusBadge
                value={w.status}
                label={WITHDRAWAL_STATUS[w.status]}
              />
            </Td>
            <Td>
              {w.requestedBy.name} · {formatDateTime(w.requestedAt)}
            </Td>
            <Td>{w.decidedBy ? w.decidedBy.name : "—"}</Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
