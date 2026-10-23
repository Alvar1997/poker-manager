/**
 * Silencia UNA advertencia concreta de `pg@8`:
 *
 *   DeprecationWarning: Calling client.query() when the client is already
 *   executing a query is deprecated and will be removed in pg@9.0.
 *
 * La emite `@prisma/adapter-pg` dentro de transacciones interactivas (no
 * nuestro código). Con `pg@8` las consultas se encolan y se ejecutan en
 * orden, así que es inofensiva; `pg` está fijado en `^8` (revisar al subir a
 * pg@9). Cualquier otra advertencia se emite sin cambios.
 *
 * Importar por efecto secundario (`import "@/lib/pg-deprecation-filter"`);
 * instalarlo varias veces no apila filtros.
 */

const PG_CONCURRENT_QUERY_MESSAGE =
  "Calling client.query() when the client is already executing a query"

const INSTALLED = Symbol.for("poker-manager.pg-deprecation-filter")

export function isPgConcurrentQueryWarning(warning: unknown): boolean {
  const message =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : ""
  return message.includes(PG_CONCURRENT_QUERY_MESSAGE)
}

export function installPgDeprecationFilter(): void {
  if (
    typeof process === "undefined" ||
    typeof process.emitWarning !== "function"
  ) {
    return
  }
  const holder = process as unknown as Record<symbol, boolean>
  if (holder[INSTALLED]) return
  holder[INSTALLED] = true

  const original = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (isPgConcurrentQueryWarning(warning)) return
    return (original as (...args: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
}

installPgDeprecationFilter()
