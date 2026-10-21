import { crc32, deflateSync, inflateSync } from "node:zlib"

import { z } from "zod"

/**
 * Firma táctil como TRAZOS (coordenadas enteras normalizadas a un lienzo
 * lógico de 1000 × 400). El navegador NO envía una imagen: el servidor
 * valida los trazos y genera él mismo el PNG, así que no es posible subir
 * una imagen arbitraria y declararla firma (FIR-11/12).
 *
 * Solo se reciben posiciones x/y: ni presión, ni velocidad, ni tiempos
 * (no se almacenan datos biométricos). Las validaciones rechazan firmas
 * vacías o triviales; NO verifican la identidad del jugador.
 */

export const PAD_WIDTH = 1000
export const PAD_HEIGHT = 400
export const PNG_WIDTH = 600
export const PNG_HEIGHT = 240
export const MAX_PNG_BYTES = 200 * 1024

const point = z.tuple([
  z.number().int().min(0).max(PAD_WIDTH),
  z.number().int().min(0).max(PAD_HEIGHT),
])

export const strokesSchema = z
  .array(z.array(point).min(1).max(2000), {
    message: "Debes registrar tu firma para continuar.",
  })
  .min(1, "Debes registrar tu firma para continuar.")
  .max(60, "La firma tiene demasiados trazos")

export type Strokes = z.infer<typeof strokesSchema>

export type StrokeMetrics = {
  strokes: number
  points: number
  pathLength: number
  width: number
  height: number
}

export function strokeMetrics(strokes: Strokes): StrokeMetrics {
  let points = 0
  let pathLength = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length; i++) {
      const [x, y] = stroke[i]
      points++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      if (i > 0) {
        const [px, py] = stroke[i - 1]
        pathLength += Math.hypot(x - px, y - py)
      }
    }
  }
  return {
    strokes: strokes.length,
    points,
    pathLength: Math.round(pathLength),
    width: points ? maxX - minX : 0,
    height: points ? maxY - minY : 0,
  }
}

/** Mínimos razonables: un punto, una raya corta o un garabato diminuto no son una firma. */
export const MIN_POINTS = 12
export const MIN_PATH_LENGTH = 250
export const MIN_WIDTH = 120
export const MIN_HEIGHT = 30
export const MAX_TOTAL_POINTS = 8000

export function assertMeaningfulSignature(strokes: Strokes): StrokeMetrics {
  const m = strokeMetrics(strokes)
  if (m.points > MAX_TOTAL_POINTS)
    throw new Error("La firma tiene demasiados puntos")
  if (
    m.points < MIN_POINTS ||
    m.pathLength < MIN_PATH_LENGTH ||
    m.width < MIN_WIDTH ||
    m.height < MIN_HEIGHT
  )
    throw new Error(
      "La firma es demasiado corta o está vacía: firma de nuevo usando más espacio del recuadro."
    )
  return m
}

// ── Rasterizado y PNG (determinista) ─────────────────────────────────

const INK = 20
const PAPER = 255
const RADIUS = 2

function stamp(pixels: Uint8Array, cx: number, cy: number) {
  const r2 = RADIUS * RADIUS
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (dx * dx + dy * dy > r2) continue
      const x = Math.round(cx) + dx
      const y = Math.round(cy) + dy
      if (x < 0 || y < 0 || x >= PNG_WIDTH || y >= PNG_HEIGHT) continue
      pixels[y * PNG_WIDTH + x] = INK
    }
  }
}

/** Dibuja los trazos en escala de grises (tinta oscura sobre fondo blanco). */
export function rasterizeStrokes(strokes: Strokes): Uint8Array {
  const pixels = new Uint8Array(PNG_WIDTH * PNG_HEIGHT).fill(PAPER)
  const sx = (PNG_WIDTH - 1) / PAD_WIDTH
  const sy = (PNG_HEIGHT - 1) / PAD_HEIGHT
  for (const stroke of strokes) {
    let [px, py] = [stroke[0][0] * sx, stroke[0][1] * sy]
    stamp(pixels, px, py)
    for (let i = 1; i < stroke.length; i++) {
      const x = stroke[i][0] * sx
      const y = stroke[i][1] * sy
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) * 2))
      for (let s = 1; s <= steps; s++)
        stamp(pixels, px + ((x - px) * s) / steps, py + ((y - py) * s) / steps)
      px = x
      py = y
    }
  }
  return pixels
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

/** PNG mínimo (IHDR + IDAT + IEND, sin metadatos), escala de grises 8 bits. */
export function encodeGrayPng(
  pixels: Uint8Array,
  width = PNG_WIDTH,
  height = PNG_HEIGHT
): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // profundidad
  ihdr[9] = 0 // escala de grises
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filtro: ninguno
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(
      raw,
      y * (width + 1) + 1
    )
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function renderSignaturePng(strokes: Strokes): Buffer {
  return encodeGrayPng(rasterizeStrokes(strokes))
}

/**
 * Inspección defensiva de un PNG almacenado (antes de servirlo): firma de
 * archivo, dimensiones esperadas y tamaño. Devuelve el número de píxeles
 * de tinta para pruebas.
 */
export function inspectSignaturePng(png: Buffer) {
  if (png.length > MAX_PNG_BYTES) throw new Error("Imagen demasiado grande")
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error("No es un PNG válido")
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (
    width !== PNG_WIDTH ||
    height !== PNG_HEIGHT ||
    png[24] !== 8 ||
    png[25] !== 0
  )
    throw new Error("Formato de firma no reconocido")
  // Junta los IDAT y cuenta tinta (solo PNG generados por este módulo: filtro 0).
  let offset = 8
  const idat: Buffer[] = []
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.toString("ascii", offset + 4, offset + 8)
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + len))
    offset += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  let ink = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (raw[y * (width + 1) + 1 + x] < 128) ink++
  return { width, height, ink }
}
