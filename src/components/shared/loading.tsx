import { Loader2 } from "lucide-react"

export function Loading({ label = "Cargando…" }: { label?: string }) {
  return (
    <div
      role="status"
      className="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-2"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
