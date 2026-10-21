import { Layers } from "lucide-react"

/**
 * Hay UN inventario físico compartido por ambas mesas: en lugar de un
 * selector de juego se muestra sobre qué inventario se opera.
 */
export function SharedInventoryNote({ name }: { name: string }) {
  return (
    <p
      className="text-muted-foreground flex items-center gap-1.5 text-sm"
      data-testid="shared-inventory"
    >
      <Layers className="size-4" aria-hidden="true" />
      <span>
        Inventario: <span className="text-foreground font-medium">{name}</span>{" "}
        (compartido por todas las mesas)
      </span>
    </p>
  )
}
