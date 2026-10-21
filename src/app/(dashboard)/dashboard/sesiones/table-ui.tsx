import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const LABEL = {
  PENDING: "Sin abrir",
  OPEN: "Abierta",
  CLOSED: "Cerrada",
} as const

export function TableStatusBadge({ status }: { status: keyof typeof LABEL }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "OPEN" &&
          "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
        status !== "OPEN" && "text-muted-foreground"
      )}
      data-testid="table-status"
    >
      {LABEL[status]}
    </Badge>
  )
}
