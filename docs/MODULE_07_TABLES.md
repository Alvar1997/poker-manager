# Módulo 07 — Mesas y participación de jugadores

Código: `src/modules/session-tables/` · API: `src/app/api/sessions/[id]/tables`, `participations`, `table-transfers` · Pantallas: `src/app/(dashboard)/dashboard/sesiones/[id]/mesas/` · Migración: `prisma/migrations/20261021120000_module07_tables/`.

> **Regla prioritaria.** Una sesión abierta permite abrir y reabrir mesas. Un jugador solo está activo en una mesa a la vez. Al transferirlo conserva sus fichas: no se liquida, no paga y no genera movimiento de inventario. Para salir definitivamente necesita una liquidación confirmada. La caja central y el inventario compartido siguen siendo únicos.

## 1. Objetivo

Conectar la sesión (Módulo 06) con las mesas del catálogo (Módulo 02): abrir, cerrar y reabrir mesas con ciclos históricos, registrar participantes, transferirlos entre mesas y dejar preparados los contratos para compras (08), firmas (09), créditos (10), liquidaciones (11) y cierre (12). **No** implementa compras, cobros, entregas de fichas, firmas, créditos, liquidaciones ni WhatsApp.

## 2. Estados de mesa

`SessionTable.status`:

- `PENDING`: la mesa no se ha abierto en la sesión. Si aún no tiene registro, se muestra como PENDING.
- `OPEN`: hay un ciclo vigente; admite participantes y transferencias.
- `CLOSED`: terminó su ciclo actual. **No es irreversible**: puede reabrirse mientras la sesión siga `OPEN`.

Hay una relación por par (sesión, mesa): `UNIQUE(sessionId, tableId)`.

## 3. Ciclos de apertura y cierre

Cada apertura o reapertura crea un `SessionTableCycle` con un consecutivo por mesa (`UNIQUE(sessionTableId, cycleNumber)`), calculado bajo bloqueo. Guarda:

- quién y cuándo abrió y cerró (hora del servidor);
- notas de cierre;
- una **fotografía de ciegas** (`smallBlindSnapshot`/`bigBlindSnapshot`): un cambio posterior en el catálogo no altera el historial.

Los ciclos cerrados son inmutables y no se borran (trigger), y un ciclo cerrado nunca se reabre: reabrir crea otro.

## 4. Participaciones

`TableParticipation` (`ACTIVE`, `TRANSFERRED`, `SETTLING`, `SETTLED`) liga al jugador con la mesa y el ciclo vigente (SETTLING desde el Módulo 11: fichas recibidas y pago pendiente, sin silla):

- Hora de ingreso y responsable los fija el servidor.
- Solo jugadores activos (`assertPlayerSelectable`).
- No genera compra, entrega de fichas, crédito ni cobro (PART-12…15).
- Nunca se borra ni se reutiliza: volver tras liquidar o llegar por transferencia crea otra participación (PART-17/18/19).
- Un trigger impide cambiar el jugador, la mesa, el ciclo o el ingreso, y vuelve inmutable una participación finalizada.

## 5. Una mesa activa por jugador

Índice único parcial:

```sql
CREATE UNIQUE INDEX "table_participations_one_active_per_player"
  ON "table_participations" ("sessionId", "playerId") WHERE "status" = 'ACTIVE';
```

Un jugador nunca está activo en 25/25 y 10/10 a la vez, ni dos veces en la misma mesa. Si ya está activo en otra mesa la API responde 409: «Este jugador ya se encuentra activo en la Mesa 10/10. Utiliza la opción Cambiar de mesa.» Probado con 4 altas simultáneas en ambas mesas.

## 6. Reaperturas

`POST …/tables/:tableId/open` sobre una mesa `CLOSED` crea el ciclo N+1:

- conserva los anteriores;
- no copia jugadores ni compras;
- no exige otro arqueo;
- no mueve dinero ni fichas.

Solo se permite con la sesión `OPEN` (no en `CLOSING`/`CLOSED`).

## 7. Transferencias

`POST /api/sessions/:id/table-transfers` con `sourceParticipationId`, `destinationTableId`, `notes?` e `idempotencyKey`. El servidor deriva jugador, sesión, mesas y ciclos. En **una transacción**:

1. Bloquea la sesión (`FOR SHARE`).
2. Bloquea ambas mesas en orden fijo (`FOR UPDATE`).
3. Bloquea la participación de origen.
4. Valida que ambas mesas estén abiertas y sean distintas.
5. Cierra el origen como `TRANSFERRED`.
6. Crea la participación destino `ACTIVE` con `sourceParticipationId`.
7. Registra `TableTransfer`.

Nunca quedan origen y destino ACTIVE a la vez (TRANSFER-26).

La transferencia no exige liquidación ni conteo, no registra valor de fichas, no genera `CHIP_DELIVERY`/`CHIP_RETURN`, compra, crédito, cobro ni pago, y no toca caja ni inventario (TRANSFER-08…19). Las compras históricas conservan su mesa; las futuras usan la participación destino (TRANSFER-20/21).

## 8. Fichas compartidas

Las mesas no tienen inventario propio: todas consumen y devuelven el **mismo** saldo nominal del inventario compartido (Módulo 04). Por eso cambiar de mesa no requiere conversión ni conteo.

## 9. Caja central única

Las mesas no tienen caja propia. Sus operaciones se atribuyen a la mesa (para reportes) dentro de la caja central `MAIN`. Las pantallas de mesas no muestran saldos financieros por mesa.

## 10. Salida definitiva mediante liquidación

`SETTLED` solo se alcanza con `completeParticipationFromSettlementInTx(tx, actor, { participationId, settlementId }, verifier)`. El `SettlementVerifier` lo aportará el Módulo 11 y debe validar que la liquidación esté confirmada, sea del jugador y no se haya usado antes; `settlementId` es `UNIQUE` y además hay un CHECK (`SETTLED ⇒ settlementId`). Por defecto el verificador **rechaza**: «El retiro definitivo requiere una liquidación confirmada». No existe ningún endpoint que marque SETTLED y no se inventan liquidaciones.

## 11. Permisos

SUPERADMIN, PARTNER y CASHIER consultan (`sessions:read`) y operan mesas, participantes y transferencias (`sessions:manage`) sin autorización adicional. La regla del creador del Módulo 06 **no** aplica a la operación de mesas. El teléfono del jugador solo se muestra con `players:read`.

## 12. Endpoints

| Método   | Ruta                                                          |
| -------- | ------------------------------------------------------------- |
| GET      | `/api/sessions/:id/tables`                                    |
| GET      | `/api/sessions/:id/tables/:tableId`                           |
| POST     | `/api/sessions/:id/tables/:tableId/open` (abre o reabre)      |
| POST     | `/api/sessions/:id/tables/:tableId/close`                     |
| GET      | `/api/sessions/:id/tables/:tableId/cycles`                    |
| GET/POST | `/api/sessions/:id/tables/:tableId/players`                   |
| GET      | `/api/sessions/:id/tables/:tableId/history` (cycle, from, to) |
| GET      | `/api/sessions/:id/participations` (status, tableId)          |
| GET      | `/api/sessions/:id/participations/:participationId`           |
| GET/POST | `/api/sessions/:id/table-transfers`                           |

`:tableId` es el id de la mesa del catálogo. Todas las rutas autentican, autorizan, validan con Zod (`strictObject`), auditan y usan transacciones.

## 13. Modelos

`SessionTable`, `SessionTableCycle`, `TableParticipation` y `TableTransfer`, que reutilizan `PokerSession`, `PokerTable`, `Player`, `User` y `AuditLog`. Las FK compuestas `(id, sessionId)` y `(id, sessionTableId)` impiden referencias cruzadas entre sesiones o ciclos de otra mesa.

## 14. Restricciones PostgreSQL

- `UNIQUE(sessionId, tableId)`, `UNIQUE(sessionTableId, cycleNumber)`.
- `session_table_cycles_one_open`: un solo ciclo OPEN por mesa (índice parcial).
- `table_participations_one_active_per_player`: una participación ACTIVE por jugador y sesión.
- `UNIQUE` en `openIdempotencyKey`, `closeIdempotencyKey`, `idempotencyKey` (participación y transferencia), `settlementId`, `sourceParticipationId` y en los dos extremos de la transferencia.
- CHECK: ciclo ≥ 1, ciegas válidas, CLOSED con cierre registrado, participación finalizada con salida registrada, `SETTLED ⇒ settlementId`, transferencia con mesas y participaciones distintas.
- Triggers: sin DELETE en mesas, ciclos y participaciones; ciclos cerrados y participaciones finalizadas inmutables; transferencias de solo inserción.

## 15. Concurrencia

- Sesión con `FOR SHARE`, para que no pueda pasar a cierre a mitad de una operación.
- Mesa con `FOR UPDATE`: cerrar y agregar jugador se serializan, y nunca se cierra una mesa que terminó con participantes.
- Transferencias: ambas mesas en orden fijo, más la participación.
- Respaldo de los índices parciales.

Probado: aperturas y reaperturas simultáneas (un ciclo), altas simultáneas (una activa), transferencias simultáneas del mismo jugador a mesas distintas (una gana).

## 16. Idempotencia

Abrir, cerrar, registrar y transferir reciben `idempotencyKey`. El reintento, incluso simultáneo, se detecta **después** del bloqueo y devuelve el mismo resultado (`replayed`). Una clave reutilizada para otra operación responde 409.

## 17. Auditoría

`SESSION_TABLE_OPENED`, `SESSION_TABLE_REOPENED`, `SESSION_TABLE_CYCLE_CREATED`, `SESSION_TABLE_CLOSED`, `TABLE_PLAYER_JOINED`, `TABLE_PLAYER_TRANSFERRED` y `TABLE_PARTICIPATION_SETTLED` (este último solo con liquidación real), dentro de la misma transacción. Los eventos de catálogo siguen siendo `TABLE_*` del Módulo 02.

## 18. Pantallas

- `/sesiones/[id]/mesas`: tablero 25/25 y 10/10 con estado, ciclo, jugadores activos, última apertura y cierre, y acción Abrir, Cerrar o Reabrir (el cierre pide confirmación).
- `/sesiones/[id]/mesas/[tableId]`: ciegas, estado, ciclo actual, hora, responsable y accesos.
- `…/jugadores`: participantes activos, alta por búsqueda del directorio del Módulo 03 (TanStack Query) y «Cambiar de mesa» con el aviso de que no hay movimientos de dinero ni de fichas. La liquidación aparece como no disponible hasta el Módulo 11.
- `…/historial`: ciclos y eventos (ingresos, transferencias de entrada y salida, salidas liquidadas), con filtros por ciclo y fecha.

## 19. Pruebas

- **Unitarias** (`src/modules/sessions/session.test.ts`): schemas de abrir, cerrar, registrar, transferir e historial (rechazan fechas, responsables, estados, ciclos, fichas e importes).
- **Integración** (`tests/integration/session-tables.int.test.ts`, 23 pruebas en PostgreSQL real con una sesión abierta por el flujo del Módulo 06): apertura sin efectos, ambas mesas, rechazo en PREPARATION y CLOSING, cierre y reapertura con ciclos conservados e inmutables, concurrencia de aperturas, idempotencia, alta sin efectos, inactivos, mesa cerrada, duplicados y altas simultáneas, campos del cliente rechazados, transferencia atómica sin efectos con historial, reglas de transferencia, cierre bloqueado por activos, transferencias simultáneas, reintentos, deudas intactas, salida SETTLED bloqueada (servicio y base), contrato con verificador, contrato de compras, permisos, 401/403.
- **E2E** (`tests/e2e/session-tables.spec.ts`, Chrome + iPhone): abrir 25/25, agregar jugador, abrir 10/10, rechazo del mismo jugador en ambas, transferencia con aviso, nueva ubicación e historial, cierre bloqueado con activos, cierre de mesa vacía, reapertura con ciclo 2 y ciclos anteriores, sin importes ficticios, diseño móvil.

## 20. Integraciones futuras

- **08 Compras (implementado):** `validateParticipationForPurchase` se usa al crear el borrador y otra vez al confirmar, con la participación bloqueada `FOR UPDATE` (un cambio de mesa simultáneo espera o hace fallar la entrega). La compra guarda participación, mesa y ciclo y los conserva tras transferencias; la numeración de recompras continúa entre mesas. Pantalla de participantes: botón **«Nueva compra»** por jugador; detalle de mesa: enlace **Compras** (`/sesiones/[id]/mesas/[tableId]/compras`).
- **09 Firmas:** ligadas a la compra o entrega; registrar a un jugador no exige firma.
- **10 Créditos:** las deudas pertenecen al jugador y conservan su origen (compra, sesión, mesa). La transferencia no las mueve ni las cancela.
- **11 Liquidaciones (implementado):** `markParticipationSettlingInTx` (ACTIVE → SETTLING) y `completeParticipationFromSettlementInTx` (ACTIVE/SETTLING → SETTLED) con el verificador real `settlementVerifier`; con liquidación en curso no hay compras ni transferencias (`activeSettlementOf`); un jugador SETTLING no reingresa en la sesión (servicio con bloqueo del jugador + trigger); la mesa cierra con participaciones SETTLING. Pantalla de jugadores: botón **«Liquidar jugador»**. Ver `docs/MODULE_11_SETTLEMENTS.md` §20–22.
- **12 Cierre (implementado):** cerrar un ciclo exige además que no haya compras del ciclo sin entrega resuelta ni liquidaciones sin recepción (las SETTLING sí pueden quedar), y registra `TABLE_CYCLE_CLOSED` con la actividad ATRIBUIDA del ciclo (`getCycleActivitySummary`), sin calcular un resultado neto por mesa. En `CLOSING` no se abren ciclos ni se registran o transfieren jugadores; el regreso a OPEN no reabre ciclos cerrados (abrir la mesa crea un ciclo nuevo). Ver `docs/MODULE_12_CLOSURE.md` §1.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

Asientos (`TableSeatAssignment`, 1..9 por ciclo) y dealer por ciclo (`DealerAssignment`). `addPlayerToTable` acepta `seatNumber` y `transferPlayer` acepta `destinationSeatNumber` (opcionales, en la misma transacción). Toda salida de ACTIVE (transferencia, liquidación, retiro) libera el asiento antes de cambiar el estado; cerrar un ciclo libera al dealer. Nuevo estado `WITHDRAWN` (retiro sin compra, solo si nunca recibió fichas). Los eventos `TABLE_PLAYER_JOINED` y `TABLE_PLAYER_TRANSFERRED` incluyen `sessionId` y `cycleId`.

## Integración con el Módulo 17

Módulo 17: una participación con jugada financiada sale SETTLED por `completeParticipationFromBankingGameInTx` (con `bankingGameId`, sin liquidación ordinaria) y libera su asiento. La mesa no muestra ninguna señal del bancaje; cambiar de mesa no crea otra jugada.

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
