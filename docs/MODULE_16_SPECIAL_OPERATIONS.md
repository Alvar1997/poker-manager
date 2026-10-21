# Módulo 16 — Operaciones financieras especiales

Canjes posteriores de fichas, reverso completo de compras confirmadas, corrección de liquidaciones con pagos reales y devolución de fondos no aplicados.

Estado: **implementado y probado contra PostgreSQL real (Docker) y en navegador (Chrome + iPhone)**. Migraciones `20261029120000_module16_enums` y `20261029130000_module16_special_operations`: verificadas en la base local de sombra y **aplicadas en Neon el 2026-10-21** (`migrate diff` vacío).

Leyenda: **IMPLEMENTED** · **TESTED** · **CONFIGURATION_REQUIRED** · **NOT_IMPLEMENTED**.

## 1. Principios (ESP-01 … ESP-25)

| Regla                                         | Cómo se garantiza                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folio único por operación                     | `issueFolio`: `CAN-` canje, `REV-` reverso, `AJL-` corrección, `PES-` pago especial.                                                                                                          |
| Lo original es inmutable                      | Compras, liquidaciones, firmas, comprobantes, cajas y snapshots de cierre no se editan. La compra solo pasa CONFIRMED → REVERSED (trigger, exige `purchase_reversals`).                       |
| Corregir = movimientos nuevos                 | Entradas nominales (`confirmNominalChipReturnInTx`), aplicaciones/contraaplicaciones (`payment_allocations`), obligaciones (`special_payables`) y asientos (`postTransactionInTx`).           |
| Autoriza PARTNER/SUPERADMIN; CASHIER solicita | Reverso, corrección y devolución exigen una `CorrectionRequest` **APROBADA** (Módulo 15). El valor de un canje lo valida `special-ops:authorize`.                                             |
| Autorizar ≠ ejecutar                          | Aprobar no escribe nada financiero. La solicitud pasa a EXECUTED solo dentro de la transacción que registró los efectos reales (`linkExecutionInTx`).                                         |
| Nunca dinero/fichas no recibidos o no pagados | Recepción física declarada + firma; pagos: efectivo entregado (asiento inmediato) o transferencia PENDING → EXECUTED con referencia.                                                          |
| Un solo inventario, una sola caja             | Se reutilizan `CHIPSET_MAIN` y `CashBox MAIN`; no hay inventarios ni cajas nuevas.                                                                                                            |
| Sin efectivo negativo                         | El libro rechaza el pago (custodia o caja de sesión insuficientes).                                                                                                                           |
| Sesión CLOSED intacta                         | Nunca se reabre; su caja no recibe asientos (trigger del Módulo 12). Los pagos posteriores salen de custodia administrativa o banco con fecha real.                                           |
| Estados parciales explícitos                  | `PARTIALLY_PAID` / `PARTIALLY_REFUNDED`; una transferencia en trámite se muestra aparte y no cuenta.                                                                                          |
| Sin doble ejecución                           | Índices únicos (un reverso por compra, una obligación por origen, una compensación revertida por liquidación), claves de idempotencia y trigger que impide comprometer más que la obligación. |
| CxC y CxP no se compensan                     | La deuda del jugador y lo que se le debe se registran por separado; el reverso de compensación las separa, nunca las fusiona.                                                                 |
| Sin saldo a favor                             | Fondos no aplicados solo se devuelven; nunca se aplican a deudas futuras.                                                                                                                     |
| Configuración no reescribe el pasado          | Los cálculos se basan en hechos registrados; ningún catálogo se usa retroactivamente.                                                                                                         |

## 2. 16.1 Canje posterior de fichas (IMPLEMENTED · TESTED)

`REQUESTED → VALIDATING → PAYMENT_PENDING → PARTIALLY_PAID → PAID` (o `REJECTED` / `CANCELLED` antes de recibir).

1. **Solicitud** (los tres roles): presentador, jugador opcional (activo), valor presentado y sesión de origen **solo con evidencia** (informativa).
2. **Validación** (PARTNER/SUPERADMIN): valor aceptado ≤ presentado y ≤ circulación global; conteo opcional por denominación que debe sumar lo aceptado (retorno actual; no se atribuye a compras). Aceptado $0 ⇒ `REJECTED`.
3. **Recepción física + firma** (los tres roles): en UNA transacción, entrada nominal única (clave `redemption-receipt:<id>`), obligación `REDEMPTION`, evidencia firmada (`special_operation_evidence`) y comprobante PNG. No mueve dinero.
4. **Pagos**: efectivo desde la custodia administrativa del pagador o transferencia (en trámite → ejecutada con referencia). Nunca la caja de una sesión cerrada.

Un canje con fichas recibidas no se cancela ni se modifica (trigger `late_chip_redemptions_guard`).

## 3. 16.2 Reverso completo de compra confirmada (IMPLEMENTED · TESTED)

Clasificación (`planPurchaseReversal`): `CANCEL_PURCHASE` (borrador: se cancela en el Módulo 08), `FULL_REVERSAL`, `PHYSICAL_RETURN_PENDING`, `NOT_REVERSIBLE_AUTOMATICALLY` (transferencia o terminal pendiente, deuda sobreaplicada, participación ya liquidada, sesión en CLOSING) y `ALREADY_REVERSED`.

Efectos, en UNA transacción (orden de bloqueos: sesión FOR SHARE → compra → participación → jugador → solicitud → inventario → saldos):

1. **Devolución física del valor completo** (`CHIP_RETURN`, referencia `PurchaseReversal`). Sin ella: bloqueado y auditado `PURCHASE_REVERSAL_BLOCKED`. Se atribuye a la sesión solo si sigue OPEN.
2. **Extinción NO monetaria** del saldo de la deuda: aplicación `PURCHASE_REVERSAL` ligada al reverso (`payment_allocations.purchaseReversalId`). No es un pago; en los reportes del Módulo 14 aparece como «Extinción por reverso de compra».
3. **Reembolso** del dinero realmente pagado: efectivo, terminal aprobada, transferencias verificadas, abonos y compensaciones aplicados a esa deuda. Identidad verificada: extinción + reembolso = valor de la compra. Obligación `PURCHASE_REFUND`; se paga aparte (caja de la sesión si sigue OPEN, custodia o banco).
4. Compra → `REVERSED`; solicitud → `EXECUTED`; comprobante complementario.

Después, la deuda de esa compra queda cerrada: el trigger de `payment_allocations` rechaza nuevas aplicaciones y reversos, y el Módulo 10 rechaza revertir un abono aplicado a ella (su reembolso ya está en la obligación).

Escenario B (probado): compra $5,000 = $2,000 efectivo + $3,000 crédito → sin devolución física, bloqueado y sin movimientos; con devolución de $5,000: deuda $0 (extinción $3,000), reembolso pendiente $2,000, caja sin cambio hasta pagar.

## 4. 16.3 Corrección de liquidación con pagos reales (IMPLEMENTED · TESTED)

Requiere solicitud `SETTLEMENT_REVERSAL_WITH_PAYOUTS` aprobada y la **firma del jugador** sobre el resumen del servidor.

- **`OFFSET_REVERSAL`**: contraasientos de la compensación FIFO (`reverseSettlementOffsetsInTx`; las deudas recuperan su saldo) y una obligación `SETTLEMENT_ADJUSTMENT` por el mismo valor. El importe lo calcula el servidor. No entra ni sale efectivo. Una sola por liquidación (índice parcial).
- **`ADDITIONAL_PAYOUT`**: obligación nueva por la diferencia que el negocio debe.

La liquidación, su firma, sus pagos y su caja no se tocan. Una liquidación corregida ya no admite el reverso simple del Módulo 11.

Escenario C (probado): liquidación $8,000 (compensación $2,000, pago $6,000) → reverso de compensación: deuda $2,000 restablecida, $2,000 por pagar, cero asientos de efectivo.

**NOT_IMPLEMENTED**: reclamar al jugador dinero pagado de más (requeriría una cuenta por cobrar nueva con su propia decisión de negocio).

## 5. 16.4 Devolución de fondos no aplicados (IMPLEMENTED · TESTED)

`PENDING_REVIEW → PENDING_REFUND → PARTIALLY_REFUNDED → REFUNDED` (estado derivado). Con la solicitud `UNAPPLIED_FUNDS_RETURN` aprobada se registra la obligación `UNAPPLIED_REFUND` por **exactamente** el importe recibido; cada pago descarga `UNAPPLIED_PLAYER_FUNDS`.

Escenario D (probado): deuda $2,000 + transferencia $3,000 → excedente $1,000; devoluciones $600 (transferencia ejecutada) + $400 (efectivo de custodia) → `REFUNDED`, cuenta técnica en $0; un pago extra es rechazado por servicio y por trigger.

## 6. Pagos especiales (todas las obligaciones)

| Método        | Origen                                             | Efecto                                                                                                                      |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Efectivo      | Custodia administrativa del pagador                | Asiento inmediato `PLAYER_SETTLEMENT` (referencia `SpecialPayout`).                                                         |
| Efectivo      | Caja de la sesión de origen, **solo si está OPEN** | Igual; revalidado dentro de la transacción.                                                                                 |
| Transferencia | Banco                                              | `PENDING` (compromete, no paga) → `EXECUTED` con referencia → asiento `BANK_TRANSFER_PAYOUT`; `FAILED`/`CANCELLED` liberan. |

Cuenta que se descarga: `PLAYER_SETTLEMENTS` (canje, corrección), `PLAYER_PURCHASES` (reembolso), `UNAPPLIED_PLAYER_FUNDS` (devolución). No hay integración bancaria: el sistema nunca afirma que un banco pagó (el banco admite saldo negativo por diseño, igual que en el Módulo 11).

## 7. Modelos y garantías de base

`late_chip_redemptions`, `special_payables`, `special_payouts`, `purchase_reversals`, `settlement_corrections`, `special_operation_evidence`, `special_operation_receipts`; columna `payment_allocations.purchaseReversalId`; enums `LateRedemptionStatus`, `SpecialPayableKind/Status`, `SpecialPayoutStatus`, `SettlementCorrectionKind`; valores nuevos `FolioDocumentType` (REDEMPTION, PURCHASE_REVERSAL, SETTLEMENT_CORRECTION, SPECIAL_PAYOUT), `AllocationSource.PURCHASE_REVERSAL`, `StoredFilePurpose.SPECIAL_OPERATION_SIGNATURE`.

Triggers/CHECK: reversos, correcciones, evidencias y comprobantes de solo inserción; canjes sin DELETE y sin cambios tras recibir; obligaciones con importe/origen inmutables; pagos que nunca comprometen más que la obligación, inmutables una vez resueltos y EXECUTED ⇒ asiento; compra CONFIRMED → REVERSED solo con reverso; deuda de compra revertida cerrada.

## 8. Endpoints (`/api/special-operations`)

| Método   | Ruta                                                                                        | Permiso            |
| -------- | ------------------------------------------------------------------------------------------- | ------------------ |
| GET      | `/` (resumen), `/:id` (localizar)                                                           | `special-ops:read` |
| GET/POST | `/redemptions`                                                                              | read / operate     |
| GET      | `/redemptions/:id`                                                                          | read               |
| POST     | `/redemptions/:id/preview`                                                                  | read               |
| POST     | `/redemptions/:id/validate`                                                                 | **authorize**      |
| POST     | `/redemptions/:id/confirm-receipt`, `/cancel`, `/payout`                                    | operate            |
| GET      | `/payables/:id` · POST `/payables/:id/payouts`                                              | read / operate     |
| POST     | `/payouts/:id/resolve`                                                                      | operate            |
| GET      | `/purchase-reversals`, `/purchase-reversals/:purchaseId`, `/purchase-reversals/records/:id` | read               |
| POST     | `/purchase-reversals/:purchaseId/preview` · `/execute`                                      | read / operate     |
| GET      | `/settlement-corrections`, `/settlement-corrections/records/:id`                            | read               |
| POST     | `/settlement-corrections/:settlementId/preview` · `/execute`                                | read / operate     |
| GET      | `/unapplied-funds`, `/unapplied-funds/:id`                                                  | read               |
| POST     | `/unapplied-funds/:id/refunds`                                                              | operate            |
| GET      | `/receipts/:id/image` (PNG)                                                                 | read               |

Todos con `withApiHandler` (CSRF, mantenimiento 503), Zod `strictObject` (un campo no previsto = 400) y autorización en el servidor.

## 9. Pantallas (Mobile First)

`/dashboard/operaciones-especiales` (panel), `/canjes`, `/canjes/nuevo`, `/canjes/[id]`, `/reversos-compras`, `/reversos-compras/nuevo`, `/reversos-compras/[id]`, `/correcciones-liquidaciones`, `/correcciones-liquidaciones/nuevo`, `/correcciones-liquidaciones/[id]`, `/fondos-no-aplicados`, `/fondos-no-aplicados/[id]`. Firma en el celular del cajero (trazos; el servidor genera el PNG).

## 10. Permisos

| Permiso                                                       | SUPERADMIN | PARTNER | CASHIER |
| ------------------------------------------------------------- | :--------: | :-----: | :-----: |
| `special-ops:read`                                            |     ✅     |   ✅    |   ✅    |
| `special-ops:operate`                                         |     ✅     |   ✅    |   ✅    |
| `special-ops:authorize`                                       |     ✅     |   ✅    |    —    |
| `corrections:operate` (aprobar reverso/corrección/devolución) |     ✅     |   ✅    |    —    |

## 11. Auditoría

`LATE_REDEMPTION_REQUESTED/VALIDATED/REJECTED/CANCELLED/RECEIVED/PARTIALLY_PAID/PAID`, `PURCHASE_REVERSAL_REQUESTED/APPROVED/EXECUTED/BLOCKED`, `SETTLEMENT_CORRECTION_REQUESTED/APPROVED/EXECUTED`, `UNAPPLIED_FUNDS_RECORDED/REFUND_REGISTERED/PARTIALLY_REFUNDED/REFUNDED`, `SPECIAL_PAYOUT_REGISTERED/EXECUTED/FAILED/CANCELLED`, `SPECIAL_EVIDENCE_CAPTURED`, `SPECIAL_OPERATION_FAILED`. Módulo de auditoría `SPECIAL_OPERATIONS`. Los eventos de éxito se registran en la misma transacción; los rechazos, fuera de ella con `result = FAILURE`.

## 12. Integración

- **Módulo 15**: tipos de corrección con servicio de ejecución en Operaciones especiales; `requireApprovedCorrectionInTx` + `linkExecutionInTx`; 7 comprobaciones de integridad nuevas (`SPECIAL_PAYOUT_LEDGER`, `SPECIAL_PAYABLE_STATE`, `REDEMPTION_ENTRY_ONCE`, `PURCHASE_REVERSAL_CONSISTENT`, `SETTLEMENT_CORRECTION_CONSISTENT`, `UNAPPLIED_REFUND_WITHIN`, `SPECIAL_PAYABLES_PENDING_INFO`).
- **Módulo 14**: clase `EXTINCTION` en créditos; compras REVERSED cuentan como entrega histórica (con marca `reversed`); obligaciones especiales en la posición financiera.
- **Módulos 10/11/12**: bloqueos coherentes (abono sobre deuda de compra revertida; reverso simple de liquidación corregida); contrato `assessLateRedemption` apunta a este módulo.

## 13. Pruebas

- Unitarias: `src/modules/special-operations/module16.test.ts` (48).
- Integración (PostgreSQL 16 en Docker): `tests/integration/special-operations.int.test.ts` — escenarios A–D, idempotencia, triggers, permisos por endpoint, integridad limpia tras cada escenario y detección de una inconsistencia inyectada.
- E2E: `tests/e2e/special-operations.spec.ts` (Chrome + iPhone).

## 14. Limitaciones

- Reclamar dinero pagado de más a un jugador: **NOT_IMPLEMENTED**.
- Reverso de una compra cuya participación ya se liquidó: se bloquea y se dirige a 16.3 (no se reabre la liquidación).
- Sin integración bancaria (transferencias confirmadas manualmente).
- WhatsApp: ninguno (Módulo 13). Sin PDF.
