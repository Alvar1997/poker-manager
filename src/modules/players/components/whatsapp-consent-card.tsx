"use client"

import { BellOff, BellRing, Loader2, MessageCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest } from "@/lib/api-client"
import { formatDateTime } from "@/lib/format"
import {
  WHATSAPP_CONSENT_NOTICE,
  WHATSAPP_CONSENT_NOTICE_VERSION,
} from "@/modules/players/consent-notice"
import {
  CONSENT_SOURCE_LABEL,
  CONSENT_SOURCES,
} from "@/modules/players/player.schemas"
import type { ConsentStatus } from "@/modules/players/player.service"

type Mode = "grant" | "revoke" | null

/**
 * Consentimiento de WhatsApp: flujo separado y auditable (WA-02/05/06/12).
 * Solo registra la decisión del jugador; no envía mensajes.
 */
export function WhatsAppConsentCard({
  playerId,
  playerName,
  status,
  canRecord,
}: {
  playerId: string
  playerName: string
  status: ConsentStatus
  canRecord: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(null)
  const [source, setSource] =
    useState<(typeof CONSENT_SOURCES)[number]>("IN_PERSON")
  const [evidence, setEvidence] = useState("")
  const [notes, setNotes] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  function open(next: Mode) {
    setSource("IN_PERSON")
    setEvidence("")
    setNotes("")
    setConfirmed(false)
    setMode(next)
  }

  async function submit() {
    setBusy(true)
    try {
      await apiRequest(`/api/players/${playerId}/notification-consent`, {
        method: "POST",
        body:
          mode === "grant"
            ? {
                action: "GRANTED",
                noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
                source,
                confirmedByPlayer: confirmed,
                evidenceReference: evidence,
                notes,
              }
            : { action: "REVOKED", source, evidenceReference: evidence, notes },
      })
      toast.success(
        mode === "grant"
          ? "Consentimiento registrado"
          : "Consentimiento revocado"
      )
      setMode(null)
      router.refresh()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "No se pudo registrar"
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle
          role="heading"
          aria-level={2}
          className="flex flex-wrap items-center gap-2"
        >
          <MessageCircle className="size-4" aria-hidden="true" />
          Notificaciones por WhatsApp
          {status.granted ? (
            <Badge
              data-testid="consent-status"
              className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
            >
              Aceptadas
            </Badge>
          ) : (
            <Badge data-testid="consent-status" variant="outline">
              Sin consentimiento
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.lastRecordedAt ? (
          <p className="text-muted-foreground">
            Último registro:{" "}
            {status.lastAction === "GRANTED" ? "aceptación" : "revocación"} el{" "}
            {formatDateTime(status.lastRecordedAt)} (aviso{" "}
            {status.noticeVersion}).
          </p>
        ) : (
          <p className="text-muted-foreground">
            El jugador no ha aceptado notificaciones. No se le enviarán mensajes
            automáticos por WhatsApp.
          </p>
        )}
        {status.staleBecausePhoneChanged ? (
          <p className="text-amber-700 dark:text-amber-400">
            La aceptación anterior era para otro número: no está vigente para el
            teléfono actual. Registra una nueva aceptación si el jugador lo
            autoriza.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          La integración con WhatsApp aún no está activa: registrar el
          consentimiento no envía ningún mensaje.
        </p>
        {canRecord ? (
          status.granted ? (
            <Button
              variant="outline"
              className="h-11 md:h-8"
              onClick={() => open("revoke")}
            >
              <BellOff />
              Revocar consentimiento
            </Button>
          ) : (
            <Button className="h-11 md:h-8" onClick={() => open("grant")}>
              <BellRing />
              Registrar aceptación
            </Button>
          )
        ) : null}
      </CardContent>

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && !busy && setMode(null)}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>
            {mode === "grant"
              ? "Registrar aceptación"
              : "Revocar consentimiento"}
          </DialogTitle>
          <DialogDescription>
            {mode === "grant"
              ? `Lee o muestra este aviso a ${playerName} y registra su respuesta.`
              : `Registra que ${playerName} ya no quiere recibir notificaciones.`}
          </DialogDescription>
          {mode === "grant" ? (
            <p
              className="bg-muted rounded-md p-3 text-sm"
              data-testid="consent-notice"
            >
              {WHATSAPP_CONSENT_NOTICE}
              <span className="text-muted-foreground block pt-1 text-xs">
                Aviso versión {WHATSAPP_CONSENT_NOTICE_VERSION}
              </span>
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="consent-source">Cómo se obtuvo</Label>
            <NativeSelect
              id="consent-source"
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
            >
              {CONSENT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {CONSENT_SOURCE_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="consent-evidence">
              Referencia de evidencia (opcional)
            </Label>
            <Input
              id="consent-evidence"
              className="h-11 md:h-9"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="consent-notes">Nota (opcional)</Label>
            <Input
              id="consent-notes"
              className="h-11 md:h-9"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
          {mode === "grant" ? (
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-5 shrink-0 accent-current"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="consent-confirm"
              />
              Confirmo que el jugador conoció el aviso y aceptó expresamente. No
              es una decisión del operador.
            </label>
          ) : null}
          <Button
            className="h-11 md:h-9"
            variant={mode === "revoke" ? "destructive" : "default"}
            disabled={busy || (mode === "grant" && !confirmed)}
            onClick={submit}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {mode === "grant" ? "Registrar aceptación" : "Revocar"}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
