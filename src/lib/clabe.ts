/**
 * CLABE interbancaria (México): 18 dígitos, el último es dígito de control.
 * Algoritmo oficial: pesos 3,7,1 sobre los primeros 17 dígitos, se suma
 * (dígito × peso) mod 10, y control = (10 − (suma mod 10)) mod 10.
 */
export function isValidClabe(value: string): boolean {
  if (!/^\d{18}$/.test(value)) return false
  const weights = [3, 7, 1]
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += (Number(value[i]) * weights[i % 3]) % 10
  }
  const control = (10 - (sum % 10)) % 10
  return control === Number(value[17])
}

/** Muestra solo los últimos 4 dígitos: "•••• 1234". */
export function maskLast4(last4: string | null | undefined): string | null {
  return last4 ? `•••• ${last4}` : null
}
