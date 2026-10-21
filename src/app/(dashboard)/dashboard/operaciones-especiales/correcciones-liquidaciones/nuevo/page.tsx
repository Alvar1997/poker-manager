import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { KeyValue, PageHeader } from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { SettlementCorrectionForm } from "@/modules/special-operations/components/special-actions"
import { previewSettlementCorrection } from "@/modules/special-operations/settlement-correction.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = {
  title: "Ejecutar corrección de liquidación — Poker Manager",
}
export const dynamic = "force-dynamic"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function NewSettlementCorrectionPage({
  searchParams,
}: PageProps<"/dashboard/operaciones-especiales/correcciones-liquidaciones/nuevo">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/correcciones-liquidaciones`
  )
  const sp = await searchParams
  const settlementId =
    typeof sp.settlementId === "string" ? sp.settlementId : ""
  const correctionId =
    typeof sp.correctionId === "string" ? sp.correctionId : ""
  if (!ID.test(settlementId)) notFound()
  const v = await previewSettlementCorrection(settlementId, {
    kind: "OFFSET_REVERSAL",
  }).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  return (
    <>
      <BackLink
        href={`${SPECIAL_BASE}/correcciones-liquidaciones`}
        label="Correcciones de liquidaciones"
      />
      <PageHeader
        title={`Corrección de la liquidación ${v.settlement.folio}`}
        description={v.settlement.player.name}
      />
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <KeyValue label="Fichas recibidas">
              {formatMXN(v.settlement.returned)}
            </KeyValue>
            <KeyValue
              label="Compensación vigente"
              testId="settlement-active-offsets"
            >
              {formatMXN(v.settlement.activeOffsets)}
            </KeyValue>
            <KeyValue label="Sesión">{`${v.settlement.session.folio} · ${v.settlement.session.status}`}</KeyValue>
            <KeyValue label="Autorización">
              {v.correction ? v.correction.folio : "Sin solicitud aprobada"}
            </KeyValue>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Ejecutar con la firma del jugador
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!v.correction ||
          (correctionId && correctionId !== v.correction.id) ? (
            <p
              className="text-sm"
              data-testid="settlement-correction-needs-approval"
            >
              Requiere una solicitud de corrección APROBADA por PARTNER o
              SUPERADMIN (Administración → Correcciones).
            </p>
          ) : can(user, PERMISSIONS.SPECIAL_OPS_OPERATE) ? (
            <SettlementCorrectionForm
              settlementId={v.settlement.id}
              correctionId={v.correction.id}
              version={v.settlement.version}
            />
          ) : null}
          <p className="text-muted-foreground mt-3 text-xs">
            No implementado: reclamar al jugador dinero pagado de más
            (requeriría una cuenta por cobrar nueva).
          </p>
        </CardContent>
      </Card>
    </>
  )
}
