import { Landmark } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { listBankTransfers } from "@/modules/cash/bank-transfer.service"
import { bankTransfersQuerySchema } from "@/modules/cash/cash.schemas"
import { BankTransferActions } from "@/modules/cash/components/bank-transfer-actions"
import {
  CASH_BASE,
  formatMXN,
  TRANSFER_STATUS_LABEL,
} from "@/modules/cash/components/format"

import { BackToCash } from "../back-link"

export const metadata = { title: "Transferencias bancarias — Poker Manager" }

const TABS = [
  { status: "PENDING_VERIFICATION", label: "Pendientes" },
  { status: "CONFIRMED", label: "Confirmadas" },
  { status: "REJECTED", label: "Rechazadas" },
  { status: "", label: "Todas" },
] as const

export default async function BankTransfersPage({
  searchParams,
}: PageProps<"/dashboard/caja/transferencias">) {
  const user = await requirePagePermission(
    PERMISSIONS.CASH_READ,
    `${CASH_BASE}/transferencias`
  )
  const raw = await searchParams
  const status =
    typeof raw.status === "string" ? raw.status : "PENDING_VERIFICATION"
  const parsed = bankTransfersQuerySchema.safeParse({
    status: status || undefined,
    page: typeof raw.page === "string" ? raw.page : undefined,
  })
  const query = parsed.success
    ? parsed.data
    : bankTransfersQuerySchema.parse({})
  const result = await listBankTransfers(query)
  const canOperate = can(user, PERMISSIONS.CASH_OPERATE)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BackToCash />
      <div>
        <h1 className="text-xl font-semibold">Transferencias bancarias</h1>
        <p className="text-muted-foreground text-sm">
          Verificación manual: una transferencia solo cuenta como cobrada
          después de revisar el ingreso en la banca y confirmarla. Cajero, socio
          y superadministrador pueden verificarlas.
        </p>
      </div>

      <nav
        aria-label="Estado"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {TABS.map((t) => (
          <Link
            key={t.label}
            href={`${CASH_BASE}/transferencias?status=${t.status}`}
            aria-current={
              (query.status ?? "") === t.status ? "page" : undefined
            }
            className={cn(
              buttonVariants({
                variant:
                  (query.status ?? "") === t.status ? "default" : "outline",
              }),
              "h-11 md:h-9"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {result.items.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="Sin transferencias"
          description="Las transferencias se registran desde compras y abonos de jugadores (módulos posteriores) o al depositar efectivo."
        />
      ) : (
        <ul className="space-y-2" data-testid="transfer-list">
          {result.items.map((t) => (
            <li key={t.id}>
              <Card data-testid="transfer-row">
                <CardContent className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge
                      variant={
                        t.status === "PENDING_VERIFICATION"
                          ? "outline"
                          : "secondary"
                      }
                    >
                      {TRANSFER_STATUS_LABEL[t.status]}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(t.createdAt)}
                    </span>
                  </div>
                  <p className="flex items-center justify-between gap-2 font-medium">
                    <span>
                      {t.kind === "CASH_DEPOSIT"
                        ? "Depósito de efectivo"
                        : (t.player?.name ?? "Pago de jugador")}
                    </span>
                    <span
                      className="tabular-nums"
                      data-testid="transfer-amount"
                    >
                      {formatMXN(t.confirmedAmount ?? t.declaredAmount)}
                    </span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t.paymentAccount.bankName} {t.paymentAccount.masked}
                    {t.bankReference ? ` · Ref. ${t.bankReference}` : ""}
                    {t.senderName ? ` · ${t.senderName}` : ""}
                    {t.table ? ` · ${t.table.name}` : ""}
                  </p>
                  {t.verifiedBy ? (
                    <p className="text-muted-foreground text-xs">
                      {t.status === "REJECTED" ? "Rechazó" : "Verificó"}{" "}
                      {t.verifiedBy.name}
                      {t.verifiedAt ? ` · ${formatDateTime(t.verifiedAt)}` : ""}
                      {t.transaction ? ` · ${t.transaction.folio}` : ""}
                    </p>
                  ) : null}
                  {t.rejectionReason ? (
                    <p className="text-xs">Motivo: {t.rejectionReason}</p>
                  ) : null}
                  {canOperate && t.status === "PENDING_VERIFICATION" ? (
                    <BankTransferActions
                      id={t.id}
                      declaredAmount={t.declaredAmount}
                      bankReference={t.bankReference}
                    />
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
