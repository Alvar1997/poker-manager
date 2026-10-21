# Módulo 05 — Caja central y cuentas de pago

Libro financiero único para las dos mesas: efectivo por sesión, banco global, aportaciones, retiros, traslados, transferencias con verificación manual, reversos y arqueos de efectivo. Prepara los contratos que usarán sesiones (06), compras, abonos, liquidaciones y cierre.

Código: `src/modules/cash/` · API: `src/app/api/cash-box/` · Pantallas: `src/app/(dashboard)/dashboard/caja/` · Migración: `prisma/migrations/20261017120000_module05_cash_box/`.

> **Estado:** desde el Módulo 06 la caja usa sesiones reales (`prismaSessionGateway` lee `poker_sessions`). Sin una sesión `OPEN`, toda operación de efectivo responde `422 — No hay una sesión operativa abierta`. La caja **no inventa sesiones**. Las pruebas de la caja pueden inyectar `fixtureSessionGateway`.

## 1. Caja central única

- `CashBox` `MAIN` (Módulo 02) sigue siendo la única caja: la base impide otra (`CHECK code = 'MAIN'`).
- Todas las `FinancialAccount`, `CashTransaction` y `CashReconciliation` apuntan a esa caja. No hay cajas por mesa ni por usuario.
- La caja no guarda un "saldo" en sí misma: los saldos son proyecciones del libro (`financial_account_balances`) que se actualizan en la misma transacción que el movimiento.

## 2. Dos mesas

- Las mesas 25/25 y 10/10 comparten el mismo libro (y también el mismo inventario físico de fichas: **un inventario compartido + dos mesas + una caja central**). Un cobro lleva `tableId` cuando corresponde, pero el efectivo pertenece a la **sesión**, no a la mesa: dos mesas que cobran en la misma sesión suman al mismo efectivo de caja.
- Cada movimiento se registra **una sola vez**. Los índices únicos por operación de origen (`cash_transactions_one_per_origin`, `bank_transfers_one_live_per_origin`) impiden registrar la misma compra, abono o liquidación dos veces, aunque la intenten registrar dos mesas o dos usuarios.

## 3. Cuentas financieras

Doce cuentas técnicas sembradas de forma idempotente (`src/modules/cash/cash.seed.ts`), sin saldos (`CARD_TERMINAL_CLEARING` desde el Módulo 08; `ADMIN_CASH_CUSTODY` y `UNAPPLIED_PLAYER_FUNDS` desde el Módulo 10):

| Código                  | `kind`                       | ¿Dinero? | Alcance | No negativa |
| ----------------------- | ---------------------------- | -------- | ------- | ----------- |
| `EFECTIVO`              | `CASH_ON_HAND`               | Sí       | Sesión  | Sí          |
| `BANCO`                 | `BANK`                       | Sí       | Global  | No¹         |
| `EN_TRANSITO`           | `CASH_IN_TRANSIT`            | Sí       | Global  | Sí          |
| `APORTACIONES`          | `OWNER_CONTRIBUTIONS`        | No       | Global  | No          |
| `RETIROS`               | `CASH_WITHDRAWALS`           | No       | Global  | No          |
| `COBROS_COMPRAS`        | `PLAYER_PURCHASES`           | No       | Global  | No          |
| `COBROS_ABONOS`         | `PLAYER_DEBT_PAYMENTS`       | No       | Global  | No          |
| `PAGOS_LIQUIDACIONES`   | `PLAYER_SETTLEMENTS`         | No       | Global  | No          |
| `DIFERENCIAS_ARQUEO`    | `RECONCILIATION_DIFFERENCES` | No       | Global  | No          |
| `TERMINAL_POR_LIQUIDAR` | `CARD_TERMINAL_CLEARING`     | Sí       | Global  | Sí          |

¹ El banco muestra solo el **neto de movimientos registrados en Poker Manager**, no el saldo real de la cuenta: no se valida contra el banco.

Las cuentas que no son dinero no son "ingresos" ni "gastos": solo explican de dónde vino o a dónde fue el dinero. Cada `CashTransaction` tiene al menos dos `CashTransactionEntry` cuyos débitos igualan a sus créditos (partida doble).

## 4. Apertura con saldo cero

- `OperationalSettings.initialCashPolicy = ZERO_OPENING_BALANCE` y `openingCashBalance = 0.00`, fijados por `CHECK`.
- El efectivo se lleva por sesión (`scopeKey` = id de sesión). Una sesión nueva no tiene fila de saldo: su efectivo es **$0.00 por construcción**.
- No hay arrastre: el efectivo de una sesión no aparece en otra (probado en integración).
- La migración convirtió `NEW_FUND_PER_SESSION` en `ZERO_OPENING_BALANCE` (`ALTER TYPE … USING CASE`) **sin borrar filas**; el tipo enum antiguo se elimina después de convertir los datos.

## 5. Prohibición de fondo automático

- `requireOpeningCashFund = false` y `carryCashToNextSession = false`, fijados por `CHECK`.
- No existe ninguna operación de "fondo inicial". Si se quiere tener efectivo para pagar, se registra una **aportación real** (sección 8) dentro de la sesión abierta.
- Si el arqueo de apertura encuentra dinero, **no se ajusta ni se convierte en fondo**: `adjustCashReconciliation` rechaza el ajuste en `OPENING`; se retira físicamente y se vuelve a contar hasta obtener $0.00.

## 6. Arqueo obligatorio de fichas antes de apertura

**Reemplazado en el Módulo 06** por el checklist de apertura derivado (`src/modules/sessions/opening.service.ts#computeOpeningChecklist`), que verifica:

- Un arqueo OPENING **de la propia sesión** del inventario compartido (uno solo para ambas mesas): confirmado, conciliado y **vigente** (`resultingInventoryVersion` = versión actual), sin circulación ni reservas previas. También verifica el arqueo de efectivo de apertura confirmado en $0.00 y aún vigente. Nunca exige dos arqueos separados.
- Vigencia: `versión actual del inventario = inventoryVersion del conteo + 1 si fue INITIAL + 1 si se concilió`. Cualquier otro movimiento lo vuelve `STALE_COUNT`.
- Si ya existe un arqueo vigente, **se reutiliza** (no se obliga a recontar).
- `openSession` lo recalcula dentro de la transacción de apertura (ver `docs/MODULE_06_SESSIONS.md`). Un solo arqueo general habilita la apertura de las dos mesas.

## 7. Prohibición de saldos negativos

- `postTransactionInTx` bloquea las proyecciones afectadas y calcula el saldo resultante **antes** de escribir. Si una cuenta `nonNegative` (efectivo, en tránsito) quedaría negativa, lanza `InsufficientFundsError` con el faltante: «hay $1,000.00 y se requieren $1,500.00. Faltan $500.00».
- La base lo respalda: `CHECK (NOT "nonNegative" OR balance >= 0)` en `financial_account_balances` y `allowNegativeCashBalance = false` fijado por `CHECK`.

## 8. Aportaciones reales

- `POST /api/cash-box/contributions` → `registerContribution`: DEBIT `EFECTIVO`(sesión) / CREDIT `APORTACIONES`.
- Requieren sesión **OPEN**, importe > 0 como texto decimal, quién aporta, motivo y clave de idempotencia. Referencia y notas opcionales.
- Una aportación no es compra, ingreso, ganancia ni deuda. Auditoría `CASH_CONTRIBUTION_CREATED`.

## 9. Retiros

- `POST /api/cash-box/withdrawals` → `registerWithdrawal`: DEBIT `RETIROS` / CREDIT `EFECTIVO`(sesión).
- Destinos cerrados: `OWNER_CUSTODY` (propietario/socio), `SAFEKEEPING` (resguardo), `CONTRIBUTION_RETURN` (devolución de aportación). `SESSION_CLOSING` **no** se acepta desde la API: es exclusivo del retiro total del cierre.
- Nunca mayor al disponible (sección 7). Quién recibe y motivo obligatorios. Auditoría `CASH_WITHDRAWAL_CREATED`.
- **Retiro total del cierre** (contrato para el Módulo 12): `withdrawAllCashForClosingInTx` exige sesión `CLOSING`, arqueo de cierre confirmado sin diferencias pendientes y que el efectivo no haya cambiado desde ese arqueo. Deja el efectivo en $0.00.

## 10. Transferencias bancarias

- `BankTransferVerification` con estados `PENDING_VERIFICATION` → `CONFIRMED` | `REJECTED` | `CANCELLED`. Un registro resuelto es inmutable (trigger), y no admite `DELETE`.
- Tipos: `PLAYER_PAYMENT` (cobro de compra o abono; lo crean los módulos de origen con `registerPendingBankTransferInTx`) y `CASH_DEPOSIT` (traslado de efectivo al banco).
- **Pendiente ≠ cobrada**: no genera asiento ni cuenta en "transferencias confirmadas".
- Siempre se usa la cuenta receptora principal configurada en el Módulo 02. No se capturan ni inventan datos bancarios.

## 11. Verificación manual

- `POST /api/cash-box/bank-transfers/:id/confirm`: el usuario declara `verifiedInBank: true` (obligatorio). Puede indicar el importe realmente acreditado, la referencia y notas; si el importe difiere del declarado, las notas son obligatorias.
- Lo pueden hacer **SUPERADMIN, PARTNER y CASHIER**, sin aprobación adicional (`cash:operate`). Se registra quién verificó y cuándo.
- Confirmar crea el asiento DEBIT `BANCO` / CREDIT cuenta de origen **una sola vez**: bloqueo del renglón, transición condicional `PENDING → CONFIRMED`, `UNIQUE transactionId` e idempotencia por transferencia. Reintentar responde con la misma transferencia.
- **Duplicados**: la referencia bancaria no se asume única globalmente. Si ya hay otra confirmada con la misma cuenta, referencia e importe, la API responde 409 y exige `acknowledgePossibleDuplicate: true` (la pantalla lo pide como segunda confirmación).
- `POST …/reject` con motivo: no genera entrada. Un depósito rechazado devuelve el efectivo a la caja (reverso del traslado).
- Auditoría `BANK_TRANSFER_REGISTERED`, `BANK_TRANSFER_CONFIRMED`, `BANK_TRANSFER_REJECTED`, `BANK_TRANSFER_CANCELLED`.

## 12. Pagos mixtos

`recordPlayerPaymentInTx` (contrato, `src/modules/cash/payment-contracts.ts`) con `splitPayment` (`cash.math.ts`):

- Componentes `CASH`, `BANK_TRANSFER`, `CREDIT`, sin repetir método, cada uno > 0, que suman **exactamente** el importe (ni más ni menos).
- Efectivo → asiento inmediato DEBIT `EFECTIVO` / CREDIT `COBROS_COMPRAS` (o `COBROS_ABONOS`).
- Transferencia → `BankTransferVerification` pendiente (sin asiento).
- Crédito → **ningún asiento**: es deuda del jugador (Módulo 10), no dinero.
- Ejemplo probado: $3,000 = $1,000 efectivo + $1,500 transferencia + $500 crédito → efectivo +$1,000, banco +$0 hasta verificar, crédito $500 sin dinero.

## 13. Gastos operativos prohibidos

- No existe tipo `OTHER_EXPENSE`, categoría genérica, destino de gasto ni formulario "Registrar gasto". Los enums de la base (`CashTransactionType`, `CashWithdrawalDestination`) son catálogos cerrados; una prueba de integración verifica que ningún valor contiene `EXPENSE`/`GASTO`/`OTHER`.
- Defensa complementaria: `looksLikeOperatingExpense` rechaza retiros y traslados cuyo motivo describe un gasto evidente (comida, bebidas, insumos, transporte, servicios…). El control principal es el catálogo cerrado; la heurística no es exhaustiva.
- La pantalla de salida lo indica explícitamente y el E2E comprueba que no hay ningún enlace ni botón de gastos.

## 14. Movimientos inmutables

- `cash_transactions` y `cash_transaction_entries` son de **solo inserción** (triggers rechazan `UPDATE`/`DELETE`).
- Trigger diferido `cash_transaction_entries_balanced`: al `COMMIT`, cada transacción debe cuadrar y tener al menos dos partidas. Aunque el código fallara, la base rechaza un asiento descuadrado.
- `CHECK amount > 0` en partidas. Folio `CASH_MOVEMENT` emitido atómicamente con `issueFolio` dentro de la transacción.

## 15. Reversos

- `POST /api/cash-box/movements/:id/reverse` con motivo: crea un contraasiento (`REVERSAL`) con las partidas invertidas. El original se conserva y queda enlazado (`reversesTransactionId`, `UNIQUE`): **un solo reverso por movimiento**.
- Reversibles desde la caja: aportaciones, retiros ordinarios, transferencias recibidas y ajustes de arqueo. Compras, abonos, liquidaciones y el retiro de cierre se corrigen en su módulo de origen; un depósito se corrige rechazándolo.
- Si toca efectivo, su sesión debe estar abierta y el resultado no puede quedar negativo (revertir una aportación ya retirada se rechaza con el faltante).
- Auditoría `CASH_MOVEMENT_REVERSED`.

## 16. Conciliación

Arqueo de **efectivo** (`CashReconciliation`), independiente del arqueo de fichas:

| Tipo      | Estado de sesión   | Esperado                    | Ajuste       |
| --------- | ------------------ | --------------------------- | ------------ |
| `OPENING` | `PREPARING`        | **$0.00** siempre (`CHECK`) | No permitido |
| `CONTROL` | `OPEN`             | Efectivo del libro          | Sí           |
| `CLOSING` | `OPEN` o `CLOSING` | Efectivo del libro          | Sí           |

- Captura por importe o por desglose de billetes y monedas (`CashReconciliationDetail`); si vienen ambos deben coincidir.
- Contar **no** modifica saldos. Al confirmar se calcula la diferencia; si no es cero, la explicación es obligatoria y queda `PENDING`.
- Si el efectivo cambió desde el conteo (`balanceVersion`), confirmar responde 409: hay que cancelar y recontar.
- Ajuste explícito (`POST …/adjust`, motivo + idempotencia): asiento contra `DIFERENCIAS_ARQUEO`, único (`PENDING → ADJUSTED` + `UNIQUE adjustmentTransactionId`), nunca negativo.
- Un borrador por sesión (índice único parcial). Confirmados inmutables (trigger).
- Auditoría `CASH_RECONCILIATION_CREATED`, `…_CONFIRMED`, `…_ADJUSTED`, `…_CANCELLED`.

## 17. Integración futura con sesiones (Módulo 06)

- `SessionGateway` (`src/modules/cash/session-gateway.ts`) con `getOpenSession()` y `getSession(id)`. Estados esperados: `PREPARING`, `OPEN`, `CLOSING`, `CLOSED`.
- Implementación vigente: `prismaSessionGateway` (Módulo 06). Estados: `DRAFT`, `PREPARATION`, `OPEN`, `CLOSING`, `CLOSED`, `CANCELLED`. El arqueo de efectivo OPENING exige `PREPARATION` y la regla del creador (`assertPreparationAccess`).
- Flujo de apertura (implementado): crear → `PREPARATION` → arqueo de fichas compartido (reutiliza el vigente) → caja `OPENING` en $0.00 (`POST /api/sessions/:id/opening-cash`) → `POST /api/sessions/:id/open` → `OPEN`.
- Los formularios de entrada, salida y arqueo de efectivo se construirán dentro del flujo de sesión; hoy esas pantallas son informativas.

## 18. Integración con compras (Módulo 08, implementada)

- Las compras **no** usan `recordPlayerPaymentInTx` (queda para abonos): cada componente es un `PurchasePayment` y se contabiliza al confirmar la entrega con `postTransactionInTx` y referencia `PurchasePayment` (un asiento por componente, índice `cash_transactions_one_per_origin`). Efectivo: DEBIT `CASH_ON_HAND` (sesión) / CREDIT `PLAYER_PURCHASES`. Tarjeta aprobada: DEBIT `CARD_TERMINAL_CLEARING` / CREDIT `PLAYER_PURCHASES` (no es efectivo).
- Transferencias: `registerPendingBankTransferInTx` con referencia `PurchasePayment` al registrar el pago. `confirmBankTransfer`/`rejectBankTransfer` bloquean primero la compra y aplican el resultado sobre la misma obligación (`purchase-transfer-hook.ts`): rechazan la **sobreaplicación** (409) y, en borradores, crean una nueva versión de la compra.
- **Depósito de terminal** (`card-settlement.service.ts`, `POST /api/cash-box/card-settlements`, pantalla Caja → Terminal): `CARD_TERMINAL_SETTLEMENT` DEBIT `BANK` / CREDIT `CARD_TERMINAL_CLEARING` ligado a los cobros originales (cada uno una sola vez). No reconoce la venta otra vez; una diferencia por comisión queda pendiente de conciliación (sin inventar gastos ni porcentajes). `lockAccountsInTx` pre-bloquea las cuentas de una entrega en orden fijo.

## 19. Integración con créditos (Módulo 10, implementada)

- Los abonos usan `postTransactionInTx` con tipo `DEBT_PAYMENT` y referencia `ReceivablePayment` (asiento único por abono). Efectivo en sesión → `CASH_ON_HAND` de la sesión OPEN; efectivo administrativo → `ADMIN_CASH_CUSTODY` del custodio (nunca una caja de sesión, menos aún cerrada); terminal aprobada → `CARD_TERMINAL_CLEARING`; transferencia → verificación manual existente.
- `confirmBankTransfer` resuelve en dos pasos (`plan` / `finalize`) para compras y abonos: lo aplicable se acredita a la cuenta de origen y el excedente real a `UNAPPLIED_PLAYER_FUNDS` en el mismo asiento; nunca saldo a favor.
- La custodia se deposita al banco como traslado (`CASH_TRANSFER`, custodia − / banco +). La liquidación de terminal acepta también cobros de abonos.
- La apertura de sesión sigue en $0: la custodia es una cuenta separada (aviso de segregación en la preparación).

## 20. Integración futura con liquidaciones

- `recordSettlementPayoutInTx({ settlementId, chipsValue, debtCompensated, … })`: la compensación FIFO **no** mueve efectivo; solo sale el neto (`settlementCashOut`). Si la deuda compensa todo, no hay asiento.
- El neto nunca puede exceder el efectivo disponible (sección 7). Un pago por liquidación es único por liquidación.

## 21. Seguridad

- Capas: Route Handler → `requirePermission` → Zod (`z.strictObject`) → servicio → Prisma. Importes siempre como texto decimal y `Decimal` en la base, nunca `number`.
- CSRF (`assertSameOrigin`) en todas las mutaciones vía `withApiHandler`.
- Datos bancarios solo enmascarados (`maskLast4`); nunca se devuelven números completos. Ningún secreto en auditoría ni en logs.
- Sin endpoints genéricos de escritura: no existe `POST /movements` ni forma de crear un asiento arbitrario.

## 22. Permisos

- Se reutilizan `cash:read` y `cash:operate`, que tienen los tres roles. No se crearon permisos nuevos.
- 401 sin sesión de usuario; 403 con credencial temporal pendiente o sin permiso. Ver `docs/ROLES_AND_PERMISSIONS.md`.

## 23. Idempotencia

- Toda operación que mueve dinero exige `idempotencyKey` (`UNIQUE` en `cash_transactions`) y guarda la huella del contenido (`requestHash`). El reintento se detecta **después** del bloqueo: devuelve el mismo movimiento (`replayed: true`); la misma clave con otros datos responde 409.
- Confirmar o rechazar una transferencia y ajustar un arqueo son idempotentes por estado + claves únicas.
- En pantalla, `useIdempotencyKey` conserva la clave mientras el usuario reintenta y la renueva tras el éxito.

## 24. Concurrencia

- Bloqueo pesimista ordenado: `postTransactionInTx` hace `SELECT … FOR UPDATE` sobre las proyecciones afectadas en orden determinista (sin interbloqueos). Dos retiros simultáneos del mismo efectivo se serializan.
- La fila de saldo se crea con `INSERT … ON CONFLICT DO NOTHING` **sin destino de conflicto**. Una prueba de estrés encontró que con `ON CONFLICT ("accountId","scopeKey")` dos creaciones simultáneas podían chocar primero en la llave primaria (error 23505). Está corregido y la prueba de regresión crea 8 sesiones nuevas con 20 aportaciones simultáneas cada una.
- Transferencias y arqueos: bloqueo del renglón + transición condicional (`updateMany … where status = …`).
- Transacciones con `maxWait` 15 s / `timeout` 20 s (`CASH_TX`).

## 25. Pruebas

- **Unitarias** (`src/modules/cash/cash.test.ts`, 22): aritmética decimal, partida doble, faltante, pagos mixtos, liquidación neta, catálogo sin gastos, heurística, validaciones Zod, gateway sin sesión, permisos de los tres roles y reglas fijas.
- **Integración** (`tests/integration/cash-box.int.test.ts`, 38, PostgreSQL 16 real en Docker): caja única, cuentas idempotentes, política fija, apertura en cero y sin arrastre, aportación y retiro, faltante exacto, concurrencia (retiros simultáneos, ráfagas de aportaciones en sesiones nuevas), atomicidad y cuadre a nivel de base, inmutabilidad, gastos rechazados, 422 sin sesión, transferencias (pendiente ≠ cobro, confirmación única concurrente, tres roles, importe distinto, rechazo, duplicados), banco entre sesiones, depósito y su rechazo, reversos, arqueos (diferencia, ajuste único concurrente, esperado obsoleto, cierre con retiro total), apertura condicionada a arqueos de fichas, ambas mesas en la misma caja, compra no cobrable dos veces, componentes inválidos, liquidación neta, 401/403 y filtros del historial.
- **E2E** (`tests/e2e/cash-box.spec.ts`, Chrome + iPhone): dashboard con «No hay una sesión operativa abierta.», sin gastos, cuentas consultables, 422 sin sesión, 400 para destino de gasto, confirmación y rechazo manual de transferencias de prueba (fixtures de `global-setup`, solo en la base de pruebas), historial y reverso único, diseño móvil sin desplazamiento horizontal, 401 sin sesión.
- Los escenarios que dependen de sesiones usan `fixtureSessionGateway`; **el flujo completo de sesiones no está implementado** (Módulo 06).

## 21. Integración con el Módulo 11 (implementada)

- `recordSettlementPayoutInTx` se rediseñó: **un asiento por desembolso** (`SettlementPayout`, referencia `SettlementPayout`), no un único pago neto por liquidación. Orígenes: `SESSION_CASH` (caja de la sesión OPEN/CLOSING; `PLAYER_SETTLEMENT`), `ADMIN_CUSTODY` (custodia del pagador, sesión cerrada; `PLAYER_SETTLEMENT`) y `BANK` (transferencia saliente verificada manualmente; `BANK_TRANSFER_PAYOUT`, banco −). Siempre `PLAYER_SETTLEMENTS` DEBIT. La compensación de deuda nunca pasa por la caja.
- La custodia administrativa puede recibir **aportaciones documentadas** (`AdministrativeCashContribution`, `CASH_CONTRIBUTION`: custodia + / aportaciones) para pagar liquidaciones después del cierre; nunca se suma a la apertura de una sesión.
- Ninguna cuenta de efectivo queda negativa: un pago mayor al disponible se rechaza con el faltante. Ver `docs/MODULE_11_SETTLEMENTS.md` §14–18.

## 22. Integración con el Módulo 12 (implementada)

- Arqueo de efectivo de cierre contado y confirmado en la transacción del cierre (`recordClosingCashCountInTx`: esperado = libro bajo bloqueo; diferencia con explicación, pendiente). El ajuste genérico rechaza arqueos `CLOSING` (`CLOSING_CASH_VIA_CLOSURE_MESSAGE`): el ajuste excepcional lo autoriza un PARTNER/SUPERADMIN desde el cierre (`adjustCashReconciliationInTx`). Nuevo estado `SUPERSEDED` (recuento o regreso a OPEN, sin ajuste).
- `withdrawAllCashForClosingInTx` admite `expectedAmount` (el retiro debe ser EXACTAMENTE el disponible), `notes` y la referencia al intento de cierre; es idempotente por clave aunque la caja ya esté en $0.
- Durante `CLOSING` no hay pagos en efectivo de la caja de la sesión (liquidaciones): solo arqueo y retiro final.
- Trigger `cash_entries_closed_session_guard`: ninguna partida de `CASH_ON_HAND` en una sesión `CLOSED`/`CANCELLED`. Ver `docs/MODULE_12_CLOSURE.md` §14–17.

## 23. Integración con el Módulo 16 (implementada)

Los pagos especiales (canjes, reembolsos por reverso, correcciones de liquidación, devoluciones de fondos no aplicados) son asientos `PLAYER_SETTLEMENT` (efectivo) o `BANK_TRANSFER_PAYOUT` (transferencia ejecutada) con referencia `SpecialPayout`, uno por pago, por `postTransactionInTx`. Efectivo desde la custodia administrativa del pagador o desde la caja de la sesión de origen solo si está OPEN; nunca una caja cerrada; sin saldo negativo. Ninguna obligación es gasto ni ingreso.
