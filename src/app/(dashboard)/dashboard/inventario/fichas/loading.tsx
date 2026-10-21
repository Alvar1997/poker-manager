import { Skeleton } from "@/components/ui/skeleton"

export default function InventoryLoading() {
  return (
    <div
      className="mx-auto max-w-5xl space-y-4"
      aria-busy="true"
      aria-label="Cargando inventario"
    >
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-11 w-full" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </div>
  )
}
