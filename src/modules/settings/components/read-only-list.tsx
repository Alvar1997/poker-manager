import type { ReactNode } from "react"

/** Lista de pares etiqueta/valor de solo lectura (apilada en celular). */
export function ReadOnlyList({
  items,
}: {
  items: { label: string; value: ReactNode; hint?: string }[]
}) {
  return (
    <dl className="divide-y text-sm">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium break-words sm:text-right">
            {item.value}
            {item.hint ? (
              <span className="text-muted-foreground block text-xs font-normal">
                {item.hint}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
