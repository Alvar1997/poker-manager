import { Badge } from "@/components/ui/badge"

export function ActiveBadge({
  isActive,
  activeLabel = "Activo",
  inactiveLabel = "Inactivo",
}: {
  isActive: boolean
  activeLabel?: string
  inactiveLabel?: string
}) {
  return isActive ? (
    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
      {activeLabel}
    </Badge>
  ) : (
    <Badge variant="destructive">{inactiveLabel}</Badge>
  )
}
