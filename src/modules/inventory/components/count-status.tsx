import { Badge } from "@/components/ui/badge"

const STATUS: Record<string, string> = {
  DRAFT: "Borrador",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
}
const RECON: Record<string, string> = {
  NOT_REQUIRED: "Cuadrado",
  PENDING: "Diferencias pendientes",
  RECONCILED: "Conciliado",
  SUPERSEDED: "Sustituido por recuento",
}
export const COUNT_TYPE_LABEL: Record<string, string> = {
  INITIAL: "Inventario inicial",
  OPENING: "Apertura",
  CONTROL: "Control",
  CLOSING: "Cierre",
}

/** Estado del arqueo y, aparte, estado de sus diferencias. */
export function CountStatusBadges({
  status,
  reconciliationStatus,
}: {
  status: string
  reconciliationStatus: string
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge
        variant={status === "DRAFT" ? "outline" : "secondary"}
        data-testid="count-status"
      >
        {STATUS[status]}
      </Badge>
      {status === "CONFIRMED" ? (
        <Badge
          data-testid="count-reconciliation"
          variant={
            reconciliationStatus === "PENDING" ? "destructive" : "outline"
          }
        >
          {RECON[reconciliationStatus]}
        </Badge>
      ) : null}
    </span>
  )
}
