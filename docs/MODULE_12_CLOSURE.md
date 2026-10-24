# Módulo 12 — Cierre de mesas, sesiones y conciliación final

> **Actualización (Módulo 18, decisión del propietario):** las diferencias de FICHAS (nominal de la sesión, que ahora incluye rake y propinas, y física del arqueo) ya no bloquean: se advierten y el cierre se confirma con motivo obligatorio, sin ajustes (`session_chip_differences`, arqueo `ACCEPTED_WITH_DIFFERENCE`). Los TRES roles confirman el cierre (`sessions:close-confirm`). Las diferencias de efectivo siguen bloqueando. Ver `docs/MODULE_18_RAKE_TIPS_RECONCILIATION.md`.

> **Estado:** implementado (migraciones `20261026120000_module12_enums` y `20261026130000_module12_closure`). **No aplicadas en Neon** (requiere autorización).

Código: `src/modules/closure/` · API: `src/app/api/sessions/[id]/closure/` · Pantallas: `src/app/(dashboard)/dashboard/sesiones/[id]/cierre/`.

**Regla final:**

- Una sola caja central y un solo inventario compartido. Cada mesa cierra su ciclo por separado; el arqueo final de fichas es **único y global**.
- La caja física termina **exactamente en $0.00**.
- Una diferencia física de arqueo **bloquea** el cierre hasta resolverla: recuento, regreso auditado a Abierta o ajuste excepcional autorizado.
- **Solo PARTNER o SUPERADMIN** confirman el cierre definitivo.
- Las deudas y las obligaciones de pago continúan después del cierre.

**Regla permanente:** «Las fichas que no regresan al cierre se muestran como valor nominal pendiente de retorno o en circulación. No constituyen automáticamente un faltante físico de arqueo ni utilidad definitiva y no se pagan sin una presentación y validación física posterior.»

Decisiones DEC-01…23 del encargo: todas implementadas (tabla de la sección 30).

## 1. Cierre de ciclos de mesa

- Reutiliza `closeSessionTable` (Módulo 07). El ciclo `OPEN` pasa a `CLOSED` (inmutable). No borra ciclos ni modifica compras.
- **Bloquea** con participaciones `ACTIVE`, compras del ciclo en `DRAFT`/`READY_FOR_DELIVERY` (incluye firmas pendientes) y liquidaciones del ciclo en `DRAFT`/`READY_FOR_CONFIRMATION`.
- **Permite** participaciones `SETTLING`: fichas recibidas y compensación aplicada, falta pagar; la obligación sobrevive.
- No exige arqueo físico. Las transferencias de mesa son atómicas (no hay transferencias «inconclusas»).
- Registra `TABLE_CYCLE_CLOSED` con mesa, ciclo, horas, operador y la actividad **atribuida** (`getCycleActivitySummary`): compras, recompras, devoluciones, jugadores que terminaron o se transfirieron, liquidaciones pagadas y por pagar.
- No es un resultado neto de la mesa: con transferencias, las fichas viajan con el jugador sin cuantificarse.

## 2–4. Cierre de sesión y estados

Estados existentes (`PokerSessionStatus`; «PREPARING» = `DRAFT`/`PREPARATION`):

```
DRAFT → PREPARATION → OPEN ⇄ CLOSING → CLOSED
   ↘ CANCELLED   ↘ CANCELLED
```

- **Nuevo:** `CLOSING → OPEN` (regreso auditado), en `session.state.ts` y en el trigger `poker_sessions_guard`.
- **Nunca:** `CLOSED → OPEN/CLOSING`, `CANCELLED → OPEN`, `OPEN → CLOSED` directo.
- `closedAt` solo existe en `CLOSED` (trigger).

**CLOSING bloquea** todo lo que toma la sesión `FOR SHARE` exigiendo `OPEN`:

- abrir ciclos de mesa y alta de jugadores;
- compras, recompras, pagos y entregas;
- transferencias entre mesas;
- liquidaciones nuevas, firmas y recepciones;
- pagos en efectivo de la caja de la sesión (`CLOSING_CASH_PAYOUT_MESSAGE`).

**CLOSING permite:**

- arqueos, conciliaciones y el retiro final;
- consultas y resolución de diferencias;
- la confirmación definitiva y el regreso a OPEN;
- verificar transferencias pendientes y registrar transferencias salientes: no tocan la caja.

Cada intento de cierre es un `SessionClosure` (`IN_PROGRESS → RETURNED_TO_OPEN | COMPLETED`). Índices únicos parciales: un intento en curso y un cierre completado por sesión.

## 5. Cierre sin actividad

- Clasificación derivada: **sin ningún ciclo de mesa** → `NO_ACTIVITY`.
- **Motivo obligatorio** al confirmar (servicio + CHECK en la base).
- El inventario se valida con el arqueo de apertura **si sigue vigente** (sin movimientos de fichas); si hubo movimientos, se exige el arqueo de cierre.
- El efectivo se cuenta igual. Las aportaciones o retiros reales se reconocen.
- Comprobante y auditoría distintos: `SESSION_CLOSED_WITHOUT_ACTIVITY`.
- Nunca se usa `CANCELLED` como sustituto ni se inventan mesas o movimientos.

## 6. Regreso CLOSING → OPEN

`POST …/closure/return-to-open { reason, forgottenOperationAt? }`, por cualquier rol que opera sesiones:

1. Transición `CLOSING → OPEN` con motivo, historial y auditoría (`SESSION_CLOSING_ABORTED`, `SESSION_RETURNED_TO_OPEN`).
2. El intento queda `RETURNED_TO_OPEN`, y con él quedan inválidos sus prevalidaciones y su resumen. El siguiente cierre es un intento nuevo con prevalidación, arqueos y resumen nuevos.
3. Los arqueos **confirmados** se conservan como evidencia. Sus diferencias pendientes quedan `SUPERSEDED` (sin ajuste), con la discrepancia resuelta como `RETURNED_TO_OPEN`. Los borradores se cancelan.
4. La hora **informada** de la operación olvidada (`forgottenOperationAt`) se guarda aparte; la hora de captura siempre es la real del servidor.
5. No reabre ciclos cerrados: para operar se abre una mesa, lo que crea un **ciclo nuevo** (Módulo 07).

## 7. Prevalidación

`computePrecheck` deriva todo de registros reales:

- **BLOCKING:**
  - sesión no operable;
  - mesas o ciclos abiertos;
  - participaciones `ACTIVE`;
  - compras sin entrega resuelta;
  - liquidaciones sin recepción;
  - reservas nominales activas;
  - arqueo de fichas en borrador ajeno al cierre;
  - diferencias de control sin conciliar (fichas o efectivo);
  - arqueo de efectivo en borrador;
  - inventario inconsistente con su libro.
- **WARNING:**
  - deudas pendientes y pagos pendientes a jugadores;
  - transferencias entrantes por verificar y salientes en trámite;
  - depósitos de efectivo en tránsito;
  - terminal por liquidar;
  - fondos sin aplicar;
  - fichas no retornadas.
- **INFO:**
  - circulación global y efectivo esperado;
  - último arqueo válido;
  - jugadores `SETTLING`;
  - sesión sin actividad.

Solo los BLOCKING impiden iniciar o confirmar. La prevalidación se repite **dentro** de las transacciones de inicio y de confirmación (`ClosurePrecheck` `START`/`CONFIRM`, inmutables).

## 8–9. Arqueo final único y conteo por denominación

- El motor es el del Módulo 04 (`ChipStockCount` `countType = CLOSING`, ligado a la sesión). Es uno para ambas mesas.
- Se captura **por denominación** (`quantityCounted`, valor y subtotal). La base rechaza negativos y fracciones. Solo cuenta denominaciones configuradas.
- Las compras y liquidaciones siguen siendo solo por importe.
- Lo prepara **cualquier rol** con `sessions:manage`: la regla del creador aplica solo a la apertura.
- Se confirma **solo** desde el cierre (`POST …/closure/inventory-count {action:"confirm"}`). El endpoint genérico rechaza los arqueos de cierre (`CLOSING_COUNT_VIA_CLOSURE_MESSAGE`).
- Confirmar exige que el inventario no haya cambiado desde el esperado (`inventoryVersion`).

## 10. Saldo nominal esperado

**Esperado bajo custodia** = custodia conciliada al abrir (arqueo de apertura) + entradas − salidas ± ajustes, todo desde el **libro real** `chip_nominal_movements` posterior a la apertura, de cualquier origen.

- Se muestra desglosado (entregas, devoluciones, ajustes, altas y bajas) y se verifica contra la proyección (`chip_set_inventory_states`).
- Nunca se suponen denominaciones entregadas.

## 11. Fichas pendientes de retorno vs diferencia física

Tres cifras que nunca se mezclan (`chipPosition`, `ChipFigures`):

| Cifra                            | Cálculo                                                    | ¿Bloquea?            |
| -------------------------------- | ---------------------------------------------------------- | -------------------- |
| **A. Diferencia física**         | contado − esperado bajo custodia                           | Sí, hasta resolverla |
| **B. No retornado en la sesión** | entregado − devuelto (cambios de circulación de la sesión) | No                   |
| **C. Circulación global**        | valor fuera de custodia de todas las sesiones              | No                   |

Ejemplo del encargo: entregados $65,000, devueltos $62,000, esperado $97,000 y contado $97,000. La diferencia física es $0, **conciliado**, aunque haya $3,000 en circulación.

B y C:

- no son faltante, efectivo, ingreso, utilidad, deuda ni pago (`recognizedAsIncome = 0`);
- tampoco crean cuentas por pagar.

La **atribución por jugador o mesa** es **informativa**: lo registrado a su nombre no prueba quién tiene las fichas.

## 12. Circulación global

- `getGlobalChipPosition` toma la proyección y la verifica contra la suma de los cambios del libro.
- Es **continua** entre sesiones: no se reinicia al cerrar ni se reconstruye sumando cierres.
- **Cambio en la apertura (Módulo 06):** la circulación de sesiones cerradas **ya no bloquea** abrir; se informa en el paso `NO_PENDING_CIRCULATION`. Antes bloqueaba, y como la circulación ahora persiste legítimamente, ninguna sesión podría volver a abrirse.
- Siguen bloqueando las reservas activas y la circulación por denominación del modelo anterior.

## 13. Diferencias y ajustes autorizados

`ClosureDiscrepancy` (fichas o efectivo) se registra en la misma transacción que confirma un arqueo de cierre con diferencia (`INVENTORY_DISCREPANCY_DETECTED` / `CASH_DISCREPANCY_DETECTED`).

Guarda:

- arqueo, esperado, contado y diferencia, que son **inmutables** (trigger);
- fecha y observaciones de investigación (`action: "note"`);
- resolución, responsable y fecha.

Resoluciones:

- **A. Recuento** (`RECOUNT`): un arqueo posterior confirmado. El original queda `SUPERSEDED`, conservado con su diferencia.
- **B. Regreso a OPEN** (`RETURNED_TO_OPEN`).
- **C. Ajuste excepcional** (`AUTHORIZED_ADJUSTMENT`): **solo PARTNER/SUPERADMIN**, validado en endpoint y servicio; un CASHIER recibe 403.
  - Usa la conciliación real del arqueo (fichas) o el ajuste del arqueo de efectivo (`RECONCILIATION_DIFFERENCES`).
  - Crea `ClosureAdjustmentAuthorization` (importe con signo, motivo, autorizador y referencia al movimiento), única por discrepancia.
  - La diferencia original no se oculta.

Si el inventario o el efectivo cambian después, el arqueo deja de estar vigente y se exige uno nuevo.

## 14. Arqueo de efectivo

- **Esperado** = entradas confirmadas − salidas confirmadas de `CASH_ON_HAND` de la sesión, desglosado por tipo (libro del Módulo 05).
- **No incluye:** transferencias pendientes, terminal, deudas, compensaciones, fichas ni pagos futuros.
- Se cuenta y confirma en una transacción (`recordClosingCashCountInTx`). Una diferencia exige explicación y queda pendiente: nunca se ajusta sola.
- El ajuste genérico rechaza arqueos de cierre (`CLOSING_CASH_VIA_CLOSURE_MESSAGE`).
- Un conteo idéntico sobre el mismo saldo devuelve el mismo arqueo.

## 15–17. Retiro final y receptor

- `POST …/closure/cash-withdrawal { amount, recipientName, recipientUserId?, notes?, physicallyDelivered: true }`. Usa `withdrawAllCashForClosingInTx`.
- El importe debe ser **exactamente** el disponible. Se rechaza si es menor (no deja $0), mayor o si la caja tiene diferencia pendiente o cambió después del arqueo.
- Es una salida real (`CASH_WITHDRAWAL` / `SESSION_CLOSING`), no un gasto. Es inmutable.
- `ClosureCashWithdrawal` guarda importe, operador, receptor, fecha del servidor, notas, asiento y arqueo. Es único por intento.
- El receptor **no inicia sesión ni firma**: no hay estado de aprobación del receptor. La evidencia es la declaración del operador.

## 18. Autorización PARTNER/SUPERADMIN

- **Permiso nuevo:** `sessions:close-authorize` (PARTNER, SUPERADMIN). CASHIER prepara (`sessions:manage`) pero no confirma.
- `POST …/closure/confirm { previewHash, noActivityReason?, idempotencyKey }`, en **una** transacción:
  1. bloquea sesión, inventario y caja;
  2. resincroniza discrepancias y aplica el motivo si es un cierre sin actividad;
  3. recalcula el resumen y exige que su **huella** coincida con la revisada. Si hubo movimientos relevantes después (transferencias verificadas, abonos, ajustes, inventario…), responde 409 y pide revisar de nuevo;
  4. verifica los requisitos (`evaluateReadiness`): mesas cerradas, sin bloqueos, arqueo de fichas vigente y sin diferencias, arqueo de efectivo sin diferencias y sin movimientos posteriores, retiro si había efectivo, caja en $0.00 y motivo si no hubo actividad;
  5. crea `ClosureApproval`, `ClosurePrecheck(CONFIRM)` y `ClosureReport` (folio `CIE-…`), marca el intento `COMPLETED` y pasa la sesión a `CLOSED` con hora del servidor.
- La pantalla no muestra la acción a un CASHIER y nunca declara éxito antes de la respuesta del servidor.

## 19–21. Obligaciones que sobreviven

- El cierre **no** cobra, no paga, no compensa y no crea pagos de $0.
- Deudas, abonos y transferencias pendientes, terminal por liquidar, transferencias salientes, cuentas por pagar, custodia administrativa y circulación quedan con su estado real.
- Después se resuelven con los flujos administrativos: custodia o banco (Módulos 10/11), verificación manual de transferencias, depósito de terminal.
- **Trigger nuevo** `cash_entries_closed_session_guard`: ninguna partida de `CASH_ON_HAND` puede ir a una sesión `CLOSED`/`CANCELLED`. Una caja cerrada nunca se reabre.

## 22–23. Reporte digital y PNG

- `ClosureReport` es un snapshot **inmutable** (trigger) con huella `contentHash`. Contiene:
  - folio, sesión y horas; preparó y confirmó;
  - mesas, ciclos y jugadores; compras y cobros por método; créditos y abonos;
  - liquidaciones pagadas y pendientes;
  - inventario esperado y contado, diferencia física y ajustes;
  - fichas no retornadas y circulación global;
  - efectivo: esperado, contado, diferencia, ajustes, retiro y receptor, caja final;
  - banco y terminal; deudas y obligaciones;
  - incidencias, intentos y regresos a Abierta;
  - motivo del cierre sin actividad.
- Los movimientos posteriores no lo cambian (probado).
- Pantalla `/cierre/comprobante`: ver, **descargar PNG** (motor único `renderDocumentPng`), compartir con el menú nativo y copiar el texto. Sin PDF, sin WhatsApp y sin enlaces públicos (`Cache-Control: private, no-store`).

## 24. Auditoría

- **Eventos:**
  - `TABLE_CYCLE_CLOSED`;
  - `SESSION_CLOSING_STARTED`, `SESSION_CLOSING_ABORTED` y `SESSION_RETURNED_TO_OPEN`;
  - `CLOSURE_PRECHECK_COMPLETED`;
  - `INVENTORY_FINAL_COUNT_RECORDED`, `INVENTORY_DISCREPANCY_DETECTED/RESOLVED` e `INVENTORY_ADJUSTMENT_AUTHORIZED`;
  - `OUTSTANDING_CHIP_VALUE_CALCULATED`;
  - `CASH_FINAL_COUNT_RECORDED`, `CASH_DISCREPANCY_DETECTED/RESOLVED`, `CASH_ADJUSTMENT_AUTHORIZED` y `CASH_WITHDRAWAL_CONFIRMED`;
  - `CLOSURE_DISCREPANCY_NOTED`;
  - `SESSION_CLOSURE_APPROVED`, `SESSION_CLOSED` y `SESSION_CLOSED_WITHOUT_ACTIVITY`;
  - `CLOSURE_REPORT_CREATED`, `CLOSURE_REPORT_DOWNLOADED` y `CLOSURE_REPORT_SHARED`.
- **Datos:** actor, sesión, mesa y ciclo, estados, importes, motivos, referencias, arqueo, receptor, autorizador y rol, y huellas como `…Digest`.
- Sin imágenes ni secretos. Todo se audita en la misma transacción.

## 25. Seguridad

- Autorización primero (401/403), Zod `strictObject` y rol leído de la base.
- El cliente no envía esperados, saldos, diferencias, estados, fechas reales ni autorizadores.
- Ningún rol modifica una sesión `CLOSED` (trigger), borra arqueos, retiros, discrepancias, aprobaciones o reportes (triggers de solo inserción o guardas), ni mueve una caja cerrada (trigger).
- Las fichas no retornadas nunca se convierten en utilidad o pagos.

## 26–27. Concurrencia e idempotencia

**Orden de bloqueos:** sesión (`FOR UPDATE` en el cierre; las operaciones la toman `FOR SHARE` y exigen OPEN) → inventario compartido → saldos. Es el mismo orden de compras y liquidaciones.

**Garantías:**

- un intento en curso y un cierre por sesión (índices parciales);
- una aprobación por cierre y un reporte por sesión;
- un retiro por intento y un ajuste por discrepancia;
- claves de idempotencia únicas en inicio, regreso, retiro, ajuste y confirmación;
- la confirmación revalida dentro de la transacción y compara la huella del resumen.

**Probado con PostgreSQL real:**

- dos inicios simultáneos;
- abrir mesa mientras se inicia el cierre;
- confirmaciones simultáneas con la misma clave y con claves distintas;
- retiros duplicados;
- ajustes duplicados;
- verificación de una transferencia entre la vista previa y la confirmación (409).

## 28. Endpoints

Todos bajo `/api/sessions/:id/closure`:

| Método | Ruta                                                                                                                                 | Permiso                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET    | `/` (panel), `/precheck`, `/inventory`, `/cash`, `/discrepancies`, `/outstanding-chips`, `/financial-summary`, `/preview`, `/report` | `sessions:read`                                                                        |
| GET    | `/report/image` (PNG)                                                                                                                | `sessions:read`                                                                        |
| POST   | `/start`, `/return-to-open`, `/inventory-count` (`start`/`confirm`), `/cash-count`, `/cash-withdrawal`                               | `sessions:manage`                                                                      |
| POST   | `/discrepancies/:discrepancyId/resolve`                                                                                              | `sessions:manage` (`note`); además `sessions:close-authorize` (`authorize-adjustment`) |
| POST   | `/confirm`                                                                                                                           | `sessions:close-authorize`                                                             |
| POST   | `/report/share-events`                                                                                                               | `sessions:read`                                                                        |

- Las mesas siguen con los endpoints del Módulo 07. Las capturas del arqueo usan `PATCH /api/chip-inventory/counts/:id`.
- No existe un endpoint genérico de cambio de estado.

## 29. Modelos

| Modelo                           | Contenido                        |
| -------------------------------- | -------------------------------- |
| `SessionClosure`                 | Intento de cierre (con guarda)   |
| `ClosureStatusHistory`           | Historial de estados del intento |
| `ClosurePrecheck`                | Fotografía de la prevalidación   |
| `ClosureDiscrepancy`             | Diferencia física de un arqueo   |
| `ClosureAdjustmentAuthorization` | Ajuste excepcional autorizado    |
| `ClosureCashWithdrawal`          | Retiro final con receptor        |
| `ClosureApproval`                | Autorización definitiva          |
| `ClosureReport`                  | Comprobante inmutable            |

**Reutilizados, sin duplicar:**

- `ChipStockCount`/`ChipNominalMovement` (Módulo 04);
- `CashReconciliation`/`CashTransaction` (Módulo 05);
- `SessionStatusHistory` (Módulo 06).

**Enums nuevos:** `SessionClosureStatus`, `SessionClosureKind`, `ClosurePrecheckStage`, `ClosureDiscrepancyKind`, `ClosureDiscrepancyStatus`, `ClosureDiscrepancyResolution`. Se agregó `SUPERSEDED` a `ChipReconciliationStatus` y a `CashDifferenceStatus`.

**Migraciones seguras:** solo agregan tablas, índices, CHECKs y triggers, y reemplazan guardas de forma compatible.

- No cierran ni cambian sesiones existentes y no tocan compras, deudas ni saldos.
- Las sesiones antiguas que se hubieran cerrado a mano no tienen `SessionClosure` ni comprobante: siguen siendo historia válida.

## 30. Pruebas

| Tipo                          | Archivos                                                                                   | Resultado                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| Unitarias                     | `src/modules/closure/closure.test.ts` (26), `permission-matrix.test.ts`, `session.test.ts` | 330/330 en total               |
| Integración (PostgreSQL real) | `tests/integration/closure.int.test.ts` (18 casos con varios escenarios cada uno)          | 364/364 en total               |
| E2E (Chrome + iPhone)         | `tests/e2e/closure.spec.ts` (7 casos × 2 proyectos)                                        | 14/14 (suite completa 166/166) |

| Decisión                                                                                  | Dónde                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| DEC-01/02 arqueo global único; no por mesa                                                | §1, §8; pruebas «una mesa cierra…», «arqueo global único» |
| DEC-03 diferencia bloquea                                                                 | §13; «una diferencia física bloquea»                      |
| DEC-04/05 solo PARTNER/SUPERADMIN confirman; CASHIER prepara                              | §18; 403 probado                                          |
| DEC-06/07 retiro con receptor, sin confirmación del receptor                              | §15–17                                                    |
| DEC-08/09 sin actividad con motivo                                                        | §5                                                        |
| DEC-10/11/12 regreso a OPEN auditado; nunca reabrir CLOSED                                | §6                                                        |
| DEC-13 caja $0 → $0                                                                       | §14–17                                                    |
| DEC-14/15/16/17 obligaciones sobreviven; sin pagos inventados                             | §19–21                                                    |
| DEC-18/19 PNG, sin PDF                                                                    | §22–23                                                    |
| DEC-20/21/22/23 fichas no retornadas ≠ faltante ni utilidad; canje posterior sin duplicar | §11–12, §31                                               |

## 31. Canje posterior de fichas

`assessLateRedemption(amount)` **solo evalúa**: compara con la circulación global y responde `enabled: true` y `requiresPhysicalReception: true`. **No** registra entradas, obligaciones ni pagos. El flujo completo está implementado en el Módulo 16 (`docs/MODULE_16_SPECIAL_OPERATIONS.md` §2), que cumple este contrato:

1. Recepción física y captura del valor nominal real.
2. Entrada con `confirmNominalChipReturnInTx`, con clave única por canje. La base ya impide devolver más de lo que está en circulación.
3. Cuenta por pagar y desembolsos con los contratos del Módulo 11 (custodia o banco), sin reabrir la caja ni el inventario de la sesión original.
4. Vínculo **informativo** con la sesión original, solo si se identifica con fundamento.

La circulación global no prueba que una persona tenga derecho a cobrar.

## Pendiente (fuera de este módulo)

- Aplicar las migraciones en Neon (requiere autorización).
- Canje posterior, reverso completo de compras, corrección de liquidaciones con pagos y devolución de fondos no aplicados: implementados en el Módulo 16. Un reverso o canje posterior NUNCA modifica la caja, el inventario de la sesión cerrada ni su `ClosureReport`.
- Pantalla de consulta de auditoría y reportes globales.

## Nota del Módulo 14 — deuda al cierre vs. deuda actual

Los reportes (`docs/MODULE_14_REPORTS.md`) usan `ClosureReport.content` como **vista histórica** (DEC-15): `credits.outstanding` es la «deuda registrada al cierre» y nunca se recalcula ni se modifica. El desglose por jugador y compra al instante del cierre se reconstruye del libro inmutable de aplicaciones (`allocatedAt ≤ closedAt`). La **deuda actual originada en la sesión** sale de los movimientos vigentes, y la diferencia se explica por abonos, pagos vinculados, compensaciones y reversos posteriores (identidad verificada). Las cifras de fichas (diferencia física, neto no retornado, circulación global) se presentan igual que en el cierre, nunca como utilidad.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

Cerrar el ciclo de una mesa libera al dealer (`CYCLE_CLOSED`) en la misma transacción; un trigger impide cerrar un ciclo con asientos ocupados o dealer vigente. Un jugador sentado sin compra debe retirarse (sin compra) o transferirse antes de cerrar. La métrica del ciclo agrega `playersWithdrawn`.

## Folios de sesión y captura histórica — ver `docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md`

Una sesión `HISTORICAL` no tiene cierre (no se abre, no tiene caja ni arqueos): no aparece en los flujos de cierre. Los reportes de cierre ya emitidos conservan el folio que tenían al emitirse (contenido inmutable); la sesión guarda el anterior en `previousFolio`.

## Integración con el Módulo 17

Módulo 17: el cierre no cambia: un jugador bancado activo bloquea igual que cualquiera; los pagos de bancaje solo usan la caja de una sesión ABIERTA (nunca una cerrada).

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
