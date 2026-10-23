import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import {
  bankablePlayers,
  listBankedPlayers,
} from "@/modules/banking/banking-query.service"
import { ActionForm } from "@/modules/banking/components/banking-actions"
import {
  BANKING_API,
  BANKING_BASE,
  CYCLE_STATUS,
} from "@/modules/banking/components/labels"
import { formatMXN } from "@/modules/cash/components/format"

export const metadata = { title: "Jugadores bancados — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function BankedPlayersPage() {
  const user = await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/jugadores`
  )
  const canApprove = can(user, PERMISSIONS.BANKING_APPROVE)
  const [rows, candidates] = await Promise.all([
    listBankedPlayers(),
    canApprove ? bankablePlayers("") : Promise.resolve([]),
  ])
  return (
    <>
      <PageHeader
        title="Jugadores bancados"
        description="Acuerdos privados por jugador. El porcentaje rige el reparto de la ganancia neta de cada ciclo de cuatro jugadas."
      />
      <Table
        head={[
          "Jugador",
          "Acuerdo",
          "% jugador / casa",
          "Ciclo",
          "Reserva",
          "Pérdida por recuperar",
        ]}
        testId="banked-players"
      >
        {rows.map((r) => (
          <tr key={r.agreementId} data-testid="banked-row">
            <Td>
              <Link
                href={`${BANKING_BASE}/jugadores/${r.player.id}`}
                className="underline"
                data-testid="banked-link"
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
            <Td>
              {r.playerPercent}% / {r.housePercent}%
            </Td>
            <Td>
              {r.cycle
                ? `#${r.cycle.number} · ${r.cycle.confirmed}/4 · ${CYCLE_STATUS[r.cycle.status] ?? r.cycle.status}`
                : "—"}
            </Td>
            <Td>{formatMXN(r.reserve)}</Td>
            <Td>{formatMXN(r.pendingLoss)}</Td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Todavía no hay acuerdos.
        </p>
      ) : null}
      {canApprove ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Nuevo acuerdo (aprobación digital)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm
              url={`${BANKING_API}/agreements`}
              testId="agreement-form"
              submitLabel="Registrar acuerdo"
              success="Acuerdo registrado y aprobado digitalmente"
              fields={[
                {
                  name: "playerId",
                  label: "Jugador existente",
                  type: "select",
                  required: true,
                  options: candidates.map((p) => ({
                    value: p.id,
                    label: p.nickname ? `${p.name} (${p.nickname})` : p.name,
                  })),
                },
                {
                  name: "playerPercent",
                  label: "Porcentaje del jugador",
                  type: "percent",
                  required: true,
                  hint: "La casa recibe el resto (100 − jugador).",
                },
                {
                  name: "reason",
                  label: "Motivo / condiciones",
                  type: "textarea",
                  required: true,
                },
              ]}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-xs">
          Solo un PARTNER o SUPERADMIN registra acuerdos.
        </p>
      )}
    </>
  )
}
