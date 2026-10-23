# Módulo 08 — Compras y recompras de fichas

> **Estado:** implementado (2026-10-22, fecha de la migración). Desde el Módulo 09 (2026-10-23) las entregas **con crédito** están habilitadas con la firma real del jugador; ver `docs/MODULE_09_SIGNATURES_RECEIPTS.md`.

**Regla final:** una compra empieza por el IMPORTE. El cajero no captura denominaciones. El sistema valida y descuenta el VALOR NOMINAL del inventario único compartido. El jugador paga en efectivo, transferencia, terminal de débito, terminal de crédito o con crédito. Los pagos pendientes no cuentan como recibidos. Todo crédito identifica al socio que lo autorizó (verbal o por mensaje) y toda entrega con crédito requiere firma auténtica. Las compras totalmente pagadas no requieren firma.

## 1. Compras por importe

El cajero captura **solo el importe** (p. ej. $5,000). El servidor deriva sesión, mesa, ciclo, jugador, folio (`CMP-…`) y responsable desde la **participación ACTIVE** elegida (`POST /api/purchases` solo acepta `participationId`, `nominalAmount`, `notes`, `idempotencyKey`; `z.strictObject` rechaza cualquier otro campo con 400).

## 2. Inventario nominal

Se usan los servicios del Módulo 04: `getAvailableNominalValue`, `validateNominalAvailability` (lectura), `reserveNominalAmountInTx`, `releaseNominalReservationInTx` y `confirmNominalChipDeliveryInTx`. El borrador **no** descuenta; la entrega confirmada registra **un** movimiento nominal `CHIP_DELIVERY` (custodia −, circulación +) con mesa, sesión, jugador y referencia `ChipPurchase`. Las compras de 25/25 y 10/10 consumen el mismo saldo. La base impide saldos negativos.

## 3. Ausencia de captura por denominaciones

Ningún schema, endpoint ni pantalla pide denominaciones, cantidades o combinaciones. No existe `ChipPurchaseDetail`; no se generan movimientos por denominación (`chip_inventory_movements`) en compras. Tras una entrega, la composición del inventario queda «no exacta» hasta el siguiente arqueo (Módulo 04 §22). No había compras históricas con desglose que conservar.

## 4. Compra inicial y recompras

La primera compra **confirmada** del jugador en la sesión es `INITIAL_PURCHASE`; las siguientes, `REBUY` con `rebuyNumber` 1, 2, 3… Las compras guardan su mesa, ciclo y participación originales: transferir al jugador no las modifica.

## 5. Numeración de recompras

Por `(sessionId, playerId)`, asignada **al confirmar** (los borradores cancelados no consumen números) dentro de la transacción de entrega, serializada por el bloqueo `FOR UPDATE` de la participación ACTIVE (solo hay una por jugador y sesión) y respaldada por el índice único `chip_purchases_sequence_per_player` y el CHECK `chip_purchases_numbering_valid`. No se reinicia al cambiar de mesa (probado: inicial y recompra 1 en 10/10, recompra 2 en 25/25).

## 6. Pagos mixtos

Una compra admite varios componentes (`PurchasePayment`). Relación (Decimal, nunca Float):

```
confirmedPayments = efectivo recibido + transferencias VERIFICADAS + débito APROBADO + crédito de terminal APROBADO
outstanding       = importe − confirmedPayments  (nunca negativo)
```

Ejemplo probado: $5,000 = efectivo $1,000 + débito aprobado $2,000 + transferencia pendiente $1,000 + crédito $1,000 → pagos confirmados $3,000, por cobrar $2,000 (la transferencia pendiente forma parte del saldo; no se crea otra deuda). Los componentes vivos no pueden exceder el importe (no hay cambio ni excedentes en este módulo). El crédito **no** es un método de pago: es el saldo por cobrar.

## 7. Efectivo

El cajero declara que lo recibió (`cashReceived: true`). Se contabiliza **al confirmar la entrega**, en la misma transacción: `PURCHASE_PAYMENT` DEBIT `CASH_ON_HAND` (scope = sesión) / CREDIT `PLAYER_PURCHASES`, referencia `PurchasePayment` (único por componente: índice `cash_transactions_one_per_origin`), con mesa y jugador. No toca el banco. Antes de entregar, retirar un efectivo exige declarar que se **devolvió** (`cashReturned: true`).

## 8. Transferencias

Al registrarla se crea una `BankTransferVerification` **PENDIENTE** del Módulo 05 (referencia `PurchasePayment`): no aumenta el banco ni reduce el saldo por cobrar. Solo cuenta cuando SUPERADMIN, PARTNER o CASHIER la **verifica manualmente** en Caja → Transferencias: el asiento `BANK_TRANSFER_RECEIPT` se crea una vez (Módulo 05) y el saldo por cobrar se deriva de nuevo sobre la **misma** obligación. Integración (`purchase-transfer-hook.ts`, import dinámico desde el Módulo 05): la compra se bloquea antes que la transferencia; si con ese importe los pagos superan la compra (p. ej. el jugador ya pagó por otra vía) se responde 409 **«Sobreaplicación»** y se exige tratamiento explícito del excedente; en un borrador, verificar o rechazar es un cambio material (nueva versión). Retirar una transferencia pendiente la cancela en caja; una ya verificada no se descarta.

## 9. Terminal de débito · 10. Terminal de crédito

Métodos `CARD_DEBIT` y `CARD_CREDIT` (catálogo de métodos de pago, Módulo 02). Estados: `PENDING` (en proceso) → `APPROVED` | `DECLINED`; `APPROVED` → `VOIDED` (anulado en la terminal, antes de entregar). **Solo `APPROVED` cuenta.** Aprobar exige folio/autorización de la terminal **y** la confirmación operativa explícita `approvalConfirmed: true`; un rechazado no puede volverse aprobado. Datos: importe, tipo, estado, folio, identificador de terminal (opcional, texto libre: aún no hay catálogo de terminales), usuario, fecha, compra y asiento. **Nunca** número de tarjeta, CVV, NIP ni banda: el schema rechaza referencias con 13–19 dígitos seguidos y cualquier campo extra.

## 11. Cobros aprobados pendientes de liquidación bancaria

Cuenta nueva `CARD_TERMINAL_CLEARING` («Cobros con terminal por liquidar», dinero, global, no negativa). Al entregar: DEBIT `CARD_TERMINAL_CLEARING` / CREDIT `PLAYER_PURCHASES`. **No aumenta el efectivo** ni el banco. Se muestra en Caja («Terminal por liquidar»).

## 12. Conciliación sin doble ingreso

`POST /api/cash-box/card-settlements` (pantalla Caja → Terminal) registra el depósito del adquirente ligando los cobros originales: `CARD_TERMINAL_SETTLEMENT` DEBIT `BANK` / CREDIT `CARD_TERMINAL_CLEARING`. **No reconoce la venta otra vez** (`PLAYER_PURCHASES` no cambia). Cada cobro se liquida una sola vez (bloqueo `FOR UPDATE`, `updateMany … cardSettlementId IS NULL`, trigger). **Comisiones:** no hay porcentajes configurados y no se inventan; si el depósito es menor que el bruto, la nota es obligatoria y la diferencia queda en «por liquidar» como `DIFFERENCE_PENDING` (pendiente de un mecanismo de conciliación de comisiones). Nunca se registra como gasto ni sale del efectivo.

## 13. Crédito

Sin límite (ni por jugador ni global), total o parcial. Al entregar con saldo por cobrar se crea un `PlayerDebt` (inmutable) con compra, jugador, sesión, mesa de origen, importe original, autorización (socio, medio, capturista) y fecha. El saldo vigente se **deriva** (importe − pagos confirmados posteriores); nunca hay un campo editable. Contrato para el Módulo 10: `listPlayerPurchaseDebts(playerId)` (ordenadas por antigüedad, base del FIFO).

## 14. Socio autorizador · 15. Autorización verbal o por mensaje

`POST /api/purchases/:id/credit-authorization` con `partnerId`, `channel` (`VERBAL` | `MESSAGE`) y notas opcionales. Reglas AUTH-01…10: obligatorio si `outstanding > 0`; rechazado si no hay saldo; solo usuarios **activos con rol PARTNER** (ni CASHIER ni SUPERADMIN); guarda `recordedById`/`recordedAt` del servidor, el `partnerNameSnapshot` histórico, y el importe autorizado lo **calcula el servidor**. Es un registro operativo: el socio no recibe nada ni aprueba en línea. Cambiar socio, importe o pagos crea otra versión: la autorización anterior queda `SUPERSEDED` (índice: una sola `ACTIVE` y una sola `USED` por compra; trigger: solo cambia el estado). La de una compra confirmada no se edita.

## 16. Firma condicional

Obligatoria si hay **cualquier** saldo por cobrar, aunque sea parcial; no se pide en compras totalmente pagadas. La firma se liga a la **versión** de la compra y a la **huella** (`summaryHash`, SHA-256) del resumen firmable: compra, folio, jugador, mesa, importe, pagos confirmados, transferencias pendientes, crédito, socio y medio, fecha y versión (`GET /api/purchases/:id/summary`). Cualquier cambio material cambia versión y huella e invalida la firma anterior. El Módulo 08 consulta `PurchaseSignatureVerifier.findValidSignature(tx, {purchaseId, playerId, summaryVersion, summaryHash})`; desde el Módulo 09 el verificador por defecto es el real (`moduleSignatureVerifier`: firma VALID, snapshot vigente, huellas, numeración firmada e integridad de la imagen; ver `docs/MODULE_09_SIGNATURES_RECEIPTS.md`). `unavailableSignatureVerifier` se conserva solo para pruebas. No existe `hasSignature` enviado por el navegador. La base lo vuelve a exigir: `purchase_deliveries_credit_requires_signature` (con saldo por cobrar, `signatureId` NOT NULL) y `signatureId` único (no se reutiliza).

## 17. Entrega física

Estados almacenados: `DRAFT` → `READY_FOR_DELIVERY` (importe apartado) → `CONFIRMED`; `DRAFT/READY` → `CANCELLED`; `REVERSED` reservado. Los pasos pendientes se **derivan** como bloqueos (no booleanos): `PENDING_CARD_PAYMENT`, `OVER_APPLIED`, `CREDIT_AUTHORIZATION_REQUIRED`, `CREDIT_SIGNATURE_REQUIRED`, `PARTICIPATION_NOT_ACTIVE`. Confirmar exige `physicalDeliveryConfirmed: true` y la `expectedVersion` que el cajero revisó (si cambió, 409).

## 18. Reserva nominal

`POST /api/purchases/:id/prepare-delivery` aparta el importe (`reserved +=`, vence en 15 min). Cambiar el importe o cancelar libera la reserva. Al confirmar se consume la reserva vigente o, si no la hay o venció, se reserva y consume en la misma transacción.

## 19. Confirmación transaccional

`POST /api/purchases/:id/confirm-delivery`, una transacción con bloqueos en orden fijo (sesión `FOR SHARE` → compra → mesa → participación → inventario compartido → saldos financieros pre-bloqueados con `lockAccountsInTx`): revalida sesión OPEN, mesa OPEN en el mismo ciclo, participación ACTIVE del mismo jugador y jugador activo → calcula pagos y saldo → socio y firma si hay crédito → numeración → salida nominal (una vez) → asientos de efectivo y terminal → `PurchaseDelivery` → `PlayerDebt` + autorización `USED` + evento outbox → `CONFIRMED` → historial y auditoría. Si algo falla, no queda nada a medias (probado provocando un choque de índice único después de mover inventario y contabilizar). Si el jugador se transfirió mientras la compra estaba en preparación, se rechaza: la compra conserva su mesa y debe cancelarse y registrarse en la mesa actual.

## 20. Reversos

Antes de confirmar: **cancelar** libera la reserva y cancela transferencias pendientes; si hay efectivo recibido o tarjeta aprobada/en proceso, primero hay que devolverlos/anularlos (auditado); una transferencia ya verificada bloquea la cancelación (requiere resolución financiera explícita). Después de confirmar: la compra es **inmutable** (trigger `chip_purchases_guard`). `POST /api/purchases/:id/reversal-request` registra una **solicitud** justificada y auditada, sin mover fichas ni dinero; la ejecución exige devolución física real, reembolsos, y verificar abonos y liquidaciones: **pendiente de los Módulos 10 y 11** (estado `REVERSED` reservado, inalcanzable hoy).

## 21. Auditoría

`PURCHASE_DRAFT_CREATED`, `PURCHASE_DRAFT_UPDATED`, `PURCHASE_PAYMENT_RECORDED`, `PURCHASE_PAYMENT_RESOLVED`, `PURCHASE_PAYMENT_CANCELLED`, `PURCHASE_CREDIT_AUTH_RECORDED`, `PURCHASE_DELIVERY_PREPARED`, `PURCHASE_CONFIRMED`, `PURCHASE_CANCELLED`, `PURCHASE_REVERSAL_REQUESTED`, `PURCHASE_TRANSFER_APPLIED`, `PURCHASE_CREDIT_EVENT_QUEUED`, `PLAYER_DEBT_CREATED`, `CARD_TERMINAL_SETTLED`, además de los asientos de caja (`CASH_PLAYER_PAYMENT_RECORDED`) e inventario (`CHIP_RESERVATION_*`). Nota: las claves de metadata no usan la palabra «authorization» porque el saneador de auditoría la filtra como secreto. Historial de estados en `purchase_status_history` (solo inserción).

## 22. Idempotencia

Claves únicas en compra, pago, autorización, entrega (`PurchaseDelivery.idempotencyKey`), reserva, operación de inventario, asiento y depósito de terminal. Los reintentos (también simultáneos) devuelven el resultado original; la misma clave con datos distintos responde 409. Probado: dos confirmaciones simultáneas con la misma clave → una entrega; dos de distintas compras con 50,000 disponibles y 30,000 cada una → una entra y la otra falla sin dejar nada; dos del mismo jugador → números 1 y 2.

## 23. WhatsApp futuro

Solo una compra **confirmada con crédito** inserta un evento `PURCHASE_CREDIT_CONFIRMED` en `notification_outbox` (estado `PENDING`, `dedupeKey` único: los reintentos no duplican), en la misma transacción. El payload no lleva teléfonos, tokens ni secretos. **Este módulo no envía nada.** El Módulo 13 deberá verificar consentimiento vigente (`getConsentStatus`), canal configurado, elegibilidad y políticas del proveedor; un fallo de notificación nunca revierte la compra.

## 24. Endpoints

| Método y ruta                                             | Permiso               | Descripción                                                                                                |
| --------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/purchases`                                      | `purchases:read`      | Historial con filtros: sesión, mesa, jugador, tipo, estado, fechas, cajero, socio, método, con/sin crédito |
| `POST /api/purchases`                                     | `purchases:create`    | Borrador por importe                                                                                       |
| `GET /api/purchases/:id`                                  | `purchases:read`      | Detalle con saldos derivados y bloqueos                                                                    |
| `PATCH /api/purchases/:id/draft`                          | `purchases:create`    | Importe/notas (con `expectedVersion`)                                                                      |
| `POST /api/purchases/:id/cancel`                          | `purchases:create`    | Cancelar borrador                                                                                          |
| `GET /api/purchases/:id/summary`                          | `purchases:read`      | Resumen firmable, versión y huella                                                                         |
| `GET/POST /api/purchases/:id/payments`                    | read / create         | Componentes de pago                                                                                        |
| `POST /api/purchases/:id/payments/:paymentId/card-result` | `purchases:create`    | Aprobado / rechazado / anulado                                                                             |
| `POST /api/purchases/:id/payments/:paymentId/cancel`      | `purchases:create`    | Retirar efectivo devuelto o transferencia pendiente                                                        |
| `POST /api/purchases/:id/credit-authorization`            | `purchases:create`    | Socio autorizador                                                                                          |
| `POST /api/purchases/:id/prepare-delivery`                | `purchases:create`    | Reserva nominal                                                                                            |
| `POST /api/purchases/:id/confirm-delivery`                | `purchases:create`    | Entrega transaccional                                                                                      |
| `GET /api/purchases/:id/history`                          | `purchases:read`      | Estados y eventos auditados                                                                                |
| `POST /api/purchases/:id/reversal-request`                | `purchases:create`    | Solicitud de reverso                                                                                       |
| `GET /api/purchases/authorizers`                          | `purchases:create`    | Socios activos                                                                                             |
| `GET /api/purchases/availability`                         | `purchases:read`      | Valor nominal disponible                                                                                   |
| `GET /api/sessions/:id/purchases`                         | `purchases:read`      | Compras de la sesión                                                                                       |
| `GET /api/sessions/:id/tables/:tableId/purchases`         | `purchases:read`      | Compras de la mesa                                                                                         |
| `GET /api/players/:id/purchases`                          | `purchases:read`      | Compras del jugador                                                                                        |
| `GET /api/cash-box/card-payments`                         | `cash:read`           | Cobros de terminal por liquidar                                                                            |
| `GET/POST /api/cash-box/card-settlements`                 | read / `cash:operate` | Depósitos de terminal                                                                                      |

La verificación de transferencias usa los endpoints existentes del Módulo 05. No hay endpoint genérico de cambio de estado. Ningún endpoint acepta fechas, responsables, estados, numeración ni importes autorizados del cliente.

## 25. Modelos

`ChipPurchase`, `PurchasePayment`, `PurchaseCreditAuthorization`, `PurchaseDelivery`, `PurchaseStatusHistory`, `PurchaseReversalRequest`, `PlayerDebt` (mínimo para el Módulo 10), `NotificationOutbox` (genérico para el Módulo 13), `CardTerminalSettlement`. Enums nuevos: `ChipPurchaseStatus`, `ChipPurchaseType`, `PurchasePaymentStatus`, `CreditAuthorizationChannel`, `CreditAuthorizationStatus`, `PurchaseReversalStatus`, `NotificationEventType`, `NotificationOutboxStatus`, `CardSettlementStatus`; valores nuevos `PaymentMethodCode.CARD_DEBIT/CARD_CREDIT`, `FinancialAccountKind.CARD_TERMINAL_CLEARING`, `CashTransactionType.CARD_TERMINAL_SETTLEMENT`. Se reutilizan el libro, las transferencias y las cuentas del Módulo 05 (no hay otro libro financiero).

**Migraciones** (aditivas, sin tocar datos): `20261022120000_module08_payment_enums` (valores de enum, aparte porque PostgreSQL no permite usarlos en la misma transacción) y `20261022130000_module08_purchases` (tablas, CHECKs, índices parciales y triggers de inmutabilidad). El seed agrega de forma idempotente los métodos de tarjeta y la cuenta «por liquidar».

## 26. Pantallas

`/dashboard/compras` (historial con filtros), `/dashboard/compras/nueva` (elegir jugador activo o, con `?participationId`, contexto precargado + importe), `/dashboard/compras/[id]` (pasos: 1 jugador y mesa · 2 importe · 3 pagos · 4 crédito y socio · 5 firma · 6 confirmación de entrega; cancelar; solicitar reverso), `/dashboard/sesiones/[id]/mesas/[tableId]/compras`, `/dashboard/jugadores/[id]/compras`, `/dashboard/caja/terminal`. Botón **«Nueva compra»** en cada jugador de la pantalla de participantes de la mesa. Atajo `/compras/*`. Mobile First: campo de importe grande con teclado decimal, botones de 44 px, sin scroll horizontal (verificado en iPhone 14), modo oscuro con los tokens del tema, protección contra doble clic (`isPending` + clave de idempotencia), éxito solo tras la respuesta del servidor. Ningún campo de denominaciones.

## 27. Pruebas

- **Unitarias** (`src/modules/purchases/purchase.test.ts`, 33): importe sin denominaciones, numeración (inicial, recompras, tras cambio de mesa), efectivo, transferencia verificada, débito y crédito de terminal, pago mixto del ejemplo, transferencia pendiente sin doble deuda, crédito total y parcial, rechazados/anulados, aplicación posterior, excedentes, sobreaplicación, decimales exactos, bloqueos (socio y firma solo con crédito), datos de tarjeta prohibidos, medio de autorización obligatorio, huella de firma invalidada por cambio material, verificador sin firma, permisos y reglas fijas.
- **Integración** (`tests/integration/purchases.int.test.ts`, 32, PostgreSQL 16 real): ver §2–§23; incluye concurrencia (inventario compartido, mismo jugador, reintentos simultáneos), atomicidad ante fallo, inmutabilidad en la base, auditoría, filtros y API (401, 400 por denominaciones o datos de tarjeta, importe autorizado no aceptado del cliente). Desde el Módulo 09, el flujo con crédito usa la **firma real** (resumen preparado + trazos capturados); solo la prueba de atomicidad usa un verificador defectuoso a propósito.
- **E2E** (`tests/e2e/purchases.spec.ts`, Chrome + iPhone): compra de $5,000 sin campos de denominaciones pagada en efectivo y entregada sin firma; recompra parcial a crédito con socio VERBAL, firma obligatoria y entrega bloqueada (UI y API 422); cambio de mesa con numeración continua y tarjeta aprobada que no aumenta el efectivo; depósito de terminal; transferencia pendiente como importe por cobrar; historial con filtros; 401/400. La entrega con firma real dibujada en el canvas se prueba en `tests/e2e/signatures.spec.ts` (Módulo 09).

## 28. Dependencias

- **Módulo 09 (firmas y comprobantes):** entregado (2026-10-23). Cada entrega confirmada crea además su comprobante digital.
- **Módulo 10 (créditos):** entregado (2026-10-24). El saldo de la deuda se deriva del libro de aplicaciones; una transferencia de la compra verificada después de entregar se aplica a su deuda y el excedente queda como fondos no aplicados (ver `docs/MODULE_10_CREDITS.md`).
- **Módulo 11 (liquidaciones, implementado):** no se crean ni confirman compras de una participación con liquidación en curso o SETTLING (`validateParticipationForPurchase`), y no se liquida con compras sin entregar. Las compras conservan su mesa original aunque la liquidación sea en la mesa final. La ejecución de reversos de compras está implementada en el Módulo 16 (`docs/MODULE_16_SPECIAL_OPERATIONS.md` §3): exige solicitud aprobada y devolución física completa; la compra solo pasa a REVERSED con su reverso registrado.
- **Módulo 12 (cierre, implementado):** las compras sin entrega resuelta (`DRAFT`/`READY_FOR_DELIVERY`, incluidas las que esperan firma) y las reservas activas BLOQUEAN el cierre de su mesa y de la sesión (se entregan o cancelan antes); las transferencias pendientes NO bloquean y conservan su estado real después del cierre (se verifican sin reabrir la caja). En `CLOSING` no se crean, pagan ni entregan compras.
- **Módulo 13 (WhatsApp):** procesar `notification_outbox` con consentimiento y canal configurado.
- Catálogo de terminales (identificador) y conciliación de comisiones de terminal: no existen todavía; no se inventan porcentajes.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

La compra rápida desde el asiento usa estos mismos endpoints (borrador → pagos → socio → firma → entrega). La numeración inicial/recompra sigue decidiéndose al confirmar; la mesa solo muestra la proyección. Los formularios `AddPaymentForm`, `CreditAuthorizationForm`, `ConfirmDeliveryForm` y `CancelPurchaseButton` aceptan un `onDone` opcional.
