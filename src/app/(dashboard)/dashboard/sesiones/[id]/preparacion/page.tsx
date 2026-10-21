import { Lock } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { cn } from "@/lib/utils"
import { formatNominal } from "@/modules/inventory/components/format"
import { getCustodySummary } from "@/modules/credits/custody.service"
import { getOpeningChecklist } from "@/modules/sessions/opening.service"
import { OpeningChecklistView } from "@/modules/sessions/components/opening-checklist"
import {
  OpeningCashForm,
  SessionActionButton,
} from "@/modules/sessions/components/session-actions"
import {
  SESSIONS_BASE,
  SessionStatusBadge,
} from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"

export const metadata = { title: "Preparación de sesión — Poker Manager" }

export default async function PreparationPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/preparacion">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/preparacion`
  )
  const session = await loadSession(id, user)
  const checklist = await getOpeningChecklist(id, user)
  const step = (sid: string) => checklist.steps.find((s) => s.id === sid)!
  const editable =
    session.canManagePreparation && session.status === "PREPARATION"
  const cashStep = step("CASH_ZERO_CONFIRMED")
  // Efectivo administrativo (abonos fuera de sesión): no es fondo de la caja.
  const custody = await getCustodySummary()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}`}
        label={`Sesión ${session.folio}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Preparación · {session.folio}</h1>
        <SessionStatusBadge status={session.status} />
      </div>
      <p className="text-muted-foreground text-sm">
        Responsable: {session.createdBy.name}
      </p>

      {!session.canManagePreparation ? (
        <p
          className="flex items-start gap-2 rounded-lg border p-3 text-sm"
          data-testid="read-only-preparation"
        >
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          No tienes permiso para modificar la preparación de esta sesión. Puedes
          consultar su avance.
        </p>
      ) : null}

      {session.status === "DRAFT" && session.canManagePreparation ? (
        <SessionActionButton
          url={`/api/sessions/${id}/prepare`}
          label="Iniciar preparación"
          success="Preparación iniciada"
          testId="start-preparation"
        />
      ) : null}

      <Card>
        <CardContent>
          <OpeningChecklistView checklist={checklist} />
        </CardContent>
      </Card>

      {session.status === "PREPARATION" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                1. Arqueo del inventario compartido
              </CardTitle>
              <p className="text-muted-foreground text-xs">
                Un solo conteo físico de todas las fichas (ambas mesas comparten
                el inventario).
              </p>
            </CardHeader>
            <CardContent>
              <Link
                href={`${SESSIONS_BASE}/${id}/arqueo-fichas`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "h-11 w-full md:h-9 md:w-auto"
                )}
                data-testid="go-chip-count"
              >
                {step("CHIP_COUNT_CONFIRMED").status === "DONE"
                  ? "Ver arqueo de fichas"
                  : "Contar fichas"}
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                2. Caja física inicial
              </CardTitle>
              <p className="text-muted-foreground text-xs">
                Debe estar en {formatNominal("0")}. No se registra ningún
                movimiento de dinero.
              </p>
            </CardHeader>
            <CardContent>
              {cashStep.status === "DONE" ? (
                <p className="text-sm" data-testid="cash-zero-done">
                  Caja confirmada en $0.00
                  {cashStep.completedBy
                    ? ` por ${cashStep.completedBy.name}`
                    : ""}
                  .
                </p>
              ) : editable ? (
                <>
                  {custody.total !== "0.00" ? (
                    <p
                      className="mb-3 rounded-lg border border-amber-500/50 p-3 text-sm"
                      role="note"
                      data-testid="custody-segregation"
                    >
                      Hay {formatNominal(custody.total)} de efectivo
                      administrativo en custodia (abonos fuera de sesión). No es
                      parte de esta caja: si está en el mismo lugar, sepáralo
                      antes de contar. La caja debe quedar en $0.00.
                    </p>
                  ) : null}
                  <OpeningCashForm sessionId={id} />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">Pendiente.</p>
              )}
            </CardContent>
          </Card>
          <Link
            href={`${SESSIONS_BASE}/${id}/apertura`}
            className={cn(buttonVariants(), "h-12 w-full text-base")}
            data-testid="go-opening"
          >
            Revisar y abrir
          </Link>
        </>
      ) : null}
    </div>
  )
}
