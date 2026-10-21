/**
 * Formato SOLO para mostrar valores nominales que ya calculó el servidor
 * (strings decimales). Ningún total definitivo se calcula en el navegador.
 * El valor nominal de las fichas NO es dinero en caja.
 */
const nominalFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})

export function formatNominal(value: string | number): string {
  return nominalFormatter.format(Number(value))
}

export function formatChips(quantity: number): string {
  return new Intl.NumberFormat("es-MX").format(quantity)
}

export function denominationTitle(d: {
  value: string
  color: string | null
  name?: string | null
}) {
  return `${formatNominal(d.value)}${d.color ? ` · ${d.color}` : ""}${d.name ? ` · ${d.name}` : ""}`
}
