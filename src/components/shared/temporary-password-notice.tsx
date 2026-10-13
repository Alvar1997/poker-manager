"use client"

import { Check, Copy, KeyRound } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"

/**
 * Muestra UNA vez la credencial temporal generada por el servidor. No se
 * guarda en el navegador: al salir de la pantalla ya no se puede volver a
 * ver (habría que restablecerla de nuevo).
 */
export function TemporaryPasswordNotice({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-center gap-2 font-medium">
        <KeyRound className="size-4" aria-hidden="true" />
        Credencial temporal
      </div>
      <p className="text-muted-foreground text-sm">
        Entrégala en persona a <strong>{email}</strong>. Solo se muestra esta
        vez y deberá cambiarla en su primer acceso. No la envíes por correo ni
        chat.
      </p>
      <div className="flex items-center gap-2">
        <code
          data-testid="temporary-password"
          className="bg-background flex-1 rounded-md border px-3 py-2 font-mono text-base break-all select-all"
        >
          {password}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={copy}
          aria-label="Copiar credencial"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
