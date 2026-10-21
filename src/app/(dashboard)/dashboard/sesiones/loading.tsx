import { Skeleton } from "@/components/ui/skeleton"

export default function SessionsLoading() {
  return (
    <div
      className="mx-auto max-w-3xl space-y-4"
      aria-busy="true"
      aria-label="Cargando sesiones"
    >
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  )
}
