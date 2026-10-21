import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { Prisma } from "@/generated/prisma/client"
import { canonicalHash, canonicalJson } from "@/lib/canonical-json"
import {
  deliveryBlockers,
  requiresSignature,
  summarizePayments,
} from "@/modules/purchases/purchase.math"
import {
  receiptLines,
  receiptText,
  type ReceiptContent,
} from "@/modules/signatures/receipt.content"
import {
  CURRENT_DECLARATION_VERSION,
  DECLARATIONS,
  currentDeclaration,
} from "@/modules/signatures/signature.declaration"
import {
  captureSignatureSchema,
  receiptShareSchema,
} from "@/modules/signatures/signature.schemas"
import {
  assertMeaningfulSignature,
  inspectSignaturePng,
  PNG_SIGNATURE,
  renderSignaturePng,
  strokesSchema,
  type Strokes,
} from "@/modules/signatures/signature.strokes"

const D = (v: string) => new Prisma.Decimal(v)
const STROKES: Strokes = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

const content = {
  purchaseId: "c1",
  playerId: "p1",
  playerName: "Jugador",
  sessionId: "s1",
  sessionFolio: "SES-000001",
  tableId: "t1",
  tableName: "Mesa 25/25",
  purchaseFolio: "CMP-000001",
  purchaseType: "REBUY",
  rebuyNumber: 1,
  nominalAmount: "5000.00",
  confirmedPaymentsAmount: "1000.00",
  pendingTransferAmount: "0.00",
  outstandingCreditAmount: "4000.00",
  payments: [{ method: "CASH", amount: "1000.00" }],
  creditAuthorizationId: "a1",
  authorizedByPartnerId: "u1",
  partnerName: "Socio",
  authorizationChannel: "VERBAL",
  declarationText: DECLARATIONS["2026-10-v1"],
  declarationVersion: "2026-10-v1",
  purchaseVersion: 4,
}

describe("firma condicional", () => {
  it("con cualquier saldo a crédito se exige firma; pagada por completo, no", () => {
    const credit = summarizePayments(D("5000"), [
      { id: "a", method: "CASH", amount: D("4999.99"), status: "CONFIRMED" },
    ])
    expect(requiresSignature(credit)).toBe(true)
    const paid = summarizePayments(D("5000"), [
      { id: "a", method: "CASH", amount: D("5000"), status: "CONFIRMED" },
    ])
    expect(requiresSignature(paid)).toBe(false)
    expect(
      deliveryBlockers({
        editable: true,
        participationActive: true,
        financials: paid,
        creditAuthorizationValid: false,
        signatureValid: false,
      })
    ).toEqual([])
  })

  it("una firma inválida o ausente bloquea la entrega; una válida la permite", () => {
    const f = summarizePayments(D("1000"), [])
    const base = {
      editable: true,
      participationActive: true,
      financials: f,
      creditAuthorizationValid: true,
    }
    expect(deliveryBlockers({ ...base, signatureValid: false })).toEqual([
      "CREDIT_SIGNATURE_REQUIRED",
    ])
    expect(deliveryBlockers({ ...base, signatureValid: true })).toEqual([])
  })
})

describe("trazos y PNG de la firma", () => {
  it("rechaza una firma vacía, un punto o un trazo trivial", () => {
    expect(strokesSchema.safeParse([]).success).toBe(false)
    expect(strokesSchema.safeParse([[]]).success).toBe(false)
    expect(() => assertMeaningfulSignature([[[500, 200]]])).toThrow()
    expect(() =>
      assertMeaningfulSignature([
        [
          [10, 10],
          [20, 12],
          [30, 14],
        ],
      ])
    ).toThrow(/demasiado corta|vacía/)
    expect(() => assertMeaningfulSignature(STROKES)).not.toThrow()
  })

  it("solo acepta coordenadas enteras dentro del lienzo (sin presión ni tiempos)", () => {
    expect(strokesSchema.safeParse([[[1001, 10]]]).success).toBe(false)
    expect(strokesSchema.safeParse([[[1.5, 10]]]).success).toBe(false)
    expect(strokesSchema.safeParse([[[10, 10, 0.5]]]).success).toBe(false)
    expect(
      strokesSchema.safeParse([[{ x: 10, y: 10, pressure: 1 }]]).success
    ).toBe(false)
  })

  it("genera un PNG válido, sin metadatos y determinista", () => {
    const a = renderSignaturePng(STROKES)
    const b = renderSignaturePng(STROKES)
    expect(a.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(a.equals(b)).toBe(true)
    const info = inspectSignaturePng(a)
    expect(info).toMatchObject({ width: 600, height: 240 })
    expect(info.ink).toBeGreaterThan(150)
    // Solo IHDR, IDAT e IEND (sin tEXt/eXIf).
    expect(a.includes(Buffer.from("tEXt"))).toBe(false)
    expect(a.includes(Buffer.from("eXIf"))).toBe(false)
    expect(a.length).toBeLessThan(200 * 1024)
  })

  it("la captura acepta trazos y la huella del resumen; nunca una imagen ni importes", () => {
    const base = {
      snapshotId: "snap1",
      payloadHash: "a".repeat(64),
      strokes: STROKES,
      idempotencyKey: "clave-12345678",
    }
    expect(captureSignatureSchema.safeParse(base).success).toBe(true)
    for (const extra of [
      { image: "data:image/png;base64,AAAA" },
      { signed: true },
      { nominalAmount: "1" },
      { playerId: "p2" },
      { signedAt: "2026-01-01" },
    ])
      expect(
        captureSignatureSchema.safeParse({ ...base, ...extra }).success
      ).toBe(false)
    expect(
      captureSignatureSchema.safeParse({ ...base, payloadHash: "x" }).success
    ).toBe(false)
  })
})

describe("snapshot, huella canónica y declaración", () => {
  it("la serialización canónica no depende del orden de las propiedades", () => {
    const reordered = Object.fromEntries(Object.entries(content).reverse())
    expect(canonicalJson(reordered)).toBe(canonicalJson(content))
    expect(canonicalHash(reordered)).toBe(canonicalHash(content))
    expect(canonicalHash(content)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => canonicalJson({ amount: 0.1 })).toThrow(/strings decimales/)
  })

  it("cualquier cambio material cambia la huella (la firma deja de valer)", () => {
    const h = canonicalHash(content)
    for (const change of [
      { nominalAmount: "6000.00" },
      {
        confirmedPaymentsAmount: "1500.00",
        outstandingCreditAmount: "3500.00",
      },
      { payments: [{ method: "CARD_DEBIT", amount: "1000.00" }] },
      { authorizedByPartnerId: "u2", partnerName: "Otro socio" },
      { playerId: "p2", playerName: "Otro" },
      { tableId: "t2", tableName: "Mesa 10/10" },
      { purchaseId: "c2" },
      { rebuyNumber: 2 },
      { pendingTransferAmount: "500.00" },
      { declarationVersion: "2027-01-v2", declarationText: "Otro texto" },
      { purchaseVersion: 5 },
    ])
      expect(canonicalHash({ ...content, ...change })).not.toBe(h)
  })

  it("las declaraciones están versionadas y la vigente no se modifica en silencio", () => {
    expect(currentDeclaration()).toEqual({
      version: CURRENT_DECLARATION_VERSION,
      text: DECLARATIONS[CURRENT_DECLARATION_VERSION],
    })
    expect(DECLARATIONS["2026-10-v1"]).toBe(
      "Reconozco haber solicitado la compra de fichas por el importe señalado y acepto el saldo pendiente de pago mostrado. Entiendo que la entrega física será confirmada por el cajero una vez concluida esta operación."
    )
  })
})

describe("comprobante digital", () => {
  const receipt: ReceiptContent = {
    receiptFormat: "1",
    purchaseId: "c1",
    folio: "CMP-000001",
    confirmedAt: "2026-10-18T03:00:00.000Z",
    player: { id: "p1", name: "Jugador" },
    session: { id: "s1", folio: "SES-000001" },
    table: { id: "t1", name: "Mesa 25/25" },
    purchaseType: "REBUY",
    rebuyNumber: 2,
    purchaseLabel: "Recompra 2",
    nominalAmount: "5000.00",
    payments: [
      { method: "CASH", amount: "1000.00", reference: "MOV-000001" },
      { method: "CARD_DEBIT", amount: "1000.00", reference: "MOV-000002" },
    ],
    confirmedPayments: "2000.00",
    pendingTransfers: "1000.00",
    initialCredit: "3000.00",
    partner: { name: "Socio", channel: "MESSAGE" },
    deliveryStatus: "DELIVERED",
    deliveredBy: "Cajero",
    deliveredAt: "2026-10-18T03:00:00.000Z",
    signature: {
      signatureId: "sig1",
      signedAt: "2026-10-18T02:59:00.000Z",
      snapshotHash: "a".repeat(64),
    },
    operationReference: { deliveryId: "d1", inventoryOperationId: "op1" },
  }

  it("muestra importe, pagos por método, crédito inicial, socio y firma; nunca denominaciones", () => {
    const text = receiptText(receipt, "AVAILABLE")
    expect(text).toMatch(/CMP-000001/)
    expect(text).toMatch(/Recompra 2/)
    expect(text).toMatch(/Importe entregado: \$5,000\.00/)
    expect(text).toMatch(/Efectivo: \$1,000\.00/)
    expect(text).toMatch(/Tarjeta de débito \(terminal\): \$1,000\.00/)
    expect(text).toMatch(/Transferencia pendiente \(no cobrada\): \$1,000\.00/)
    expect(text).toMatch(/Crédito inicial: \$3,000\.00/)
    expect(text).toMatch(/Socio \(mensaje\)/)
    expect(text).toMatch(/Firmado por el jugador/)
    expect(text).not.toMatch(/denominaci|fichas de \$|\+52|tarjeta \d{4}/i)
  })

  it("una compra pagada no muestra firma y un comprobante anulado lo indica", () => {
    const paid = {
      ...receipt,
      signature: null,
      partner: null,
      initialCredit: "0.00",
      pendingTransfers: "0.00",
    }
    expect(receiptLines(paid).find((l) => l.label === "Firma")?.value).toBe(
      "No requerida (pagada)"
    )
    expect(receiptText(paid, "VOIDED")).toMatch(/ANULADO/)
  })

  it("compartir solo registra canales manuales conocidos", () => {
    expect(
      receiptShareSchema.safeParse({ channel: "NATIVE_SHARE" }).success
    ).toBe(true)
    expect(receiptShareSchema.safeParse({ channel: "WHATSAPP" }).success).toBe(
      false
    )
  })

  it("no existe generación de PDF (ni rutas ni pantallas)", () => {
    const root = join(process.cwd(), "src")
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? walk(p) : [p]
      })
    const files = walk(join(root, "app"))
    expect(files.some((f) => /pdf/i.test(f))).toBe(false)
    expect(
      existsSync(join(root, "app/api/purchases/[id]/receipt/image/route.ts"))
    ).toBe(true)
  })
})

describe("permisos", () => {
  it("los tres roles presentan resumen, capturan firma y consultan comprobantes", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.SIGNATURES_CAPTURE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.SIGNATURES_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.PURCHASES_READ)).toBe(true)
    }
  })
})
