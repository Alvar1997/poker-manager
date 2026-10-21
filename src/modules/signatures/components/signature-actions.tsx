"use client"

import { useMutation } from "@tanstack/react-query"
import { Copy, Download, Loader2, Share2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  PurchaseSignaturePad,
  type PadStrokes,
} from "@/modules/signatures/components/purchase-signature-pad"

function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : fallback
}

/**
 * Captura de la firma del jugador para el resumen que preparó el servidor
 * (se envían el id y la huella del resumen, más los trazos). No confirma
 * la entrega: eso lo hace el cajero después.
 */
export function SignatureCapture({
  purchaseId,
  snapshotId,
  payloadHash,
}: {
  purchaseId: string
  snapshotId: string
  payloadHash: string
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [reviewed, setReviewed] = useState(false)
  const capture = useMutation({
    mutationFn: (strokes: PadStrokes) =>
      apiRequest(`/api/purchases/${purchaseId}/signatures`, {
        method: "POST",
        body: { snapshotId, payloadHash, strokes, idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      toast.success("Firma registrada. El cajero debe confirmar la entrega.")
      router.refresh()
    },
    onError: (e) => {
      toast.error(errorText(e, "No se pudo registrar la firma"))
      // Si la compra cambió, la página prepara un resumen nuevo.
      if (e instanceof ApiClientError && e.status === 409) {
        renew()
        router.refresh()
      }
    },
  })
  return (
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          data-testid="summary-reviewed"
        />
        El jugador revisó el importe y el saldo a crédito
      </label>
      <PurchaseSignaturePad
        pending={capture.isPending}
        disabled={!reviewed}
        onConfirm={(strokes) => capture.mutate(strokes)}
      />
      {!reviewed ? (
        <p className="text-muted-foreground text-xs">
          Revisa el importe antes de firmar.
        </p>
      ) : null}
    </div>
  )
}

async function fetchReceiptPng(imageUrl: string) {
  const res = await fetch(imageUrl, {
    credentials: "same-origin",
    cache: "no-store",
  })
  if (!res.ok) throw new Error("No se pudo generar la imagen del comprobante")
  return res.blob()
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function recordShare(shareEventsUrl: string, channel: string) {
  return apiRequest(shareEventsUrl, {
    method: "POST",
    body: { channel },
  }).catch(() => undefined)
}

/**
 * Descargar PNG, compartir con el menú nativo del dispositivo o copiar el
 * resumen. Nada se envía automáticamente y nunca se afirma que se envió.
 */
export function ReceiptActions({
  purchaseId,
  folio,
  text,
  imageUrl = `/api/purchases/${purchaseId}/receipt/image`,
  shareEventsUrl = `/api/purchases/${purchaseId}/receipt/share-events`,
  filename = `comprobante-${folio}.png`,
}: {
  purchaseId: string
  folio: string
  text: string
  /** Comprobantes de abono (Módulo 10) usan sus propias rutas. */
  imageUrl?: string
  shareEventsUrl?: string
  filename?: string
}) {
  const [busy, setBusy] = useState<null | "download" | "share" | "copy">(null)

  async function download() {
    setBusy("download")
    try {
      saveBlob(await fetchReceiptPng(imageUrl), filename)
      toast.success("Imagen descargada")
    } catch (e) {
      toast.error(errorText(e, "No se pudo descargar"))
    } finally {
      setBusy(null)
    }
  }

  async function share() {
    setBusy("share")
    try {
      const blob = await fetchReceiptPng(imageUrl)
      const file = new File([blob], filename, { type: "image/png" })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Comprobante ${folio}` })
        await recordShare(shareEventsUrl, "NATIVE_SHARE")
        toast.success("Se abrió el menú para compartir.")
      } else {
        saveBlob(blob, filename)
        await recordShare(shareEventsUrl, "DOWNLOAD")
        toast.info(
          "Tu dispositivo no permite compartir archivos desde aquí: se descargó la imagen para que la compartas manualmente."
        )
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return
      toast.error(errorText(e, "No se pudo compartir"))
    } finally {
      setBusy(null)
    }
  }

  async function copy() {
    setBusy("copy")
    try {
      await navigator.clipboard.writeText(text)
      await recordShare(shareEventsUrl, "COPY_TEXT")
      toast.success("Resumen copiado")
    } catch {
      toast.error("No se pudo copiar el resumen")
    } finally {
      setBusy(null)
    }
  }

  const icon = (name: typeof busy, Icon: typeof Download) =>
    busy === name ? <Loader2 className="animate-spin" /> : <Icon />

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Button
        className="h-11 md:h-9"
        onClick={download}
        disabled={busy !== null}
        data-testid="receipt-download"
      >
        {icon("download", Download)}
        Descargar imagen
      </Button>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={share}
        disabled={busy !== null}
        data-testid="receipt-share"
      >
        {icon("share", Share2)}
        Compartir
      </Button>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={copy}
        disabled={busy !== null}
        data-testid="receipt-copy"
      >
        {icon("copy", Copy)}
        Copiar resumen
      </Button>
    </div>
  )
}
