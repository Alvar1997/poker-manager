# Módulo 10 — Créditos, deudas, abonos y aplicación FIFO

> **Estado:** implementado (2026-10-24, fecha de la migración).

**Regla final:**

- **Origen:** la deuda nace cuando una compra con crédito se confirma con su entrega y su firma.
- **FIFO:** los abonos posteriores la reducen automáticamente, salvo los pagos ya vinculados a una compra específica, que se aplican a esa deuda.
- **Dónde se paga:** dentro o fuera de una sesión. Los pagos administrativos no reabren ni modifican cajas cerradas.
- **Sin excedentes:** no existen excedentes aplicables ni saldos a favor.
- **Comprobante:** cada abono confirmado produce uno digital, descargable en PNG y compartible manualmente.

Decisiones permanentes **DEC-01…23**: ver `docs/BUSINESS_RULES.md` § Créditos y abonos.

## 1. Origen de las obligaciones

La cuenta por cobrar es `PlayerDebt`, creada por el Módulo 08 en la misma transacción que confirma la entrega. Requiere:

- compra entregada, con saldo por cobrar mayor que cero;
- socio autorizador con medio VERBAL o MESSAGE;
- firma VALID de esa compra (Módulo 09).

Nunca nace de un borrador, de una firma sin entrega ni de una transferencia pendiente.

Es una por compra (`purchaseId` único). La porción cubierta por una transferencia pendiente forma parte de la misma deuda: no se crea una segunda obligación. No se duplicó el modelo: `PlayerDebt` **es** el `PlayerReceivable` del encargo.

## 2. Integración con compras

- **Saldo y listados:** el detalle y el listado de compras toman el saldo de la deuda del libro de aplicaciones. El contrato del M08 `listPlayerPurchaseDebts` también se deriva de él.
- **Auditoría:** al nacer la deuda se registra `RECEIVABLE_CREATED`.

## 3. Firma y autorización

Cada deuda conserva su compra, sesión, mesa, participación, socio y medio de autorización, y la firma (`signatureId` de la entrega). Son inmutables: un trigger del Módulo 08 lo garantiza.

## 4. Saldos derivados

`saldo = original − Σ aplicaciones + Σ reversos de aplicaciones` (libro `payment_allocations`).

- **Sin campos editables:** no existe `currentDebt` ni ningún saldo que se pueda editar.
- **Estados derivados:** `OPEN`, `PARTIALLY_PAID` y `PAID` (`receivableStatus`). `VOIDED` queda reservado para el reverso de una compra (Módulo 11).
- **Defensa en la base:** un trigger impide aplicar más que el original de la deuda o que el importe del abono, y que el saldo quede negativo.

## 5–7. Abonos parciales, generales y FIFO

`allocateFifoInTx` es el motor central; el cliente nunca envía la distribución. Funcionamiento:

1. Obtiene las deudas con saldo.
2. Las ordena por fecha de nacimiento, desempatando por id de forma estable.
3. Recorre en orden, aplicando a cada una como máximo su saldo, y se detiene al agotar el importe. La suma aplicada es exactamente el importe.
4. Registra cada aplicación con su orden (`allocationOrder`), dentro de la misma transacción.

Ejemplo probado: deudas A $1,000, B $2,000 y C $3,000; abono de $2,500 → A $1,000 y B $1,500. Quedan A $0, B $500, C $3,000; total $3,500.

Hay vista previa informativa (`GET /api/credits/players/:id/fifo-preview`); el servidor recalcula al confirmar. Se permiten abonos parciales y totales. Los mayores al saldo se rechazan con «El importe supera la deuda pendiente de $X.».

## 8. Pagos vinculados

Un pago de compra (efectivo, terminal o transferencia anunciada en la compra) nunca se redistribuye por FIFO ni cuenta como abono (probado). Si una transferencia anunciada en la compra se verifica **después** de entregar, se aplica a **su** deuda (`allocatePurchasePaymentInTx`, fuente `PURCHASE_PAYMENT`), sin FIFO.

## 9. Abonos administrativos

Se usa `origin = ADMINISTRATIVE` y `sessionId = null`. Se permiten aunque no exista una sesión abierta.

- **No tocan cajas de sesión:** nunca modifican la caja de una sesión cerrada ni crean sesiones ficticias. Probado: la caja cerrada conserva su saldo y sus movimientos.
- **Origen `SESSION`:** solo existe con una sesión OPEN, que elige el servidor (`lockOpenSession`); el cliente no puede elegir una sesión cerrada. Para pagar no se exige participación activa en una mesa.

## 10. Custodia de efectivo

El efectivo administrativo va a la cuenta `ADMIN_CASH_CUSTODY`, que lleva un alcance por custodio (`custodian:<userId>`). Es un libro de entradas y salidas sobre el registro del Módulo 05, no un saldo editable:

- **No es caja de juego:** no pertenece a ninguna mesa.
- **No se mezcla:** no se suma a la apertura de la sesión siguiente ni se usa para pagar jugadores.
- **No queda negativa:** la cuenta es no negativa (lo impide el libro), así que el mismo efectivo no se deposita dos veces (probado con dos depósitos simultáneos).

**Depósito al banco:** `POST /api/credits/administrative/custody/deposit` registra un traslado verificado (custodia − / banco +, `CASH_TRANSFER`). No es un abono nuevo ni un ingreso adicional.

Pantalla `/creditos/custodia`: saldo por custodio, depósitos y movimientos.

## 11. Caja central en cero

La caja de cada sesión sigue abriendo en $0; la custodia es una cuenta separada (probado). Si hay custodia pendiente, la preparación de la sesión muestra un aviso para **segregar** ese efectivo antes del arqueo de apertura.

## 12. Banco

Se reutiliza la verificación manual del Módulo 05; no hay otro flujo. `POST /api/credits/payments/:id/confirm` es un envoltorio del mismo servicio.

- **Pendiente:** la transferencia de un abono queda pendiente; no reduce la deuda ni aumenta el banco.
- **Verificada:** el banco aumenta una vez (asiento único) y se aplica por FIFO.
- **Rechazada:** el abono queda REJECTED.

## 13–15. Terminal de débito y crédito; cobros por liquidar

- **Solo aprobados:** `CARD_DEBIT` y `CARD_CREDIT` cuentan solo si están **aprobados**, con folio de la terminal y confirmación explícita. El rechazado queda registrado como REJECTED, sin efecto.
- **Contabilidad:** el aprobado va a `CARD_TERMINAL_CLEARING` («por liquidar»). No aumenta el efectivo y reduce la deuda.
- **Datos protegidos:** nunca se guardan número de tarjeta, CVV ni NIP.

## 16. Conciliación sin doble ingreso

El depósito de la terminal (Caja → Terminal) liquida ahora también los cobros de abonos. Mueve de «por liquidar» al banco **sin reconocer otra vez el pago**: la cuenta de cobros por abonos no cambia (probado). Cada cobro se liquida una sola vez y no se inventan comisiones.

## 17. Excedentes rechazados

No se acepta registrar un abono mayor que la deuda; no hay saldos a favor ni aplicación a compras futuras.

## 18. Pagos recibidos sin aplicación

Si una transferencia ya está en el banco y, al verificarla, la deuda estaba (total o parcialmente) cubierta por otro medio:

- se aplica lo aplicable;
- el excedente se acredita a `UNAPPLIED_PLAYER_FUNDS` y se registra en `UnappliedPlayerFunds` como `PENDING_RESOLUTION` (por devolver).

No se oculta ni se borra; la deuda nunca baja de cero y no es saldo utilizable. Aplica igual a las transferencias de compra. La **devolución** requiere un movimiento real auditado que aún no existe: queda pendiente.

## 19–21. Comprobantes, PNG y compartición

Cada abono CONFIRMED tiene su `ReceivablePaymentReceipt`, creado en la misma transacción. Es una fotografía histórica con huella:

- folio (`ABN-…`), fecha, jugador, método, importe e importe sin aplicar;
- origen y sesión, referencia financiera y quién confirmó;
- aplicaciones FIFO con el saldo restante de cada deuda y la deuda total restante.

Abonos posteriores no lo cambian (probado). El PNG lo genera el mismo motor del Módulo 09 (`renderDocumentPng`). Se puede compartir con el menú nativo o descargando la imagen, o copiar el texto; no hay PDF, enlaces públicos ni envíos.

## 22. Reversos

`POST /api/credits/payments/:id/reverse`, con motivo y la declaración de que el dinero se devolvió:

- contraasiento del dinero real: `REVERSAL` con `reversesTransactionId` único;
- contraasientos de **todas** sus aplicaciones (`kind = REVERSAL`, con la aplicación original enlazada de forma única);
- el abono queda REVERSED y su comprobante ANULADO.

Nada se borra.

**Política determinista:** se restaura exactamente lo que aplicó ese abono a cada deuda. Las aplicaciones posteriores de otros abonos no se re-ejecutan ni se mueven (probado).

**Restricciones:**

- **Efectivo de sesión:** solo con _esa_ sesión abierta.
- **Efectivo administrativo:** solo si el custodio aún lo tiene.
- **Terminal:** solo si no se ha liquidado.
- **Transferencia o fondos no aplicados:** requieren una devolución bancaria real (pendiente).

## 23. Auditoría

- Deudas: `RECEIVABLE_CREATED`, `RECEIVABLE_PARTIALLY_PAID` y `RECEIVABLE_PAID`.
- Abonos: `PAYMENT_REGISTERED`, `PAYMENT_CONFIRMED`, `PAYMENT_REJECTED`, `PAYMENT_ALLOCATED` (con distribución y saldos antes y después) y `PAYMENT_REVERSED` (con motivo y lo restaurado).
- Efectivo y terminal: `ADMINISTRATIVE_CASH_RECEIVED`, `ADMINISTRATIVE_CASH_DEPOSITED`, `TERMINAL_PAYMENT_APPROVED` y `TERMINAL_PAYMENT_SETTLED`.
- Fondos y comprobantes: `UNAPPLIED_FUNDS_RECORDED`, `RECEIPT_CREATED`, `RECEIPT_DOWNLOADED` y `RECEIPT_SHARED_MANUALLY_REQUESTED`.

Todos se registran en la misma transacción que el movimiento que describen, sin datos bancarios ni de tarjeta.

## 24. Concurrencia

Hay **serialización por jugador**: el renglón del jugador se bloquea (`FOR UPDATE`) en todo abono, verificación de transferencia, compensación y reverso, en el orden sesión → compra → jugador → transferencia → saldos financieros. Además, la base impide sobreaplicar (trigger).

Probado:

- dos abonos simultáneos que juntos exceden la deuda: uno pasa y el otro se rechaza;
- un abono y una compensación con fichas simultáneos: solo uno aplica;
- dos depósitos simultáneos de la misma custodia: solo uno pasa;
- confirmar dos veces la misma transferencia: un solo ingreso;
- una transferencia que llega cuando la deuda ya está cubierta: se registra como fondos no aplicados.

## 25. Idempotencia

Hay claves únicas en abonos, reversos, depósitos de custodia y asientos; un reintento devuelve el mismo resultado (probado con dos solicitudes simultáneas con la misma clave). Además:

- un asiento por abono (`one_per_origin`);
- un comprobante por abono;
- un reverso por abono;
- una liquidación por cobro de terminal.

## 26. Endpoints

| Método y ruta                                                                                        | Permiso                  |                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| `GET /api/credits`                                                                                   | `credits:read`           | Deudas con saldo y estado derivados               |
| `GET /api/credits/summary`                                                                           | `credits:read`           | Tablero                                           |
| `GET /api/credits/players` · `/players/:id` · `/players/:id/statement` · `/players/:id/fifo-preview` | `credits:read`           | Deudores, resumen, estado de cuenta, vista previa |
| `GET /api/credits/:id` · `/:id/history`                                                              | `credits:read`           | Deuda y aplicaciones                              |
| `GET/POST /api/credits/payments`                                                                     | read / `credits:operate` | Abonos                                            |
| `GET /api/credits/payments/:id`                                                                      | `credits:read`           | Detalle                                           |
| `POST /api/credits/payments/:id/confirm`                                                             | `cash:operate`           | Verificar transferencia (servicio del Módulo 05)  |
| `POST /api/credits/payments/:id/reverse`                                                             | `credits:operate`        | Reverso                                           |
| `GET /api/credits/payments/:id/receipt` · `/receipt/image` · `POST /receipt/share-events`            | `credits:read`           | Comprobante, PNG, compartir                       |
| `GET /api/credits/administrative` · `/administrative/custody` · `/custody/movements`                 | `credits:read`           | Abonos administrativos y custodia                 |
| `POST /api/credits/administrative/custody/deposit`                                                   | `cash:operate`           | Depósito de custodia                              |

## 27. Modelos

- **Reutilizados:** `PlayerDebt` (cuenta por cobrar), el libro del Módulo 05 (sin libro paralelo), `BankTransferVerification` y `CardTerminalSettlement`.
- **Nuevos:** `ReceivablePayment`, `PaymentAllocation`, `ReceivablePaymentReversal` (el ajuste o reverso), `UnappliedPlayerFunds`, `AdministrativeCashDeposit` y `ReceivablePaymentReceipt`.
- **Valores de enum nuevos:** `ADMIN_CASH_CUSTODY` y `UNAPPLIED_PLAYER_FUNDS` (tipos de cuenta), y el alcance `CUSTODIAN`.
- **Migraciones** (aditivas; no crean abonos ni modifican deudas):
  - `20261024120000_module10_enums`;
  - `20261024130000_module10_credits`, con CHECKs, el trigger de sobreaplicación, inmutabilidad y transiciones.

## 28. Pruebas

- **Unitarias** (`src/modules/credits/credit.test.ts`, 15):
  - FIFO del ejemplo, empate, parcial y total;
  - rechazo de excedentes y de importes inválidos;
  - saldo con reversos y estados derivados;
  - división de lo aplicable y el excedente;
  - schemas (sin distribución, sesión ni custodio del cliente; terminal; datos de tarjeta);
  - comprobante, que nunca menciona PDF ni saldo a favor;
  - permisos.
- **Integración** (`tests/integration/credits.int.test.ts`, 19, PostgreSQL real, deudas creadas por el flujo completo de compra + firma + entrega):
  - una sola deuda y origen conservado tras cambiar de mesa y cerrar la sesión;
  - FIFO con efectivo de sesión, excedentes, pagos de compra sin FIFO e idempotencia;
  - concurrencia de abonos, y de abono contra compensación;
  - transferencias pendientes, verificadas, excedentes, de compra y rechazadas;
  - terminal y su liquidación sin doble ingreso;
  - abono administrativo sin tocar la caja cerrada, custodia y depósito, sesión nueva en $0 y depósitos concurrentes;
  - reversos, comprobante inmutable con PNG y triggers;
  - estado de cuenta, permisos, auditoría, sin inventarios ni cajas nuevas.
- **E2E** (`tests/e2e/credits.spec.ts`, Chrome + iPhone):
  - deudores, estado de cuenta, abono parcial en efectivo con vista previa FIFO, comprobante y PNG;
  - transferencia pendiente y luego verificada;
  - cierre de sesión de **prueba**, abono administrativo sin tocar la caja cerrada, custodia y depósito sin doble ingreso;
  - excedente rechazado (interfaz y API 422), 401 y diseño móvil.

## 29. Integración futura con el Módulo 11

`applyChipSettlementOffsetInTx(tx, actorId, { playerId, settlementId, amount })` compensa con el **mismo** motor FIFO (fuente `CHIP_SETTLEMENT_OFFSET`). No crea efectivo ni banco y se serializa con los abonos (probado).

**Implementado en el Módulo 11:** la compensación es **opcional** (el cajero decide no compensar, parcial o máximo) y solo se llama por el importe decidido; `settlementId` ahora tiene FK a `player_settlements` y un trigger impide compensar más que lo devuelto; `reverseSettlementOffsetsInTx` revierte exactamente las compensaciones de una liquidación. La custodia administrativa también financia pagos administrativos de liquidaciones tras el cierre (y acepta aportaciones documentadas). Ver `docs/MODULE_11_SETTLEMENTS.md`.

Sigue pendiente:

- (Módulo 16, implementado) extinción del saldo de la deuda por reverso de su compra (aplicación `PURCHASE_REVERSAL`, sin dinero) y devolución de fondos no aplicados (obligación `UNAPPLIED_REFUND` + pagos reales). Ver `docs/MODULE_16_SPECIAL_OPERATIONS.md`.

El cierre real de sesión existe desde el Módulo 12 (`docs/MODULE_12_CLOSURE.md`): las deudas sobreviven con su saldo derivado, el cierre nunca cobra ni compensa, y los abonos posteriores son ADMINISTRATIVOS (custodia o banco) sin tocar la caja cerrada (probado). Durante `CLOSING` no hay sesión OPEN: un abono en efectivo se registra como administrativo. Las pruebas de este módulo conservan su cierre de prueba.

## Nota del Módulo 14 — reportes de créditos

Los reportes (`docs/MODULE_14_REPORTS.md`) leen `player_debts` y `payment_allocations` sin escribir nada y desglosan la deuda en tres niveles: jugador → **sesión de origen** (`PlayerDebt.sessionId`) → compra/recompra → aplicaciones. Clasifican cada aplicación por su `source`/`kind`: abono FIFO (`RECEIVABLE_PAYMENT`), pago vinculado a la compra (`PURCHASE_PAYMENT`), compensación con fichas (`CHIP_SETTLEMENT_OFFSET`) y reverso (`REVERSAL`), con la misma fórmula de saldo (`appliedNet`) y el mismo estado derivado (`receivableStatus`). La fecha real de cada aplicación se muestra aparte de la fecha de origen; un abono repartido entre varias deudas se suma una sola vez. Nuevos índices de lectura: `player_debts(createdAt)`, `player_debts(tableId)`, `receivable_payments(sessionId)` y `payment_allocations(source, allocatedAt)`.

## Integración con el Módulo 16

- Nueva fuente de aplicación `PURCHASE_REVERSAL` (enlazada a `purchase_reversals` por `purchaseReversalId`): extingue el saldo de una deuda cuya compra se revirtió con devolución física. No es pago ni dinero.
- La deuda de una compra revertida queda CERRADA: el trigger rechaza aplicaciones y reversos nuevos, y `reversePaymentAllocationsInTx` rechaza revertir un abono aplicado a ella (su reembolso ya forma parte de la obligación del reverso).
- Fondos no aplicados: siguen en `UNAPPLIED_PLAYER_FUNDS` hasta que una devolución autorizada los paga; su estado (PENDING_REVIEW / PENDING_REFUND / PARTIALLY_REFUNDED / REFUNDED) se deriva de la obligación y sus pagos.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

La mesa muestra, al tocar al jugador, su deuda global y la originada en la sesión actual (derivadas del libro de aplicaciones) y un indicador de crédito pendiente en el asiento. No crea ni modifica deudas.
