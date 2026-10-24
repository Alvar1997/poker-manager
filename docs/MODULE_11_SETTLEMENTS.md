# Módulo 11 — Liquidaciones de jugadores

> **Estado:** implementado (migraciones `20261025120000_module11_enums` y `20261025130000_module11_settlements`).

Código: `src/modules/settlements/` · API: `src/app/api/settlements/` · Pantallas: `src/app/(dashboard)/dashboard/liquidaciones/`.

**Regla final:**

- **Firma siempre:** toda liquidación requiere la firma del jugador, incluso si devuelve $0 en fichas.
- **Compensación opcional:** el cajero decide explícitamente si compensa deuda (no compensar, parcial o máximo). Si compensa, la distribución es el **FIFO automático** del Módulo 10 y no es editable.
- **Fichas por valor nominal:** la devolución incrementa el inventario compartido **una sola vez**, sin denominaciones.
- **Pago total, parcial o pendiente:** en efectivo, por transferencia o ambos. No se debita dinero que todavía no se entregó.
- **Obligaciones que sobreviven al cierre:** se pagan después con movimientos administrativos reales, sin reabrir cajas cerradas.

Decisiones LIQ-DEC-01…20 del encargo: todas implementadas (ver la tabla de la sección 32).

## 1. Flujo

1. Desde **Mesa → Jugadores** («Liquidar jugador») o desde `/liquidaciones/nueva`, sobre la participación **ACTIVE final** del jugador. Si se transfirió de mesa, se liquida en la mesa actual aunque haya comprado en otra; sus compras conservan su mesa original.
2. El cajero captura el **valor nominal devuelto** (puede ser $0).
3. Se muestran las deudas vigentes del jugador (Módulo 10): todas las sesiones y mesas, con antigüedad, aplicaciones previas y socio autorizador.
4. El cajero elige **explícitamente** la decisión de compensación.
5. Vista previa FIFO (informativa).
6. Pago neto.
7. El servidor prepara el resumen y el jugador **firma** en el celular del cajero.
8. El cajero **confirma la recepción física** de las fichas.
9. Pagos: inmediatos (efectivo en la misma confirmación) o posteriores (efectivo y/o transferencia), o se dejan pendientes.
10. Comprobante digital de recepción y anexos por cada pago posterior.

Crear el borrador (`DRAFT`) **no tiene efectos**: no toca inventario, deudas ni dinero, y no cierra la participación. Se rechaza si la sesión o la mesa no están abiertas, si la participación no está ACTIVE, si ya hay otra liquidación viva de esa participación (índice único parcial) o si el jugador tiene compras sin entregar (`DRAFT`/`READY_FOR_DELIVERY`).

No se exige que el jugador no tenga deudas, ni que haya comprado en esa mesa, ni una devolución positiva.

## 2. Devolución nominal

- Se captura solo `returnedNominalAmount`. No existen campos de denominaciones, cantidades ni combinaciones: un campo así se rechaza con 400 (`z.strictObject`).
- Al confirmar la recepción, si es mayor que cero, se llama a `confirmNominalChipReturnInTx` (Módulo 04): circulación − y custodia +.
  - Usa la clave idempotente `settlement-return-<id>` (una por liquidación) y la referencia `PlayerSettlement`.
  - Guarda mesa, sesión y jugador como trazabilidad.
- Nunca excede las fichas en circulación (se valida al crear y la base lo vuelve a impedir).
- La composición por denominación se verifica en los arqueos; tras la devolución, `breakdownExact = false` hasta el siguiente arqueo.

## 3. Devolución de $0

- No se crea ningún movimiento nominal de valor cero.
  - CHECK `chipReturnOperationId IS NOT NULL ⇔ returnedNominalAmount > 0`.
- La firma sigue siendo obligatoria.
- Con $0 no se puede compensar (CHECK y validación).
- Sin deuda por pagar, la liquidación termina COMPLETED y la participación queda SETTLED.

## 4. Firma obligatoria

Se usa la infraestructura del Módulo 09:

- **Trazos:** el navegador envía trazos y el PNG se genera en el servidor.
- **Almacenamiento:** privado (`StoredFile` con propósito `SETTLEMENT_SIGNATURE` y `settlementId`).
- **Snapshot:** canónico con huella y declaración versionada.

Tablas propias:

- **`SettlementSignatureSnapshot`:** el documento exacto, con `content` canónico, `contentHash`, `materialHash` y `payloadHash`.
- **`SettlementSignature`:** una por snapshot y una sola VALID por liquidación (índice parcial).
  - Las firmas de compras **no** sirven para liquidaciones, ni las de otra liquidación: lo impiden el trigger y el CHECK de la recepción.

Declaración `2026-10-liq-v1` (`settlement.declaration.ts`):

> «Reconozco que la presente liquidación corresponde al valor nominal de fichas indicado. He revisado la compensación de deudas señalada, si aplica, y el importe que me corresponde recibir. Entiendo que los pagos pendientes se registrarán y se cubrirán posteriormente.»

La firma no recibe fichas, no compensa deuda ni mueve dinero, y tampoco implica que todo el dinero se pagó. Es evidencia operativa de aceptación: no es firma electrónica avanzada ni verificación biométrica.

## 5. Snapshot firmado

Contenido, siempre generado por el servidor:

- **Identificación:** folio, versión, jugador, sesión, mesa final y participación.
- **Importes:** valor devuelto y saldo de deuda consultado.
- **Compensación:** decisión, importe y distribución FIFO prevista (por cada deuda, el importe y el saldo antes y después).
- **Pago:** deuda restante, neto, pagos confirmados antes de la recepción (siempre $0) y pendiente previsto.
- **Declaración:** texto y versión.
- **Fecha:** de preparación.

La **parte material** (`materialOf`) es lo que se compromete y se vuelve a comparar al recibir. Incluye:

- importe, decisión y compensación;
- distribución por deuda y neto;
- versión de la liquidación y versión de la declaración.

Cambios materiales **antes** de recibir: la firma queda INVALIDATED (se conserva con motivo y responsable), la versión sube y se exige firmar de nuevo (`bumpSettlementVersionInTx`). Ocurre al cambiar el importe, la decisión o el importe parcial, o porque cambió la distribución FIFO.

Los pagos posteriores **no** invalidan la firma: generan movimientos y comprobantes complementarios.

## 6–10. Compensación opcional

| Decisión        | Compensación                                        |
| --------------- | --------------------------------------------------- |
| `NO_COMPENSATE` | $0 aunque haya deuda; el jugador la conserva        |
| `PARTIAL`       | el importe que indica el cajero                     |
| `MAXIMUM`       | `min(fichas devueltas, deuda pendiente)` (servidor) |

**Restricciones:** compensación ≥ 0, ≤ fichas y ≤ deuda. No se compensa con $0 devueltos ni sin deuda. Solo `PARTIAL` lleva importe. Se aplican en `settlement.math.ts`, en schemas, en CHECKs y en un trigger sobre `payment_allocations`.

La decisión se **guarda siempre**, también `NO_COMPENSATE`: decisión, importe pedido, cajero, fecha (auditoría `SETTLEMENT_OFFSET_DECIDED`) y deudas efectivamente compensadas.

**FIFO:**

- Se reutiliza `allocateFifo`/`applyChipSettlementOffsetInTx` del Módulo 10 (fuente `CHIP_SETTLEMENT_OFFSET`, con FK a la liquidación): de la deuda más antigua a la más reciente, sin exceder ningún saldo.
- El cliente nunca envía la distribución.
- Ejemplo probado: A $1,000, B $2,000, C $3,000; compensación $2,500 → A $1,000, B $1,500, C $0.

**Revalidación:** el plan se recalcula **dentro** de la transacción de recepción, con el jugador bloqueado. Se bloquea con 409 y se exige un nuevo resumen y una nueva firma si:

- cambió la distribución firmada (p. ej. un abono entre la firma y la recepción);
- lo decidido ya no es posible (la compensación excede la deuda actual).

Con `NO_COMPENSATE`, un cambio de deuda no altera lo firmado y la recepción procede.

La compensación **no** genera movimientos de efectivo, banco ni terminal.

## 11–12. Deuda restante y pago neto

`netPayoutAmount = returnedNominalAmount − offsetAmount`; deuda restante = deuda − compensación. Se guardan al confirmar (`debtBalanceSnapshot`, `offsetAmount`, `netPayoutAmount`), con CHECKs de coherencia, y son inmutables (trigger).

Las dos relaciones financieras no se fusionan:

- **`PlayerDebt`** (lo que el jugador debe, Módulo 10).
- **`SettlementPayable`** (lo que se le debe pagar).

## 13. Cuenta por pagar

`SettlementPayable` se crea al recibir las fichas, una por liquidación, por el neto. Puede ser de $0; en ese caso nace PAID, sin movimiento ficticio.

- **Saldo pendiente:** `original − Σ desembolsos EXECUTED`, derivado y nunca editable.
- **Estado:** `OPEN`/`PARTIALLY_PAID`/`PAID`/`VOIDED`. Es una proyección mantenida en la misma transacción; el trigger impide cambiar el importe o el origen.

## 14–18. Pagos

**Desembolso (`SettlementPayout`):** tiene secuencia, importe, método, origen del dinero (`funding`) y estado. Cuando se ejecuta, guarda el asiento único (`financialTransactionId`).

**Efectivo (`CASH`):** se entrega y se contabiliza en el momento, como `EXECUTED`, con `PLAYER_SETTLEMENTS` DEBIT y el efectivo como CREDIT.

- **Sesión OPEN o CLOSING:** sale de la caja de **su** sesión (`SESSION_CASH`).
- **Sesión cerrada:** sale de la **custodia administrativa** de quien paga (`ADMIN_CUSTODY`). Nunca de la caja cerrada ni de otra sesión.
- **Sin saldos negativos:** el libro del Módulo 05 no deja negativo el efectivo ni la custodia (se informa el faltante).
- **Fondear la custodia:** si no alcanza, un socio puede entregar efectivo real al custodio. Es una aportación documentada (`POST /api/credits/administrative/custody/contributions`, `AdministrativeCashContribution`: OWNER_CONTRIBUTIONS → custodia). No crea efectivo ficticio ni se suma a la apertura de ninguna sesión.

**Transferencia (`BANK_TRANSFER`):**

- **PENDING:** reserva el importe y **no** cuenta como pagada; usa la cuenta bancaria principal como origen.
- **EXECUTED:** después de verificar en el banco (referencia obligatoria y fecha real ≤ ahora). Genera `BANK_TRANSFER_PAYOUT`: `PLAYER_SETTLEMENTS` DEBIT y `BANK` CREDIT.
- **FAILED/CANCELLED:** con motivo; liberan la reserva.
- No hay integración bancaria ni se guardan credenciales.

**Límite:** un pago nuevo nunca excede `pendiente − reservado` (`assertPayoutFits`). Lo garantizan la cuenta por pagar bloqueada con `FOR UPDATE` y un trigger que suma PENDING + EXECUTED.

**Pagos mixtos y parciales:** efectivo, transferencias o ambos, en cualquier número de desembolsos.

- **Ejemplo:** neto $8,000 = $3,000 en efectivo + $2,000 en transferencia ejecutada + $3,000 pendiente.
- **Liquidación terminada:** al cubrirse por completo, la liquidación queda COMPLETED y la participación, SETTLED.

## 19. Estados de liquidación

Las transiciones las controla un trigger:

- `DRAFT` → `READY_FOR_CONFIRMATION` (firma VALID) | `CANCELLED`.
- `READY_FOR_CONFIRMATION` → `DRAFT` (cambio material) | `PENDING_PAYOUT` | `COMPLETED` | `CANCELLED`.
- `PENDING_PAYOUT` → `COMPLETED` | `REVERSED`.
- `COMPLETED` → `REVERSED`.
- `CANCELLED` y `REVERSED` son inmutables.

Una vez recibidas las fichas, lo firmado y acordado no se edita. Historial en `settlement_status_history` (solo inserción).

## 20–21. Participación SETTLING / SETTLED

Valor nuevo del enum: `ParticipationStatus.SETTLING`.

**`ACTIVE → SETTLING`** (`markParticipationSettlingInTx`, verificador real `settlementVerifier`): fichas recibidas, firma y obligación registradas, pago pendiente.

- Tiene salida registrada (`leftAt`): **no ocupa silla** y la mesa puede cerrar.
- No admite compras: `validateParticipationForPurchase` exige ACTIVE.
- No admite transferencias.

**`ACTIVE`/`SETTLING → SETTLED`** (`completeParticipationFromSettlementInTx`): cuando la liquidación queda pagada (o revertida).

**Durante una liquidación en curso** (DRAFT/READY), la participación sigue ACTIVE, pero no admite compras ni cambio de mesa (`activeSettlementOf`).

**Política de reingreso:** un jugador con una participación SETTLING en la sesión no puede volver a quedar ACTIVE hasta terminar de pagarle.

- La regla vive en el servicio, que bloquea al jugador, y en un trigger.
- En otra sesión no aplica.
- Después de SETTLED puede volver con otra participación.

## 22. Cierre de mesa

La mesa puede cerrarse sin jugadores ACTIVE, aunque tenga participaciones SETTLING. Las liquidaciones en curso mantienen ACTIVE la participación, por lo que **bloquean** el cierre.

Cerrar la mesa no elimina ni completa obligaciones ni toca la caja.

## 23. Cierre de sesión (contratos para el Módulo 12)

- **`getSessionSettlementOverview(db, sessionId)`:** liquidaciones en curso, que bloquean (devoluciones físicas sin confirmar), y el número de las pendientes de pago, que **no** bloquean.
- **`assertNoSettlementsInProgress(db, sessionId)`:** lanza si hay devoluciones sin confirmar.
- **`listPendingPayables({ sessionId?, playerId? })`:** para el reporte de cierre. Incluye total pendiente, jugadores afectados, pendiente por jugador, folios, fechas, pagos realizados y en trámite.
- **`GET /api/sessions/:id/settlements`:** lista, resumen y obligaciones pendientes.

Probado primero con un cierre de **prueba**, y desde el Módulo 12 con el cierre real (`tests/integration/closure.int.test.ts`):

- las obligaciones sobreviven al cierre;
- se pagan después, desde la custodia o por banco;
- la caja de la sesión cerrada no cambia.

## 24–25. Comprobantes y PNG

`SettlementReceipt`, snapshot inmutable con huella; trigger: solo AVAILABLE → VOIDED.

- **`RECEPTION`:** uno por liquidación, creado en la misma transacción que la recepción. Incluye:
  - folio, fecha, jugador, sesión y mesa final;
  - fichas devueltas, decisión, compensación y FIFO con saldos;
  - deuda restante y **pago neto acordado**;
  - **pagado al emitir**, transferencia en trámite (no pagada) y pendiente;
  - firma, cajero y estado.
- **`PAYOUT`:** anexo por cada desembolso ejecutado después. La recepción no se modifica.

El PNG lo genera el motor único del Módulo 09 (`renderDocumentPng`), con la firma en el de recepción. Se comparte manualmente: menú nativo, descarga o copiar el texto. Sin PDF, sin enlaces públicos y sin WhatsApp.

## 26. Auditoría

Eventos de la liquidación:

- `SETTLEMENT_CREATED` y `SETTLEMENT_UPDATED_DRAFT`;
- `SETTLEMENT_OFFSET_DECIDED` y `SETTLEMENT_SUMMARY_PREPARED`;
- `SETTLEMENT_SIGNATURE_CAPTURED`, `SETTLEMENT_SIGNATURE_REJECTED`, `SETTLEMENT_SIGNATURE_INVALIDATED` y `SETTLEMENT_SIGNATURE_EVIDENCE_VIEWED`;
- `SETTLEMENT_CHIPS_RECEIVED`, `SETTLEMENT_DEBT_OFFSET_APPLIED` y `SETTLEMENT_PAYABLE_CREATED`;
- `SETTLEMENT_PAYOUT_REGISTERED`, `SETTLEMENT_PAYOUT_CONFIRMED` y `SETTLEMENT_PAYOUT_FAILED`;
- `SETTLEMENT_COMPLETED`, `SETTLEMENT_CANCELLED` y `SETTLEMENT_REVERSED`;
- `SETTLEMENT_RECEIPT_CREATED`.

Otros eventos relacionados:

- `TABLE_PARTICIPATION_SETTLING` y `TABLE_PARTICIPATION_SETTLED`;
- `ADMINISTRATIVE_CASH_CONTRIBUTED`;
- los asientos del Módulo 05 (`CASH_SETTLEMENT_PAID`) y del 04 (`CHIP_RETURN_RECORDED`);
- `PAYMENT_ALLOCATED` y `RECEIVABLE_*` del Módulo 10.

Cada evento registra actor, jugador, sesión, mesa, participación, importes, estados anterior y nuevo, referencias y motivo. Todo se audita en la misma transacción. Las huellas van como `…Digest` y no se guardan imágenes en la auditoría (probado).

## 27–28. Concurrencia e idempotencia

**Orden de bloqueos:** sesión (`FOR SHARE`) → liquidación → mesa → participación → jugador → inventario compartido → cuenta por pagar → desembolso → saldos. Es compatible con compras (sesión → compra → mesa → participación → inventario) y abonos (sesión → jugador → saldos). Alta de jugador: sesión → mesa → jugador.

**Probado con PostgreSQL real:**

- dos cajeros liquidando al mismo jugador;
- confirmaciones dobles, secuenciales y simultáneas, con la misma clave o con distintas;
- dos pagos simultáneos que exceden la obligación;
- reintentos de pago con la misma clave;
- pago y reverso simultáneos;
- cancelación y confirmación simultáneas;
- deudas que cambian entre la firma y la recepción;
- compra y transferencia de mesa durante una liquidación;
- reingreso con pago pendiente.

**Claves únicas** en creación, recepción (`confirmIdempotencyKey`), firma, desembolso, resolución y reverso. Además:

- un asiento por desembolso (`cash_transactions_one_per_origin`) y una entrada nominal por liquidación;
- una cuenta por pagar y un comprobante de recepción por liquidación, y un anexo por desembolso.

## 29. Reversos y correcciones

**Antes de recibir:** cancelar (motivo; la firma queda CANCELLED; sin efectos) o editar (invalida la firma).

**Después de recibir** no hay edición directa. `POST /api/settlements/:id/reverse` (motivo) procede **solo si**:

- la sesión sigue abierta;
- **no** hay pagos ejecutados ni transferencias en trámite;
- si se devolvieron fichas, el cajero declara que se las **regresó físicamente** al jugador. Nunca vuelven a circulación fichas que siguen bajo custodia.

**Efectos**, con contraasientos y sin borrar nada:

- reversos exactos de las compensaciones (`reverseSettlementOffsetsInTx`): la deuda vuelve;
- las fichas vuelven a circulación (reserva y entrega nominal);
- la cuenta por pagar queda VOIDED y los comprobantes, ANULADOS;
- la liquidación queda REVERSED y la participación SETTLING pasa a SETTLED;
- si el jugador sigue jugando, se registra de nuevo.

Con pagos reales se rechaza: requiere resolución administrativa documentada (no se inventan devoluciones de dinero).

## 30. Endpoints

| Método y ruta                                                                | Permiso               |
| ---------------------------------------------------------------------------- | --------------------- |
| `GET/POST /api/settlements`                                                  | read / operate        |
| `GET /api/settlements/preview` · `/context?participationId=`                 | `settlements:read`    |
| `GET /api/settlements/pending-payouts`                                       | `settlements:read`    |
| `GET /api/settlements/:id` · `/:id/preview` · `/:id/payouts`                 | `settlements:read`    |
| `PATCH /api/settlements/:id/draft` · `POST /:id/cancel`                      | `settlements:operate` |
| `GET/POST /api/settlements/:id/signature-summary`                            | read / operate        |
| `POST /api/settlements/:id/signatures` · `GET /:id/signatures/status`        | operate / read        |
| `GET /api/settlements/:id/signature-evidence`                                | `signatures:read`     |
| `POST /api/settlements/:id/confirm-return`                                   | `settlements:operate` |
| `POST /api/settlements/:id/payouts`                                          | `settlements:operate` |
| `POST /api/settlements/:id/payouts/:payoutId/confirm`                        | `cash:operate`        |
| `GET /api/settlements/:id/receipt` · `/receipt/image` · `POST /share-events` | `settlements:read`    |
| `POST /api/settlements/:id/reverse`                                          | `settlements:operate` |
| `GET /api/sessions/:id/settlements` · `GET /api/players/:id/settlements`     | `settlements:read`    |
| `POST /api/credits/administrative/custody/contributions`                     | `cash:operate`        |

SUPERADMIN, PARTNER y CASHIER tienen todos estos permisos. Todas las rutas autentican, autorizan, validan con Zod (`strictObject`) y usan servicios transaccionales. No hay endpoints para fijar estados arbitrarios.

Pantallas Mobile First:

- `/dashboard/liquidaciones` (lista por estado) y `/liquidaciones/nueva` (pasos 1–6).
- `/liquidaciones/[id]`, con detalle, corrección y cancelación.
- `/[id]/firma` (pasos 7–8), `/[id]/pagos` (paso 9) y `/[id]/comprobante` (paso 10).
- `/liquidaciones/pendientes`, con obligaciones y aportación a la custodia.
- El botón **«Liquidar jugador»** está en la pantalla de jugadores activos de la mesa; si hay una liquidación en curso, la abre.

## 31. Modelos

- **Nuevos:**
  - `PlayerSettlement` (con la recepción, la `SettlementChipReturn` del encargo vive aquí) y `SettlementStatusHistory`;
  - `SettlementSignatureSnapshot` y `SettlementSignature`;
  - `SettlementPayable`, `SettlementPayout`, `SettlementReceipt` y `SettlementReversal`;
  - `AdministrativeCashContribution`.
- **Reutilizados:**
  - `PaymentAllocation` (compensaciones, ahora con FK `settlementId`), `StoredFile`/`EvidenceBlob` (con `settlementId`);
  - el libro del Módulo 05 (`PLAYER_SETTLEMENT`, `BANK_TRANSFER_PAYOUT`, `PLAYER_SETTLEMENTS`, `ADMIN_CASH_CUSTODY`);
  - el inventario nominal del Módulo 04 y `TableParticipation.settlementId` (ahora con FK).
- **Enums nuevos:** `PlayerSettlementStatus`, `SettlementOffsetDecision`, `SettlementSignatureStatus`, `SettlementPayableStatus`, `SettlementPayoutMethod`, `SettlementPayoutStatus`, `SettlementPayoutFunding` y `SettlementReceiptKind`. Valores nuevos: `ParticipationStatus.SETTLING` y `StoredFilePurpose.SETTLEMENT_SIGNATURE`.
- **Migraciones aditivas:** no crean liquidaciones, cuentas por pagar ni desembolsos históricos. No mueven compras ni modifican firmas o deudas. Las FK nuevas apuntan a columnas que estaban vacías.
- **Triggers** (inmutabilidad, transiciones, firma de la misma liquidación, tope de compensación por liquidación, tope de desembolsos por cuenta por pagar, comprobantes inmutables y política de reingreso):
  - `table_participations_guard` se reemplazó para admitir `SETTLING → SETTLED`;
  - `stored_files_guard` se reemplazó para admitir `settlementId`.

## 32. Pruebas

**Unitarias** (`src/modules/settlements/settlement.test.ts`):

- compensación nula, parcial y máxima, y el FIFO del ejemplo;
- rechazos (excede fichas o deuda, $0, sin deuda, importe en MAXIMUM);
- devolución de $0;
- cuenta por pagar: en trámite ≠ pagado, reserva, $0 pagado y excedentes;
- schemas: sin denominaciones, distribución, neto ni jugador, la decisión obligatoria, la recepción sin «firmado = true» y los pagos;
- declaración versionada y huella canónica;
- comprobante: acordado frente a pagado, sin PDF ni denominaciones, anexo;
- permisos.

**Integración** (`tests/integration/settlements.int.test.ts`, 30, PostgreSQL real; deudas creadas con el flujo completo de compra, firma y entrega):

- compras en ambas mesas, transferencia sin movimiento y liquidación en la mesa final;
- una entrada nominal aunque haya reintentos y concurrencia;
- límite de circulación;
- `NO_COMPENSATE`, parcial FIFO, máximo y neto $0;
- rechazos y 400 por campos no permitidos;
- firma obligatoria, no reutilizable y sin efectos;
- invalidación por importe y por decisión;
- deuda que cambia entre la firma y la recepción;
- liquidación de $0;
- pago parcial con SETTLING, sin compras, transferencias ni reingreso, y luego SETTLED;
- caja insuficiente;
- transferencias PENDING, EXECUTED y FAILED, y pago mixto;
- pagos concurrentes y reintentos, con el trigger;
- cierre de mesa con SETTLING;
- cierre de sesión con pago posterior desde la custodia y el banco, sin tocar la caja cerrada;
- deuda de una sesión anterior compensada en la siguiente;
- comprobantes inmutables con anexo y PNG;
- reversos (sin pagos; bloqueado con pagos; concurrente con un pago);
- concurrencia de inicio y de cancelación con confirmación;
- permisos, 401/403/422 y auditoría.

**E2E** (`tests/e2e/settlements.spec.ts`, Chrome + iPhone):

- compras reales y «Liquidar jugador» desde la mesa;
- `NO_COMPENSATE` con firma táctil y recepción con pago parcial en efectivo, SETTLING sin compras;
- transferencia en trámite y ejecutada hasta COMPLETED/SETTLED;
- comprobante con anexo y PNG;
- compensación parcial FIFO;
- liquidación de $0 con firma obligatoria (422 sin firma) y sin movimiento nominal;
- listado, pagos pendientes, diseño móvil y 401 sin sesión.

**Ajustes en pruebas previas:**

- `session-tables` y `credits` usan liquidaciones reales: había IDs ficticios que la FK nueva ya no admite.
- `cash-box` prueba el contrato nuevo por desembolso.
- `configuration` reconoce las tablas del Módulo 11.

| Decisión del encargo                                                                           | Dónde se implementa            |
| ---------------------------------------------------------------------------------------------- | ------------------------------ |
| LIQ-DEC-01/02: firma siempre, también con $0                                                   | §4, recepción sin firma → 422  |
| LIQ-DEC-03: recepción con pago pendiente                                                       | §13, PENDING_PAYOUT y SETTLING |
| LIQ-DEC-04/05/06: efectivo, transferencia y mixtos                                             | §14–18                         |
| LIQ-DEC-07/08/09/10: compensación opcional (no, parcial o máxima) con FIFO no editable         | §6–10                          |
| LIQ-DEC-11/12/13: la compensación no es dinero; entrada nominal única, sin denominaciones      | §2, §6–10                      |
| LIQ-DEC-14/15/16: transferencia pagada solo al ejecutarse; sin caja negativa; sin pagar de más | §14–18                         |
| LIQ-DEC-17/18/19: comprobante digital, PNG y compartición manual, sin PDF                      | §24–25                         |
| LIQ-DEC-20: pagos después del cierre sin reabrir cajas                                         | §14–18, §23                    |

## Pendiente (fuera de este módulo)

- **Cierre real de sesión (Módulo 12, implementado):** el cierre bloquea con liquidaciones sin recepción, deja pasar las pendientes de pago como advertencia, las muestra en `/cierre/pendientes` (`listPendingPayables`) y en el comprobante; durante `CLOSING` no se paga en efectivo de la caja de la sesión (`CLOSING_CASH_PAYOUT_MESSAGE`); después del cierre se paga desde custodia o banco.
- **Reverso completo de compras, devolución de fondos no aplicados y corrección de liquidaciones con pagos reales:** implementados en el Módulo 16 (`docs/MODULE_16_SPECIAL_OPERATIONS.md`). La corrección crea efectos nuevos (contraasientos de compensación y obligaciones) sin tocar la liquidación; una liquidación corregida ya no admite el reverso simple de este módulo. Reclamar al jugador dinero pagado de más sigue sin implementar.

## Nota del Módulo 14 — reportes de liquidaciones

`/dashboard/reportes/liquidaciones` (ver `docs/MODULE_14_REPORTS.md`) muestra devolución nominal, decisión y monto de compensación, pago neto, efectivo entregado, transferencias ejecutadas y **pendientes (no descuentan la obligación)**, obligación pendiente y fechas, aunque la sesión esté CLOSED. Las compensaciones se listan con las deudas y sesiones de origen afectadas y el saldo antes/después; no son abonos de efectivo ni ingresos bancarios, y cuentas por cobrar y por pagar nunca se netean en los reportes. Nuevo índice de lectura `player_settlements(cycleId)`.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

La liquidación desde el asiento reutiliza `SettlementAmountsForm` (`onCreated`), `SettlementSignatureCapture` y `ConfirmReturnForm` (`onDone`). `markParticipationSettlingInTx` y `completeParticipationFromSettlementInTx` liberan el asiento (`SETTLEMENT`) en su transacción. Los jugadores SETTLING aparecen bajo la mesa como «falta pagarles».

## Integración con el Módulo 17

Módulo 17: una jugada financiada no se liquida con este módulo (se rechaza con mensaje neutro); su devolución física se concilia en la sección privada con la misma entrada nominal del inventario, sin pagar el valor devuelto.

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
