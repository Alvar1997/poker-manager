import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  SESSION_STATUS_LABEL,
  type SessionStatusValue,
} from "@/modules/sessions/session.state"

export const SESSIONS_BASE = "/dashboard/sesiones"

const STATUS_CLASS: Record<SessionStatusValue, string> = {
  DRAFT: "",
  PREPARATION: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  OPEN: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  CLOSING: "border-sky-500/50 text-sky-700 dark:text-sky-400",
  CLOSED: "text-muted-foreground",
  CANCELLED: "text-muted-foreground line-through",
}

export function SessionStatusBadge({ status }: { status: SessionStatusValue }) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status])}
      data-testid="session-status"
    >
      {SESSION_STATUS_LABEL[status]}
    </Badge>
  )
}
