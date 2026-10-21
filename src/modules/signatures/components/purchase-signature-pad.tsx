"use client"

import { Eraser, Loader2, PenLine } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

/**
 * Lienzo de firma táctil (dedo, stylus o mouse) con Pointer Events y canvas
 * nativo, sin bibliotecas. Guarda solo posiciones x/y normalizadas a un
 * lienzo lógico de 1000 × 400 (ni presión ni tiempos). El servidor valida
 * los trazos y genera el PNG; aquí solo se dibuja para que el jugador vea
 * su trazo.
 *
 * - `touch-action: none` + captura del puntero: no se desplaza la página
 *   mientras se firma.
 * - Proporción fija 5:2; al rotar o cambiar el tamaño se vuelve a dibujar
 *   desde las coordenadas normalizadas (no se deforma ni se pierde).
 */

export const PAD_W = 1000
export const PAD_H = 400

export type PadStrokes = [number, number][][]

/** Validación previa (la definitiva está en el servidor). */
function looksMeaningful(strokes: PadStrokes) {
  let points = 0
  let length = 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const s of strokes)
    s.forEach(([x, y], i) => {
      points++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      if (i > 0) length += Math.hypot(x - s[i - 1][0], y - s[i - 1][1])
    })
  return (
    points >= 12 && length >= 250 && maxX - minX >= 120 && maxY - minY >= 30
  )
}

export function PurchaseSignaturePad({
  onConfirm,
  pending,
  disabled,
}: {
  onConfirm: (strokes: PadStrokes) => void
  pending: boolean
  disabled?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<PadStrokes>([])
  const drawingRef = useRef(false)
  const [count, setCount] = useState(0)
  const [hint, setHint] = useState<string | null>(null)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, rect.width, rect.height)
    ctx.strokeStyle = "#111827"
    ctx.lineWidth = Math.max(2, rect.width / 250)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    const sx = rect.width / PAD_W
    const sy = rect.height / PAD_H
    for (const s of strokesRef.current) {
      ctx.beginPath()
      s.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x * sx, y * sy) : ctx.lineTo(x * sx, y * sy)
      )
      if (s.length === 1) ctx.lineTo(s[0][0] * sx + 0.1, s[0][1] * sy)
      ctx.stroke()
    }
  }, [])

  useEffect(() => {
    redraw()
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => redraw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redraw])

  function toPoint(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.round(((e.clientX - rect.left) / rect.width) * PAD_W)
    const y = Math.round(((e.clientY - rect.top) / rect.height) * PAD_H)
    return [Math.min(PAD_W, Math.max(0, x)), Math.min(PAD_H, Math.max(0, y))]
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || pending) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Algunos navegadores no capturan punteros sintéticos: se dibuja igual.
    }
    drawingRef.current = true
    strokesRef.current.push([toPoint(e)])
    setHint(null)
    redraw()
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    e.preventDefault()
    const stroke = strokesRef.current[strokesRef.current.length - 1]
    const p = toPoint(e)
    const last = stroke[stroke.length - 1]
    if (last[0] === p[0] && last[1] === p[1]) return
    if (stroke.length < 2000) stroke.push(p)
    redraw()
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    drawingRef.current = false
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      // Sin captura previa.
    }
    setCount(strokesRef.current.length)
  }

  function clear() {
    strokesRef.current = []
    setCount(0)
    setHint(null)
    redraw()
  }

  function confirm() {
    if (!looksMeaningful(strokesRef.current)) {
      setHint("Debes registrar tu firma para continuar.")
      return
    }
    onConfirm(strokesRef.current.map((s) => s.map((p) => [p[0], p[1]])))
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Recuadro de firma: firma con el dedo o con un lápiz digital"
          data-testid="signature-canvas"
          className="aspect-[5/2] w-full touch-none rounded-lg border-2 border-dashed border-slate-400 bg-white select-none"
          style={{ touchAction: "none" }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        />
        {count === 0 ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500">
            <PenLine className="size-4" aria-hidden="true" />
            Firma aquí
          </span>
        ) : null}
      </div>
      {hint ? (
        <p className="text-destructive text-sm" role="alert">
          {hint}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {count === 0
            ? "Usa el dedo o un lápiz digital. Puedes borrar y repetir."
            : `Trazo registrado (${count} ${count === 1 ? "trazo" : "trazos"}). Revisa y confirma.`}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12"
          onClick={clear}
          disabled={pending || count === 0}
          data-testid="signature-clear"
        >
          <Eraser />
          Borrar
        </Button>
        <Button
          type="button"
          className="h-12"
          onClick={confirm}
          disabled={pending || disabled || count === 0}
          data-testid="signature-confirm"
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          Confirmar firma
        </Button>
      </div>
    </div>
  )
}
