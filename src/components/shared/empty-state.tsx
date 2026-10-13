import type { LucideIcon } from "lucide-react"
import { Inbox } from "lucide-react"
import type { ReactNode } from "react"

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: {
  title: string
  description?: string
  icon?: LucideIcon
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center">
      <Icon className="text-muted-foreground size-10" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  )
}
