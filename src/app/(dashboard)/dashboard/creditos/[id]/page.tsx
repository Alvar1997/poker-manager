import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import {
  CREDITS_BASE,
  RECEIVABLE_STATUS_LABEL,
  StatusBadge,
} from "@/modules/credits/components/credit-ui"
import { getReceivable } from "@/modules/credits/receivable.service"
import { PURCHASES_BASE } from "@/modules/purchases/components/purchase-ui"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Crédito — Poker Manager" }

const SOURCE_LABEL: Record<string, string> = {
  RECEIVABLE_PAYMENT: "Abono",
  PURCHASE_PAYMENT: "Transferencia de la compra",
  CHIP_SETTLEMENT_OFFSET: "Compensación con fichas",
}

export default async function ReceivablePage({
  params,
}: PageProps<"/dashboard/creditos/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.CREDITS_READ,
    CREDITS_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const r = await getReceivable(id, {
    showPhone: can(user, PERMISSIONS.PLAYERS_READ),
  }).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <BackLink
        href={`${CREDITS_BASE}/jugadores/${r.player.id}`}
        label={r.player.name}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          Crédito · <span className="font-mono">{r.origin.purchaseFolio}</span>
        </h1>
        <StatusBadge status={r.status} labels={RECEIVABLE_STATUS_LABEL} />
      </div>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">
                Importe original
              </dt>
              <dd className="tabular-nums">{formatMXN(r.originalAmount)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Saldo</dt>
              <dd
                className="text-lg font-semibold tabular-nums"
                data-testid="receivable-detail-balance"
              >
                {formatMXN(r.balance)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Origen</dt>
              <dd>
                <Link
                  className="underline-offset-4 hover:underline"
                  href={`${PURCHASES_BASE}/${r.origin.purchaseId}`}
                >
                  Compra {r.origin.purchaseFolio}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Sesión y mesa</dt>
              <dd>
                {r.origin.session.folio} · {r.origin.table.name}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Autorizó</dt>
              <dd>
                {r.partner.name} (
                {r.partner.channel === "VERBAL" ? "verbal" : "mensaje"})
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Firma</dt>
              <dd>
                {r.signatureId ? (
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`${PURCHASES_BASE}/${r.origin.purchaseId}/comprobante`}
                  >
                    Firmada · ver comprobante
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Nació</dt>
              <dd>{formatDateTime(r.createdAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aplicaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {r.history.length === 0 ? (
            <p className="text-muted-foreground text-sm">Sin abonos todavía.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="allocation-history">
              {r.history.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {a.kind === "REVERSAL" ? "Reverso · " : ""}
                    {SOURCE_LABEL[a.source]}
                    {a.receivablePayment ? (
                      <>
                        {" "}
                        <Link
                          className="underline-offset-4 hover:underline"
                          href={`${CREDITS_BASE}/abonos/${a.receivablePayment.id}`}
                        >
                          {a.receivablePayment.folio}
                        </Link>
                      </>
                    ) : null}
                    <span className="text-muted-foreground text-xs">
                      {" "}
                      · {formatDateTime(a.allocatedAt)}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {a.kind === "REVERSAL" ? "+" : "−"}
                    {formatMXN(a.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
