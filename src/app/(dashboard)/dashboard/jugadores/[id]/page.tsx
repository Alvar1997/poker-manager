import { ArrowLeft, Pencil, Phone } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { maskPhone, formatPhone } from "@/lib/phone"
import { cn } from "@/lib/utils"
import { PlayerHistoryPlaceholder } from "@/modules/players/components/player-history-placeholder"
import { WhatsAppConsentCard } from "@/modules/players/components/whatsapp-consent-card"
import { playerIdSchema } from "@/modules/players/player.schemas"
import {
  getPhoneHistory,
  getPlayer,
  getPlayerAudit,
} from "@/modules/players/player.service"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { StatusToggleButton } from "@/modules/settings/components/status-toggle-button"

export const metadata = { title: "Jugador — Poker Manager" }

const AUDIT_LABEL: Record<string, string> = {
  PLAYER_CREATED: "Registro",
  PLAYER_UPDATED: "Edición de datos",
  PLAYER_STATUS_CHANGED: "Cambio de estado",
  PLAYER_PHONE_CHANGED: "Cambio de teléfono",
  PLAYER_WHATSAPP_CONSENT_GRANTED: "Aceptó WhatsApp",
  PLAYER_WHATSAPP_CONSENT_REVOKED: "Revocó WhatsApp",
}

export default async function PlayerProfilePage({
  params,
}: PageProps<"/dashboard/jugadores/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.PLAYERS_READ,
    "/dashboard/jugadores/[id]"
  )
  const { id } = await params
  if (!playerIdSchema.safeParse(id).success) notFound()
  const player = await getPlayer(id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound()
    throw error
  })

  const canAudit = can(user, PERMISSIONS.AUDIT_READ)
  // Módulo 15: el historial de TELÉFONOS (dato personal) tiene su propio
  // permiso; la auditoría general la consultan los tres roles (DEC-03).
  const canHistory = can(user, PERMISSIONS.PLAYERS_HISTORY_READ)
  const [phoneHistory, audit] = await Promise.all([
    canHistory ? getPhoneHistory(id) : Promise.resolve([]),
    canAudit ? getPlayerAudit(id) : Promise.resolve([]),
  ])

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href="/dashboard/jugadores"
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Jugadores
      </Link>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold break-words">
                {player.name}
              </h1>
              {player.nickname ? (
                <p
                  className="text-muted-foreground"
                  data-testid="player-nickname"
                >
                  “{player.nickname}”
                </p>
              ) : null}
            </div>
            <ActiveBadge isActive={player.isActive} />
          </div>
          <a
            href={`tel:${player.phone}`}
            className="inline-flex min-h-11 items-center gap-2 text-base tabular-nums md:min-h-0"
            data-testid="player-phone"
          >
            <Phone className="size-4" aria-hidden="true" />
            {player.phoneDisplay}
          </a>
          {!player.isActive ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Jugador inactivo: conserva su información, historial y deudas,
              pero no podrá seleccionarse para nuevas compras ni sesiones.
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {can(user, PERMISSIONS.PLAYERS_UPDATE) ? (
              <Link
                href={`/dashboard/jugadores/${player.id}/editar`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "h-11 md:h-8"
                )}
              >
                <Pencil />
                Editar
              </Link>
            ) : null}
            {can(user, PERMISSIONS.PURCHASES_READ) ? (
              <Link
                href={`/dashboard/jugadores/${player.id}/compras`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "h-11 md:h-8"
                )}
                data-testid="player-purchases"
              >
                Compras
              </Link>
            ) : null}
            {can(user, PERMISSIONS.CREDITS_READ) ? (
              <Link
                href={`/dashboard/creditos/jugadores/${player.id}`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "h-11 md:h-8"
                )}
                data-testid="player-credits"
              >
                Créditos y deudas
              </Link>
            ) : null}
            {can(user, PERMISSIONS.PLAYERS_MANAGE) ? (
              <StatusToggleButton
                url={`/api/players/${player.id}/status`}
                isActive={player.isActive}
                entityLabel={player.name}
                deactivateWarning="Seguirá en el directorio con todo su historial y sus deudas vigentes, pero no podrá seleccionarse para nuevas compras ni sesiones. Puedes reactivarlo después."
              />
            ) : null}
          </div>
          <ReadOnlyList
            items={[
              {
                label: "Registrado",
                value: formatDateTime(player.createdAt),
                hint: player.createdBy
                  ? `por ${player.createdBy.name}`
                  : undefined,
              },
              {
                label: "Última actualización",
                value: formatDateTime(player.updatedAt),
                hint: player.updatedBy
                  ? `por ${player.updatedBy.name}`
                  : undefined,
              },
              { label: "País del teléfono", value: player.countryCode },
            ]}
          />
          <div>
            <p className="text-muted-foreground text-sm">
              Observaciones internas
            </p>
            <p
              className="text-sm break-words whitespace-pre-wrap"
              data-testid="player-notes"
            >
              {player.notes ?? "Sin observaciones"}
            </p>
          </div>
        </CardContent>
      </Card>

      <WhatsAppConsentCard
        playerId={player.id}
        playerName={player.name}
        status={player.whatsappConsent}
        canRecord={can(user, PERMISSIONS.PLAYERS_CONSENT)}
      />

      <Card>
        <CardContent className="text-muted-foreground text-sm">
          <Badge variant="outline" className="mb-2">
            Crédito sin límite
          </Badge>
          <p>
            Este jugador puede comprar fichas a crédito sin límite y sin
            autorización adicional. Cada compra a crédito requerirá su firma y
            la deuda se calculará a partir de operaciones confirmadas (aún no
            hay módulo de compras).
          </p>
        </CardContent>
      </Card>

      <PlayerHistoryPlaceholder />

      {canHistory ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Historial de teléfonos
            </CardTitle>
          </CardHeader>
          <CardContent>
            {phoneHistory.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Sin cambios de teléfono.
              </p>
            ) : (
              <ul className="divide-y text-sm" data-testid="phone-history">
                {phoneHistory.map((h) => (
                  <li key={h.id} className="py-2">
                    <p className="tabular-nums">
                      {formatPhone(h.previousPhone)} → {formatPhone(h.newPhone)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatDateTime(h.changedAt)}
                      {h.changedBy ? ` · ${h.changedBy.name}` : ""}
                      {h.reason ? ` · ${h.reason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
      {canAudit ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Auditoría
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm" data-testid="player-audit">
              {audit.map((e) => (
                <li key={e.id} className="py-2">
                  <p className="font-medium">
                    {AUDIT_LABEL[e.action] ?? e.action}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {formatDateTime(e.createdAt)}
                    {e.actor ? ` · ${e.actor.name}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground pt-2 text-xs">
              Los teléfonos se registran enmascarados (p. ej.{" "}
              {maskPhone(player.phone)}).
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
