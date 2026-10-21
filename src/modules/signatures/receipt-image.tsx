import "server-only"

import { ImageResponse } from "next/og"

import {
  receiptDate,
  receiptLines,
  type ReceiptContent,
  type ReceiptLine,
} from "@/modules/signatures/receipt.content"

/**
 * Generador ÚNICO de comprobantes PNG (compras del Módulo 09 y abonos del
 * Módulo 10). Se construye de forma DETERMINISTA en el servidor a partir
 * del snapshot confirmado (no es una captura de pantalla) y con los mismos
 * renglones que muestra la pantalla. No genera PDF.
 */
export async function renderDocumentPng(input: {
  kicker: string
  title: string
  date: string
  voided: boolean
  okLabel: string
  lines: ReceiptLine[]
  signaturePng?: Buffer | null
  signatureLabel?: string
  footer: string
}): Promise<Buffer> {
  const { lines, signaturePng } = input
  const width = 800
  const height = 230 + lines.length * 46 + (signaturePng ? 260 : 0) + 90
  const signatureSrc = signaturePng
    ? `data:image/png;base64,${signaturePng.toString("base64")}`
    : null
  const image = new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "#ffffff",
        color: "#111827",
        padding: 40,
        fontSize: 24,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 22, color: "#6b7280" }}>{input.kicker}</div>
          <div style={{ fontSize: 40, fontWeight: 700 }}>{input.title}</div>
          <div style={{ fontSize: 22, color: "#6b7280" }}>{input.date}</div>
        </div>
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            padding: "6px 16px",
            borderRadius: 999,
            border: `2px solid ${input.voided ? "#b91c1c" : "#047857"}`,
            color: input.voided ? "#b91c1c" : "#047857",
            fontSize: 22,
          }}
        >
          {input.voided ? "ANULADO" : input.okLabel}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 24,
          borderTop: "2px solid #e5e7eb",
        }}
      >
        {lines.map((l, i) => (
          <div
            key={`${i}-${l.label}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "8px 0",
              borderBottom: "1px solid #f3f4f6",
              fontWeight: l.strong ? 700 : 400,
            }}
          >
            <div style={{ display: "flex", color: "#4b5563" }}>{l.label}</div>
            <div style={{ display: "flex" }}>{l.value}</div>
          </div>
        ))}
      </div>
      {signatureSrc ? (
        <div
          style={{ display: "flex", flexDirection: "column", marginTop: 20 }}
        >
          <div style={{ display: "flex", fontSize: 20, color: "#6b7280" }}>
            {input.signatureLabel ?? "Firma"}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={signatureSrc}
            width={600}
            height={240}
            alt="Firma"
            style={{ border: "1px solid #e5e7eb", borderRadius: 8 }}
          />
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          marginTop: 20,
          fontSize: 18,
          color: "#9ca3af",
        }}
      >
        {input.footer}
      </div>
    </div>,
    { width, height }
  )
  return Buffer.from(await image.arrayBuffer())
}

/** PNG del comprobante de compra (Módulo 09). */
export async function renderReceiptPng(input: {
  content: ReceiptContent
  status: "AVAILABLE" | "VOIDED"
  signaturePng: Buffer | null
}): Promise<Buffer> {
  const c = input.content
  return renderDocumentPng({
    kicker: "Poker Manager · Comprobante digital",
    title: c.folio,
    date: receiptDate(c.confirmedAt),
    voided: input.status === "VOIDED",
    okLabel: "Entregado",
    lines: receiptLines(c),
    signaturePng: input.signaturePng,
    signatureLabel: "Firma del jugador (reconocimiento de crédito)",
    footer: `Ref. ${c.operationReference.deliveryId} · Sin denominaciones: fichas por importe.`,
  })
}
