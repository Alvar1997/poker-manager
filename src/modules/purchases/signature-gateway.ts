import "server-only"

import { createHash } from "node:crypto"

import type { Prisma } from "@/generated/prisma/client"

/**
 * CONTRATO con el Módulo 09 — Firmas y comprobantes.
 *
 * Una compra que genera crédito (saldo por cobrar > 0, aunque sea parcial)
 * solo se entrega con una firma AUTÉNTICA del jugador capturada en el
 * dispositivo del cajero, ligada a:
 *   compra · jugador · importe · pagos confirmados · pendientes · saldo a
 *   crédito · socio autorizador · fecha · VERSIÓN exacta del resumen.
 *
 * El Módulo 08 no captura ni simula firmas: pregunta al verificador si
 * existe una firma válida para (compra, jugador, versión). Desde el Módulo
 * 09 el verificador activo es el real (`moduleSignatureVerifier`), que
 * revisa firma VALID, snapshot vigente, huellas e integridad de la imagen.
 * `unavailableSignatureVerifier` se conserva para pruebas. Nunca se acepta
 * un booleano enviado por el navegador.
 */

export type SignableSummary = {
  purchaseId: string
  folio: string
  playerId: string
  playerName: string
  sessionId: string
  tableName: string
  nominalAmount: string
  confirmedPayments: { paymentId: string; method: string; amount: string }[]
  pendingTransfers: { paymentId: string; amount: string }[]
  outstandingCredit: string
  partner: { id: string; name: string; channel: string } | null
  operationDate: string
  version: number
}

/** Huella determinista del resumen aceptado (cambia con cualquier dato material). */
export function summaryHash(summary: SignableSummary): string {
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex")
}

export type SignatureLookup = {
  purchaseId: string
  playerId: string
  summaryVersion: number
  summaryHash: string
}

export interface PurchaseSignatureVerifier {
  /** false mientras no exista el servicio real de firmas (Módulo 09). */
  readonly available: boolean
  /**
   * Devuelve la firma válida, no usada en otra compra, para exactamente esa
   * compra, jugador, versión y huella; null si no existe.
   */
  findValidSignature(
    tx: Prisma.TransactionClient,
    lookup: SignatureLookup
  ): Promise<{
    signatureId: string
    /** Tipo y número de recompra que el jugador vio al firmar. */
    expectedNumber?: {
      purchaseType: "INITIAL_PURCHASE" | "REBUY"
      rebuyNumber: number | null
    }
  } | null>
}

export const SIGNATURE_UNAVAILABLE_MESSAGE =
  "La entrega con crédito requiere la firma auténtica del jugador. La captura de firmas estará disponible con el Módulo 09 (firmas y comprobantes); mientras tanto, solo se entregan compras totalmente pagadas."

export const SIGNATURE_STALE_MESSAGE =
  "La compra cambió después de preparar el reconocimiento. Es necesario firmar nuevamente."

export const SIGNATURE_MISSING_MESSAGE =
  "Falta la firma del jugador para esta versión exacta de la compra (si cambió el importe, un pago o el socio autorizador, debe firmar de nuevo)."

/** Sin Módulo 09: nunca hay firma válida (las entregas con crédito se bloquean). */
export const unavailableSignatureVerifier: PurchaseSignatureVerifier = {
  available: false,
  async findValidSignature() {
    return null
  },
}

/**
 * Verificador real del Módulo 09 (firmas capturadas en el dispositivo del
 * cajero). Se carga de forma diferida para evitar el ciclo compras ↔ firmas.
 */
export const moduleSignatureVerifier: PurchaseSignatureVerifier = {
  available: true,
  async findValidSignature(tx, lookup) {
    const m = await import("@/modules/signatures/signature.service")
    return m.findValidPurchaseSignatureInTx(tx, lookup)
  },
}

let active: PurchaseSignatureVerifier = moduleSignatureVerifier

/** El Módulo 09 registra aquí su verificador real. */
export function registerPurchaseSignatureVerifier(
  verifier: PurchaseSignatureVerifier
) {
  active = verifier
}

export function currentSignatureVerifier(): PurchaseSignatureVerifier {
  return active
}
