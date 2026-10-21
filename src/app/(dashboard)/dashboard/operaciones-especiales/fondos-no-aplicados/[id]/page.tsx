import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  KeyValue,
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import { formatMXN } from "@/modules/cash/components/format"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { UnappliedRefundForm } from "@/modules/special-operations/components/special-actions"
import {
  PayableCard,
  ReceiptsCard,
} from "@/modules/special-operations/components/special-ui"
import { UNAPPLIED_STATUS_LABEL } from "@/modules/special-operations/special-query.service"
import { getUnappliedFunds } from "@/modules/special-operations/unapplied-funds.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Fondos no aplicados — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function UnappliedFundsDetailPage({
  params,
}: PageProps<"/dashboard/operaciones-especiales/fondos-no-aplicados/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    `${SPECIAL_BASE}/fondos-no-aplicados`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const f = await getUnappliedFunds(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const approved = f.corrections.find(
    (c) => c.status === "APPROVED" || c.status === "FAILED"
  )
  const open = f.corrections.find((c) =>
    ["REQUESTED", "UNDER_REVIEW"].includes(c.status)
  )
  return (
    <>
      <BackLink
        href={`${SPECIAL_BASE}/fondos-no-aplicados`}
        label="Fondos no aplicados"
      />
      <PageHeader
        title={`Fondos no aplicados · ${f.player.name}`}
        description={f.reason}
      />
      <Card>
        <CardContent className="space-y-3">
          <p data-testid="unapplied-status">
            <StatusBadge
              value={f.status === "REFUNDED" ? "COMPLETED" : "WARNING"}
              label={UNAPPLIED_STATUS_LABEL[f.status]}
            />
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <KeyValue
              label="Importe recibido no aplicado"
              testId="unapplied-amount"
            >
              {formatMXN(f.amount)}
            </KeyValue>
            <KeyValue label="Transferencia de origen">
              {`${formatMXN(f.bankTransfer.amount)}${f.bankTransfer.bankReference ? ` · ref. ${f.bankTransfer.bankReference}` : ""}`}
            </KeyValue>
            <KeyValue label="Registrado">
              {formatDateTime(f.createdAt)}
            </KeyValue>
          </dl>
          <p className="text-muted-foreground text-xs">
            No es saldo a favor ni se aplica a deudas futuras.
          </p>
        </CardContent>
      </Card>
      {!f.payable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Devolución</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {approved && can(user, PERMISSIONS.SPECIAL_OPS_OPERATE) ? (
              <UnappliedRefundForm fundsId={f.id} correctionId={approved.id} />
            ) : open ? (
              <p className="text-sm">
                Solicitud{" "}
                <Link
                  href={`/dashboard/administracion/correcciones/${open.id}`}
                  className="underline"
                >
                  {open.folio}
                </Link>{" "}
                pendiente de autorización por un socio o superadministrador.
              </p>
            ) : (
              <LinkButton
                href={`/dashboard/administracion/correcciones/nueva?type=UNAPPLIED_FUNDS_RETURN&targetId=${f.id}`}
                testId="request-unapplied-refund"
              >
                Solicitar autorización de devolución
              </LinkButton>
            )}
          </CardContent>
        </Card>
      ) : (
        <PayableCard
          payable={f.payable}
          canOperate={can(user, PERMISSIONS.SPECIAL_OPS_OPERATE)}
          sessionCashAllowed={false}
          title="Devolución al jugador"
        />
      )}
      <ReceiptsCard receipts={f.receipts} />
    </>
  )
}
