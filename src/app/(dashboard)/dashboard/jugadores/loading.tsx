import { Skeleton } from "@/components/ui/skeleton"

export default function PlayersLoading() {
  return (
    <div
      className="mx-auto max-w-5xl space-y-4"
      aria-busy="true"
      aria-label="Cargando jugadores"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-11 w-36 md:h-9" />
      </div>
      <Skeleton className="h-11 w-full md:h-9" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
