# Módulo 14 — Reportes, estadísticas, dashboards y exportación XLSX

Estado: **completado (2026-10-27)**. El Módulo 13 (WhatsApp) sigue en pausa y **no** es dependencia de este módulo.

> **Regla permanente:** «Toda deuda debe poder consultarse de forma global por jugador, desglosada por sesión de origen y finalmente por cada compra o recompra. Los pagos posteriores se aplican a las obligaciones originales y no trasladan la deuda a la fecha o sesión del pago.»

## 1. Arquitectura de consultas

El Módulo 14 es una **capa de solo lectura** (`src/modules/reports/*`). No crea tablas, no materializa saldos y no escribe movimientos. Lee de las fuentes de verdad existentes:

| Concepto            | Fuente (nombre real)                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sesión              | `PokerSession`, `SessionOpening`, `SessionClosure`, `ClosureReport` (snapshot inmutable)                                   |
| Mesas               | `SessionTable`, `SessionTableCycle`, `TableParticipation`, `TableTransfer`                                                 |
| Compras             | `ChipPurchase`, `PurchasePayment`, `PurchaseCreditAuthorization`, `PurchaseDelivery`                                       |
| Deudas (CxC)        | `PlayerDebt` + libro inmutable `PaymentAllocation`                                                                         |
| Abonos              | `ReceivablePayment`, `ReceivablePaymentReversal`, `UnappliedPlayerFunds`                                                   |
| Liquidaciones (CxP) | `PlayerSettlement`, `SettlementPayable`, `SettlementPayout`                                                                |
| Dinero              | `CashTransaction`, `CashTransactionEntry`, `FinancialAccountBalance`, `BankTransferVerification`, `CardTerminalSettlement` |
| Fichas              | `ChipNominalMovement`, `ChipSetInventoryState`, `ChipStockCount(+Detail)`, `ChipInventoryOperation`                        |

Capas: **Route Handler → autorización (`reports:*`) → filtros Zod → servicio de reporte → Prisma** (agregaciones SQL / `groupBy`). Los cálculos agrupados viven en funciones **puras** (`report.math.ts`) que usan la pantalla, la API y el XLSX: no hay dos fórmulas para la misma cifra. Los cobros de compras reutilizan `summarizePayments` del Módulo 08 y la circulación reutiliza `getGlobalChipPosition` del Módulo 12.

| Servicio (`src/modules/reports/`)                                                     | Equivale a                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `dashboard-report.service.ts`                                                         | DashboardReportService                                                                   |
| `session-report.service.ts`                                                           | SessionReportService + TableReportService (`sessionMetrics` por lote, `listTableCycles`) |
| `purchase-report.service.ts`                                                          | PurchaseReportService + SettlementReportService                                          |
| `financial-report.service.ts`                                                         | FinancialReportService                                                                   |
| `credit-report.service.ts`                                                            | CreditReportService, CreditBySessionReportService, ReceivableAllocationReportService     |
| `chip-report.service.ts`                                                              | ChipInventoryReportService                                                               |
| `player-report.service.ts`                                                            | PlayerReportService                                                                      |
| `comparative-report.service.ts`                                                       | ComparativeReportService                                                                 |
| `xlsx-export.service.ts` (+ `xlsx.workbook.ts`, `xlsx.cells.ts`)                      | XlsxExportService                                                                        |
| `report.math.ts`, `report.filters.ts`, `report-route.ts`, `report-options.service.ts` | núcleo puro, filtros, rutas, catálogos de filtros                                        |

## 2. Nominal vs. financiero (cuatro categorías)

Nunca se suman entre sí:

1. **Movimientos nominales** — fichas entregadas/devueltas, custodia y circulación (`chip_nominal_movements`). No son dinero.
2. **Movimientos monetarios** — asientos del libro en cuentas de dinero (`isMoney`): efectivo por sesión, banco, terminal por liquidar, custodia administrativa, efectivo en tránsito.
3. **Cuentas por cobrar** — `PlayerDebt` con saldo derivado.
4. **Cuentas por pagar** — `SettlementPayable` con saldo derivado (original − desembolsos EXECUTED).

**No se declara utilidad neta** (DEC-05): no hay fórmula contable validada. Ningún reporte rotula una diferencia de entradas y salidas como utilidad. Los retiros de caja no son gastos. El crédito no es ingreso de efectivo. La circulación no es utilidad.

## 3. Definición exacta de KPIs (dashboard `/dashboard/reportes`)

Cada indicador declara su periodo: **Sesión vigente** (DRAFT/PREPARATION/OPEN/CLOSING) o **Global, a la fecha**.

| KPI                                   | Periodo | Definición                                                                                                                                                                               |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sesión actual / estado                | Sesión  | Sesión vigente única (índice `poker_sessions_single_active`).                                                                                                                            |
| Mesas abiertas                        | Sesión  | `SessionTable.status = OPEN`.                                                                                                                                                            |
| Jugadores activos                     | Sesión  | Participaciones `ACTIVE`.                                                                                                                                                                |
| Compras iniciales / Recompras         | Sesión  | Σ `nominalAmount` de compras `CONFIRMED` por tipo (valor nominal, incluye la parte a crédito).                                                                                           |
| Efectivo físico de caja               | Sesión  | Saldo `CASH_ON_HAND` del alcance de la sesión (solo OPEN/CLOSING).                                                                                                                       |
| Cobros confirmados de compras         | Sesión  | Efectivo `CONFIRMED` + terminal `APPROVED` + transferencias con verificación `CONFIRMED` (importe confirmado) de compras entregadas. Crédito y transferencias pendientes **no** cuentan. |
| Créditos originados                   | Sesión  | Σ `PlayerDebt.originalAmount` nacidas en la sesión.                                                                                                                                      |
| Transferencias pendientes             | Global  | `BankTransferVerification` `PLAYER_PAYMENT` `PENDING_VERIFICATION` (declarado).                                                                                                          |
| Terminal pendiente de liquidar        | Global  | Saldo `CARD_TERMINAL_CLEARING`. El depósito posterior es traslado y no se suma otra vez.                                                                                                 |
| Deudas por cobrar                     | Global  | Σ (original − aplicado neto) de todas las deudas.                                                                                                                                        |
| Obligaciones por pagar                | Global  | Σ (original − desembolsos EXECUTED) de payables no anulados; aparte, transferencias de pago en curso.                                                                                    |
| Fichas bajo custodia / en circulación | Global  | Proyección del inventario compartido verificada contra su libro.                                                                                                                         |
| Custodia administrativa               | Global  | Saldo `ADMIN_CASH_CUSTODY` (no es caja de juego).                                                                                                                                        |

## 4. Deuda por jugador → sesión de origen → compra/recompra

`buildCreditTree(debts, allocations)` (puro) agrupa las deudas por **`PlayerDebt.sessionId` original** (nunca por la sesión o fecha del pago) y, dentro de cada sesión, por compra/recompra (orden FIFO: fecha de nacimiento, desempate por id). Cada nivel muestra:

- **Crédito original**
- **Abonos aplicados (FIFO)** — aplicaciones `RECEIVABLE_PAYMENT`
- **Pagos vinculados a la compra** — aplicaciones `PURCHASE_PAYMENT` (p. ej. transferencia de la compra verificada después; no se redistribuyen por FIFO)
- **Compensaciones con fichas** — aplicaciones `CHIP_SETTLEMENT_OFFSET` (no son dinero)
- **Reversos** — aplicaciones `REVERSAL` (aumentan el saldo)
- **Saldo** = original − abonos − vinculados − compensaciones + reversos (misma fórmula que `appliedNet` del Módulo 10)
- **Estado derivado** `OPEN` / `PARTIALLY_PAID` / `PAID` (`receivableStatus` del Módulo 10)

Por obligación se consulta además: folio y tipo de compra, sesión, **mesa y ciclo originales** (de la compra; nunca se reubican por cambios de mesa), socio autorizador y medio, firma (estado y fecha), fecha de origen y cada aplicación con su **fecha real**, folio del abono, método, sesión de cobro (o «fuera de sesión») e importe total del abono.

Pantallas: `/dashboard/reportes/creditos` (resumen, jugadores paginados con deuda más antigua primero, tabla por sesión de origen) y `/dashboard/reportes/creditos/[playerId]` (estado de cuenta con `<details>` expandibles: sesión → compra → aplicaciones; funciona sin JS y en celular).

## 5. FIFO y pagos vinculados

El reporte no recalcula FIFO: **lee** las aplicaciones que el motor del Módulo 10 (`allocateFifoInTx`) ya registró. Un abono general de $4,000 que salda la sesión A ($3,000) y abona $1,000 a la B aparece como **un** abono con **tres** aplicaciones (dos compras de A y una de B), cada una con la sesión de origen de su deuda y la fecha real del abono. No se crea deuda nueva, no se mueve la deuda a la sesión del pago y no se duplican pagos.

## 6. Deuda al cierre vs. deuda actual

- **Deuda al cierre (histórica):** `ClosureReport.content.credits.outstanding`, snapshot inmutable del Módulo 12 (DEC-15). Por jugador y por compra se **reconstruye** del libro inmutable de aplicaciones con `allocatedAt ≤ closedAt` (el libro no admite cambios, así que la reconstrucción es estable).
- **Deuda actual originada en la sesión:** saldo HOY de las deudas nacidas allí (movimientos vigentes, DEC-16).
- Diferencia **identificada por clase**: abonos posteriores, pagos vinculados posteriores, compensaciones posteriores y reversos posteriores. La identidad `alCierre − abonos − vinculados − compensaciones + reversos = actual` se verifica (`reconciles`); si no cerrara se muestra en rojo.
- El detalle de sesión (`/dashboard/reportes/sesiones/[id]`) muestra en tarjetas separadas la **vista histórica del cierre** y la **vista actual de obligaciones originadas**.

## 7. Abonos (`/dashboard/reportes/abonos`)

Un renglón por abono (folio, jugador, fecha real, método, origen SESSION/ADMINISTRATIVE, sesión de cobro, importe, aplicado neto, recibido sin aplicar, usuario, estado, referencia financiera) con sus aplicaciones anidadas (sesión de origen, compra, mesa original, orden FIFO). `paymentTotals` suma el **importe recibido una vez por abono confirmado** y lo aplicado como suma neta de aplicaciones: un abono de $4,000 en dos deudas suma $4,000, nunca $8,000. El filtro de sesión incluye la sesión de cobro y las sesiones de origen de las deudas afectadas.

## 8. Saldos por cobrar y por pagar

- CxC: `getCreditSummary` / `listCreditPlayers` / `listCreditSessions` (SQL agregado con una fila por deuda en un CTE; misma fórmula que el árbol, verificado por prueba de integración).
- CxP (`/dashboard/reportes/liquidaciones`): nominal devuelto, decisión y compensación, pago neto, efectivo entregado, transferencias ejecutadas y **pendientes (no descuentan la obligación)**, obligación pendiente, fechas de liquidación y del último pago. Las obligaciones aparecen aunque la sesión esté `CLOSED`.
- Compensaciones: decisión, importe, deudas y sesiones de origen afectadas, saldo antes/después. **No** son abonos de efectivo ni ingresos bancarios, y CxC y CxP **nunca** se netean.

## 9. Inventario y fichas no retornadas (`/dashboard/reportes/fichas`)

Posición global (custodia, reservado, circulación, consistencia con el libro), último arqueo confirmado con su composición **verificada solo en esa fecha**, arqueos con diferencias físicas, ajustes (inventario y ajustes autorizados en cierres), flujos del periodo y **neto no retornado por sesión**. Regla del Módulo 12: «Las fichas que no regresan al cierre se muestran como valor nominal pendiente de retorno o en circulación. No constituyen automáticamente un faltante físico de arqueo ni utilidad definitiva y no se pagan sin una presentación y validación física posterior.» No se afirma quién conserva las fichas. La circulación global persiste entre sesiones. El canje posterior sigue sin habilitar (contrato `assessLateRedemption`).

## 10. Limitaciones de resultados por mesa

`/dashboard/reportes/mesas` muestra un renglón por **ciclo** (mesa, ciegas del snapshot, sesión, apertura/cierre, participantes distintos, compras/recompras originadas y su nominal, liquidaciones y nominal devuelto en la mesa final, transferencias de entrada/salida, estado). **No** se calcula ganancia por mesa: las transferencias de mesa no registran el valor trasladado (Módulo 07) y la caja es central. Una compra conserva su mesa de origen; una liquidación, la mesa final.

## 11. Otros reportes

- **Sesiones** (`/dashboard/reportes/sesiones`): fecha operativa (día de apertura en America/Monterrey), apertura y cierre reales, estado, mesas y ciclos, jugadores distintos, compras/recompras, nominal entregado/devuelto/no retornado, créditos originados, deuda actual, cobros, abonos registrados en la sesión, liquidaciones pagadas/pendientes, arqueo final, retiro, diferencias y ajustes, autorizador.
- **Compras** (`/dashboard/reportes/compras`): solo importe (sin denominaciones); componentes por método sin duplicar; transferencia pendiente aparte; crédito originado al entregar; canceladas no son entregas; revertidas y reversos solicitados distinguidos.
- **Finanzas** (`/dashboard/reportes/finanzas`): caja por sesión (inicial $0, aportaciones, cobros, abonos, pagos, retiros, retiro final de cierre, final), flujos por cuenta y tipo con la fecha real del asiento, saldos vigentes, CxC y CxP.
- **Jugadores** (`/dashboard/reportes/jugadores`): sesiones, mesas, compras, comprado, devuelto, **balance nominal observado (no es utilidad)**, créditos, abonos, compensaciones, deuda actual, liquidaciones, pagos pendientes, última participación.
- **Comparativos** (`/dashboard/reportes/comparativos`): barras sin dependencias nuevas; cada serie declara unidad, periodo y definición (compras, recompras, jugadores, créditos al cierre y hoy, obligaciones hoy, circulación al cierre, diferencias de arqueo, actividad por mesa, cobros y pagos por mes).

## 12. Filtros y persistencia

`reportFiltersSchema` (Zod) valida **en el servidor** (páginas, API y XLSX): `from`/`to` (días operativos), `sessionId`, `tableId`, `playerId`, `method`, `status` (validado por reporte), `operatorId`, `partnerId`, `debtFrom`/`debtTo` (**origen de la deuda**), `paymentFrom`/`paymentTo` (**fecha real del abono**), `page`, `pageSize` (5–100). No se usa una sola fecha ambigua. Los filtros viven en **URL search params**: los enlaces al detalle y el regreso los conservan, y `FilterMemory` los recuerda por pestaña (`sessionStorage`, con try/catch) para restaurarlos al volver por el menú. Un filtro inválido en una página muestra el error y cae a «todos».

## 13. Actualización

- Dashboard: TanStack Query (`["reports","dashboard"]`) con `refetchOnMount: "always"` y `refetchOnWindowFocus: "always"`; ante error conserva los últimos datos válidos; botón «Actualizar» y hora de actualización.
- `QueryProvider` invalida `["reports"]` tras **cualquier** mutación exitosa (compras, pagos, abonos, liquidaciones, desembolsos, mesas, sesiones, arqueos, ajustes).
- Reportes de servidor: `RefreshOnFocus` llama `router.refresh()` al volver a la pestaña o recuperar el foco (máx. cada 5 s) y ofrece botón manual.
- Sin WebSocket (DEC-11): no se promete sincronización instantánea entre dispositivos.

## 14. Exportación XLSX (única)

`GET /api/reports/export/xlsx?report=<tipo>&<filtros>` con ExcelJS 4.4.0 (dependencia nueva justificada: no había librería XLSX; mantenida, lee y escribe, permite pruebas programáticas; `uuid` forzado a 11.1.1 por `overrides` para cerrar el aviso de `npm audit`). **Sin CSV ni PDF** (un `format` distinto de `xlsx` → 400). Tipos: `dashboard`, `sessions`, `tables`, `purchases`, `financial`, `credits`, `payments`, `settlements`, `chips`, `players`, `comparisons`.

- Respeta filtros validados y permisos (`reports:export` + el permiso de lectura del reporte).
- Encabezados, formato MXN (`"$"#,##0.00`), fechas en hora local del negocio, importes **numéricos**, totales verificables (`SUM` con el resultado calculado por el servidor), hoja «Filtros y fecha» (reporte, fecha de generación, usuario, periodo, criterios, filas, notas de reglas).
- **Créditos** (`PokerManager_Creditos.xlsx`): Resumen global · Deudas por jugador · Deudas por sesión · Detalle de compras · Aplicaciones de abonos · Filtros y fecha. En «Aplicaciones de abonos» el importe total del abono se repite por fila y se rotula «no sumar»; el total es del importe aplicado.
- Seguridad: textos que empiezan con `= + - @`, tabulador o retorno se prefijan con apóstrofo y se eliminan caracteres de control (`safeText`); las únicas fórmulas son los totales del sistema; sin secretos (no se exportan teléfonos ni datos bancarios); límite de 20,000 obligaciones/abonos/compras por exportación (`MAX_DETAIL_ROWS`, si no 400 «acota los filtros»); dos consultas por conjunto (sin N+1).

## 15. Permisos

DEC-06..08: **SUPERADMIN, PARTNER y CASHIER** tienen `reports:view`, `reports:financial` y `reports:export` (nuevo). Sin sesión → 401; los endpoints de reportes son **solo GET**. Ningún rol edita saldos, compras, movimientos o arqueos desde reportes (no existe la ruta). CASHIER sigue sin `audit:read`, `corrections:operate` ni `dashboard:financial`.

## 16. Auditoría

Se audita **solo la exportación** (`REPORT_EXPORTED`, `entityType: Report`, `entityId` = tipo): usuario, fecha, filtros aplicados, filas, bytes y resultado (`SUCCESS` o `FAILURE` con mensaje acotado). Consultar una pantalla o gráfica no genera eventos ni movimientos financieros. Reutiliza `recordAuditSafe` (el Módulo 15 heredará esta infraestructura).

## 17. Endpoints

| Método y ruta                                                              | Permiso                    |
| -------------------------------------------------------------------------- | -------------------------- |
| `GET /api/reports/dashboard`                                               | `reports:financial`        |
| `GET /api/reports/sessions` · `/sessions/:sessionId`                       | `reports:view`             |
| `GET /api/reports/tables`                                                  | `reports:view`             |
| `GET /api/reports/purchases`                                               | `reports:view`             |
| `GET /api/reports/financial`                                               | `reports:financial`        |
| `GET /api/reports/credits` (resumen + jugadores)                           | `reports:financial`        |
| `GET /api/reports/credits/players`                                         | `reports:financial`        |
| `GET /api/reports/credits/sessions` (por sesión de origen)                 | `reports:financial`        |
| `GET /api/reports/credits/players/:playerId`                               | `reports:financial`        |
| `GET /api/reports/credits/players/:playerId/sessions`                      | `reports:financial`        |
| `GET /api/reports/credits/players/:playerId/sessions/:sessionId`           | `reports:financial`        |
| `GET /api/reports/credits/players/:playerId/sessions/:sessionId/purchases` | `reports:financial`        |
| `GET /api/reports/credits/payments`                                        | `reports:financial`        |
| `GET /api/reports/settlements`                                             | `reports:financial`        |
| `GET /api/reports/chips`                                                   | `reports:view`             |
| `GET /api/reports/players`                                                 | `reports:view`             |
| `GET /api/reports/comparisons`                                             | `reports:financial`        |
| `GET /api/reports/export/xlsx`                                             | `reports:export` + lectura |

Los endpoints existentes de los Módulos 05/08/10/11 (`/api/credits/*`, `/api/purchases`, …) se mantienen para la operación; los de reportes no los duplican (agregan por sesión de origen, histórico vs. actual y exportación).

## 18. Rendimiento

Paginación en todos los listados; agregaciones en la base (`groupBy`, CTE SQL con `FILTER`); métricas de sesión **por lote** (número fijo de consultas para N sesiones); árbol de créditos con **dos** consultas (deudas + aplicaciones filtradas por relación), sin joins que dupliquen aplicaciones. Migración `20261027120000_module14_report_indexes` (solo índices, sin datos): `player_debts(createdAt)`, `player_debts(tableId)`, `receivable_payments(sessionId)`, `payment_allocations(source, allocatedAt)`, `chip_purchases(cycleId)`, `chip_purchases(confirmedAt)`, `player_settlements(cycleId)`, `cash_transactions(confirmedAt)`, `chip_stock_counts(status, confirmedAt)`. Verificada con `prisma migrate diff` (vacío) en la base local; **aplicada en Neon** el 2026-10-20 (`prisma migrate deploy`; `migrate diff` contra Neon vacío).

## 19. Pruebas

| Tipo                     | Archivo                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unitarias                | `src/modules/reports/report.test.ts` (árbol, FIFO entre sesiones, vinculados, al cierre vs actual, compensaciones, reversos, totales sin duplicar, fechas, filtros, XLSX legible, anti-fórmulas, números, permisos, solo GET, sin CSV/PDF)                               |
| Integración (PostgreSQL) | `tests/integration/reports.int.test.ts` (caso Juan Pérez completo con flujos reales, reverso, concurrencia, liquidación con compensación parcial y CxP tras el cierre, endpoints y permisos, exportación de los 11 reportes sin escrituras)                              |
| E2E (Chrome + iPhone)    | `tests/e2e/reports.spec.ts` (dashboard, créditos, expandir sesiones/compras, abono desde el Módulo 10 y FIFO al volver, descarga y lectura del XLSX, deuda al cierre/actual, persistencia de filtros, PARTNER y SUPERADMIN, móvil sin scroll horizontal, 401 sin sesión) |

## 20. Pendientes

- Las fechas de vencimiento de deudas no existen (no se inventan).
- Módulo 16: la extinción por reverso de compra es una clase propia (`EXTINCTION`) en créditos —nunca un abono—; una compra REVERSED sigue contando como entrega histórica (con marca `reversed`) y la devolución aparece como movimiento de inventario; la posición financiera lista las obligaciones especiales pendientes por tipo (no son ingresos ni gastos).
- Módulo 15 — Auditoría, administración y respaldos: consumirá `REPORT_EXPORTED` y la infraestructura de auditoría existente.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

Las compras, créditos y liquidaciones registradas desde la mesa aparecen en los reportes sin cambios (mismas tablas). Asientos, dealer y paño no son movimientos financieros y no se reportan como tales.

## Folios de sesión y captura histórica — ver `docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md`

Los reportes por sesión filtran y muestran la **fecha operativa** (`businessDate`), no la de captura ni la de apertura; el XLSX de sesiones agrega «Folio anterior» y «Tipo» (normal/histórica). El reporte de créditos sigue agrupando por `sessionId` de origen y muestra la fecha operativa de esa sesión; los movimientos financieros conservan su fecha efectiva.
