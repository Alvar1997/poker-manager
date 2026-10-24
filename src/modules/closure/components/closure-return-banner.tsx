"use client"

import { ArrowLeft, X } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

/**
 * Aviso «Volver al cierre» (asistente de cierre). Al pulsar RESOLVER se
 * guarda a dónde regresar; mientras el cajero resuelve en otras pantallas
 * (aunque navegue entre ellas) se muestra este botón fijo. Solo es una
 * comodidad del navegador: el estado del cierre siempre lo recalcula el
 * servidor al volver.
 */

const KEY = "pm.closureReturn"

type ReturnTarget = { url: string; folio: string }

export function saveClosureReturn(target: ReturnTarget | null) {
  try {
    if (target) window.sessionStorage.setItem(KEY, JSON.stringify(target))
    else window.sessionStorage.removeItem(KEY)
    window.dispatchEvent(new Event("pm-closure-return"))
  } catch {
    // Sin almacenamiento disponible: el cajero vuelve desde la sesión.
  }
}

function read(): ReturnTarget | null {
  try {
    const v = window.sessionStorage.getItem(KEY)
    return v ? (JSON.parse(v) as ReturnTarget) : null
  } catch {
    return null
  }
}

export function ClosureReturnBanner() {
  const pathname = usePathname()
  const [target, setTarget] = useState<ReturnTarget | null>(null)
  useEffect(() => {
    const sync = () => setTarget(read())
    sync()
    window.addEventListener("pm-closure-return", sync)
    return () => window.removeEventListener("pm-closure-return", sync)
  }, [pathname])
  if (!target || pathname === target.url.split("?")[0]) return null
  return (
    <div
      className="bg-primary text-primary-foreground fixed inset-x-3 bottom-3 z-50 flex items-center gap-2 rounded-xl p-2 shadow-lg md:inset-x-auto md:right-6 md:bottom-6"
      data-testid="closure-return-banner"
    >
      <Link
        href={target.url}
        className="flex min-h-11 flex-1 items-center gap-2 px-2 text-sm font-medium"
        onClick={() => saveClosureReturn(null)}
        data-testid="closure-return"
      >
        <ArrowLeft className="size-4" aria-hidden /> Volver al cierre{" "}
        {target.folio}
      </Link>
      <button
        type="button"
        className="flex size-11 items-center justify-center"
        aria-label="Ocultar"
        onClick={() => saveClosureReturn(null)}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  )
}
