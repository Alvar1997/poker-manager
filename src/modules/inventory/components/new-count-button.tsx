"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"

/** Inicia un arqueo de control del inventario común. Si ya hay borrador, lo abre. */
export function NewCountButton({
  chipSetId,
  label,
}: {
  chipSetId: string
  label: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function start() {
    setBusy(true)
    try {
      const count = await apiRequest<{ id: string }>(
        "/api/chip-inventory/counts",
        {
          method: "POST",
          body: { chipSetId, countType: "CONTROL" },
        }
      )
      router.push(`${INVENTORY_BASE}/arqueos/${count.id}`)
    } catch (e) {
      const existing = (
        e instanceof ApiClientError
          ? (e.details as { existingCountId?: string } | undefined)
          : undefined
      )?.existingCountId
      if (existing) {
        toast.info(
          "Ya había un arqueo en borrador del inventario: se abre para continuarlo"
        )
        router.push(`${INVENTORY_BASE}/arqueos/${existing}`)
        return
      }
      toast.error(
        e instanceof Error ? e.message : "No se pudo iniciar el arqueo"
      )
      setBusy(false)
    }
  }

  return (
    <Button className="h-11 w-full md:h-9" onClick={start} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : null}
      {label}
    </Button>
  )
}
