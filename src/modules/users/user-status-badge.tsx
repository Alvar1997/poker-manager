import { Badge } from "@/components/ui/badge"

export function UserStatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
      Activo
    </Badge>
  ) : (
    <Badge variant="destructive">Inactivo</Badge>
  )
}
