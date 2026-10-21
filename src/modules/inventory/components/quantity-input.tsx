"use client"

import type { ComponentProps } from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Cantidad de fichas: entero, teclado numérico en celular, sin decimales. */
export function QuantityInput({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return (
    <Input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      enterKeyHint="next"
      className={cn("h-11 text-right text-base tabular-nums md:h-9", className)}
      {...props}
    />
  )
}

/** "" → null; "12" → 12; cualquier otra cosa → NaN (inválido). */
export function parseQuantity(raw: string): number | null {
  const v = raw.trim()
  if (v === "") return null
  return /^\d+$/.test(v) ? Number(v) : Number.NaN
}
