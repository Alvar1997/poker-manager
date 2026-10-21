import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { TRANSACTION_TYPE_LABEL } from "@/modules/cash/cash.schemas"
import type { CashMovementView } from "@/modules/cash/cash.service"
import {
  CASH_BASE,
  formatMXN,
  MOVEMENT_STATUS_LABEL,
} from "@/modules/cash/components/format"

/** Renglón de movimiento: tipo, folio, importe y efecto en efectivo/banco. */
export function MovementCard({ m }: { m: CashMovementView }) {
  return (
    <Link
      href={`${CASH_BASE}/movimientos/${m.id}`}
      className="block rounded-xl"
      data-testid="cash-movement-row"
    >
      <Card className="hover:bg-muted/50 transition-colors">
        <CardContent className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Badge variant="secondary">
                {TRANSACTION_TYPE_LABEL[
                  m.type as keyof typeof TRANSACTION_TYPE_LABEL
                ] ?? m.type}
              </Badge>
              {m.status !== "ACTIVE" ? (
                <Badge variant="outline">
                  {MOVEMENT_STATUS_LABEL[m.status]}
                </Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(m.createdAt)}
            </span>
          </div>
          <p className="flex items-center justify-between gap-2 font-medium">
            <span className="font-mono text-xs">{m.folio}</span>
            <span className="tabular-nums">{formatMXN(m.amount)}</span>
          </p>
          {m.moneyEffects.length ? (
            <p className="text-muted-foreground text-xs">
              {m.moneyEffects
                .map(
                  (e) =>
                    `${e.accountName} ${e.amount.startsWith("-") ? "−" : "+"}${formatMXN(e.amount.replace("-", ""))}`
                )
                .join(" · ")}
            </p>
          ) : null}
          <p className="truncate text-xs">{m.reason}</p>
        </CardContent>
      </Card>
    </Link>
  )
}
