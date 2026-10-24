# Módulo 04 — Inventario físico de fichas

> **UN INVENTARIO FÍSICO COMPARTIDO + DOS MESAS OPERATIVAS + UNA CAJA FINANCIERA CENTRAL.** Este módulo se entregó originalmente con un juego y un maletín por mesa; esa decisión **quedó cancelada** por la corrección arquitectónica previa al Módulo 06 (sección 21). Este documento describe el modelo vigente.

## 1. Objetivo

Saber en todo momento cuántas fichas físicas existen en el inventario común de ambas mesas, de qué denominación son y cuántas están disponibles, reservadas, en circulación o retiradas. También quién movió cada ficha, cuándo y por qué, y qué diferencias hay entre lo esperado y lo contado. El inventario persiste entre sesiones.

> **Las fichas no son dinero.** Nada de este módulo toca la caja financiera: el valor nominal es informativo y nunca se suma al efectivo. No hay compras, créditos ni liquidaciones.

## 2. Catálogos reutilizados (Módulo 02)

`ChipSet` (el inventario único `CHIPSET_MAIN`; los antiguos `CHIPSET_25_25` y `CHIPSET_10_10` quedan inactivos como historial), `ChipDenomination` (valores y colores), `PokerTable` y `User`/`AuditLog`. No se duplicó ningún modelo ni se agregó stock al catálogo.

Este módulo hace cumplir dos reglas que el Módulo 02 dejó pendientes:

- **DEN-11:** no se puede cambiar el valor de una denominación con movimientos o arqueos.
- **Inventario con fichas:** no se puede desactivar un inventario que tiene fichas en custodia o en circulación.

## 3. Contenedores (`ChipContainer`)

| Código               | Nombre             | Inventario      | Estado               |
| -------------------- | ------------------ | --------------- | -------------------- |
| `INVENTARIO-GENERAL` | Inventario general | `CHIPSET_MAIN`  | Activo               |
| `MALETIN-25-25`      | Maletín Mesa 25/25 | `CHIPSET_25_25` | Inactivo (historial) |
| `MALETIN-10-10`      | Maletín Mesa 10/10 | `CHIPSET_10_10` | Inactivo (historial) |

- Una sola ubicación física real (`INVENTARIO-GENERAL`), sembrada de forma idempotente (`src/modules/inventory/inventory.seed.ts`), **sin cantidades**. No hay contenedores por mesa.
- **CON-03/04:** un contenedor pertenece a un solo juego. Las FK compuestas `(chipSetId, containerId)` impiden en la base que tenga fichas de otro juego.
- **CON-08:** índice único parcial: un solo contenedor principal activo por juego.
- **CON-06/07/09:** no hay endpoints para crear, borrar ni desactivar maletines (solo `GET /api/chip-containers`). La estructura permite agregar más contenedores después.
- **CON-10:** cada movimiento guarda una copia del código del maletín (`containerCode`).

## 4. Modelo de existencias

| Concepto          | Dónde vive                                    | Fórmula / regla                                                |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Bajo custodia     | `ChipInventoryBalance` con `location=CUSTODY` | Fichas físicamente en el maletín (incluye reservadas)          |
| Reservadas        | `reserved` de la fila `CUSTODY`               | `0 ≤ reserved ≤ quantity` (CHECK)                              |
| Disponibles       | Calculado                                     | **custodia − reservadas**                                      |
| En circulación    | Fila `location=CIRCULATION`                   | Con jugadores; nunca disponibles                               |
| Retiradas         | Fila `location=RETIRED`                       | Bajas definitivas; fuera del inventario activo                 |
| Inventario activo | Calculado                                     | **custodia + circulación** (las reservadas no se suman aparte) |

- Una fila por **(maletín, denominación, ubicación)** (`UNIQUE`, BAL-02/03), con `quantity ≥ 0` (CHECK, BAL-01).
- La tabla es una **proyección**: solo la escriben los servicios, en la misma transacción que el movimiento (BAL-04/05/06). La **fuente auditable es el libro**, y las pruebas reconstruyen la custodia desde los movimientos (MOV-15).
- `ChipSetInventoryState` (uno por juego) guarda `version`, `initializedAt` e `initialCountId`, y es el **renglón de bloqueo** de la sección 9.

## 5. Movimientos (`ChipInventoryOperation` + `ChipInventoryMovement`)

- **Operación** (encabezado, una por solicitud): tipo, juego, maletín, `idempotencyKey` **única**, huella del contenido (`requestHash`), motivo, notas, causa de baja o tipo de ajuste, referencia (`referenceType/Id`, `stockCountId`) y usuario.
- **Movimiento** (una línea por denominación): `movementType`, `quantity > 0`, `fromLocation` → `toLocation` (`null` = fuera del inventario), `custodyBefore`/`custodyAfter`, valor nominal unitario copiado, motivo, referencia, usuario y fecha del servidor.
- **Inmutables** (MOV-04/05/06): triggers rechazan `UPDATE`/`DELETE` en operaciones y movimientos, y no existe ningún endpoint de borrado. Un error se corrige con un **ajuste** nuevo (MOV-07).

| Tipo                   | Origen → destino       | Implementado                              |
| ---------------------- | ---------------------- | ----------------------------------------- |
| `INITIAL_STOCK`        | — → custodia           | Sí                                        |
| `STOCK_ENTRY`          | — → custodia           | Sí                                        |
| `STOCK_WITHDRAWAL`     | custodia → retiradas   | Sí                                        |
| `INVENTORY_ADJUSTMENT` | — ↔ custodia           | Sí (ajustes y conciliación)               |
| `CHIP_DELIVERY`        | custodia → circulación | Servicio interno (consumo de reserva)     |
| `CHIP_RETURN`          | circulación → custodia | Servicio interno                          |
| `INTERNAL_TRANSFER`    | custodia → custodia    | Solo el tipo (hoy hay una sola ubicación) |
| `CHIP_CONVERSION`      | —                      | Ya no aplica (inventario compartido)      |
| `REVERSAL`             | —                      | Reservado; hoy se corrige con ajustes     |

## 6. Inventario inicial

Es un arqueo de tipo `INITIAL` que, al confirmarse, crea las existencias:

- **INI-01/07:** una sola vez para el inventario común. Lo garantizan `initializedAt` bajo bloqueo y un índice único parcial (un `INITIAL` confirmado por inventario). Probado con 4 solicitudes simultáneas: una crea el inventario y las otras tres reciben 422.
- **INI-02/03/04:** todas las denominaciones activas, con enteros ≥ 0 (0 está permitido).
- **INI-05:** se puede guardar como borrador (`POST /counts` con `countType: INITIAL` y `PATCH /counts/:id`). `POST /initial-stock` captura y confirma en un paso, y reutiliza el borrador si existe.
- **INI-06/08/09/14:** transaccional, inmutable (trigger), con correcciones solo por ajuste; guarda usuario y fecha.
- **INI-10/11:** sin seed de cantidades. Un juego inactivo no se inicializa ni se cuenta.
- Las demás operaciones (entradas, bajas, ajustes, arqueos de control) exigen inventario inicializado.

## 7. Entradas (`POST /api/chip-inventory/entries`)

Una o varias denominaciones en una operación atómica. Cantidades > 0, juego y denominación activos y del mismo juego, y motivo obligatorio (ENT-01…07). No genera ingresos de caja (ENT-08) y es idempotente (ENT-09).

## 8. Bajas (`POST /api/chip-inventory/withdrawals`)

Mueve fichas de custodia a retiradas. Exige causa (`DAMAGE`, `CONFIRMED_LOSS`, `PERMANENT_RETIREMENT` u `OTHER`) y motivo. **Solo descuenta fichas disponibles:** nunca reservadas ni en circulación (BAJ-03/04/10). No es un gasto (BAJ-08/09). Si una línea no alcanza, **no se aplica ninguna** (transacción).

## 9. Ajustes (`POST /api/chip-inventory/adjustments`)

- Tipos `SHORTAGE` (faltante, resta), `SURPLUS` (sobrante, suma) y `CORRECTION` (con dirección `INCREASE`/`DECREASE` obligatoria).
- **Los tres roles** (SUPERADMIN, PARTNER, CASHIER) ajustan **sin aprobación adicional**; quien registra confirma (AJU-01/02).
- **Motivo obligatorio** (AJU-03). Guarda la existencia anterior y la resultante (`custodyBefore`/`custodyAfter`, AJU-06/07).
- Nunca deja existencias negativas ni toca las reservadas (AJU-05).
- La UI muestra un resumen antes → después y pide confirmación (AJU-13).

## 10. Arqueos (`ChipStockCount` + `ChipStockCountDetail`)

Motor **único** con tipos `INITIAL`, `OPENING`, `CONTROL` y `CLOSING`. El módulo de sesiones llamará a `createStockCount`/`confirmStockCount` con `sessionId` para apertura y cierre; la API pública solo crea `CONTROL` e `INITIAL`.

- **Esperado = fichas bajo custodia**, incluidas las reservadas presentes (ARQ-18) y **sin** las que están en circulación (ARQ-19). Incluye denominaciones inactivas con fichas (ARQ-03).
- **Borrador:** se guarda sin tocar el inventario (REC-01/02). Un solo borrador por juego (índice único parcial).
- **Esperado obsoleto (ARQ-16/17):** el arqueo guarda la `inventoryVersion`. Si las existencias cambiaron, confirmar responde **409**. "Actualizar esperado" recalcula y **borra lo contado en las denominaciones cuyo esperado cambió**, para obligar a verificar de nuevo.
- **Confirmar** calcula en el servidor las diferencias por denominación y los totales nominales, y deja un **snapshot inmutable** protegido con triggers (ARQ-11/20). **No ajusta el inventario** (ARQ-12).
- **ARQ-07:** "cuadrado" exige cero diferencias en **cada** denominación. Un total nominal de $0 con diferencias compensadas queda con diferencias pendientes (probado).
- El estado del arqueo (`DRAFT`/`CONFIRMED`/`CANCELLED`) es independiente del estado de sus diferencias (`NOT_REQUIRED`/`PENDING`/`RECONCILED`).

## 11. Conciliación (`POST /api/chip-inventory/counts/:id/reconcile`)

- Explícita, con **motivo obligatorio** (ARQ-13/14), y transaccional.
- Genera una operación `COUNT_RECONCILIATION` con un movimiento `INVENTORY_ADJUSTMENT` por denominación con diferencia, ligado al arqueo (`stockCountId`, `referenceId`, AJU-14, REC-07).
- **Una sola vez** (ARQ-15, REC-05, AJU-15): la transición condicional `PENDING → RECONCILED` y el `UNIQUE` de `reconciliationOperationId` lo garantizan. Una segunda solicitud, simultánea o posterior, devuelve la conciliación existente sin mover fichas (probado).

## 12. Reservas (`ChipReservation` + `ChipReservationItem`) — infraestructura interna

**Por importe nominal (sección 22):** `reserveNominalAmount`, `releaseNominalReservation`, `confirmNominalChipDelivery`, `confirmNominalChipReturn` y `expireReservations` (`src/modules/inventory/reservation.service.ts`), cada una con su variante `…InTx`. Las reservas por denominación originales se sustituyeron (no tenían datos reales); `ChipReservationItem` se conserva solo como historial.

- Reducen la disponibilidad, no la custodia, y nunca reservan más de lo disponible (RES-01/02; probado con 5 reservas simultáneas).
- Cada reserva va asociada a una operación (`referenceType/Id`, una activa por referencia, RES-03) y no genera cobros (RES-04).
- Consumir pasa las fichas a circulación (`CHIP_DELIVERY`) una sola vez; liberar o vencer devuelve la disponibilidad. Las transiciones son condicionales (RES-05…10).
- **No hay endpoints públicos** ni reservas artificiales. Las crea el módulo de compras.

## 13. Circulación

Las fichas en circulación no están en custodia ni disponibles, pero forman parte del inventario activo. Solo entran por la entrega confirmada de una reserva y salen por `confirmNominalChipReturn` (devolución física), siempre por **importe**, ambas con operación de origen e idempotencia (CIR-01…07). Las reservas, entregas y devoluciones guardan `tableId`, `sessionId` y `playerId` (CIR-08) solo como trazabilidad.

**Cambio de mesa:** un jugador que cambia de mesa conserva las mismas fichas; no hay conversión física (`CHIP_CONVERSION` ya no aplica). La participación del jugador y sus registros financieros sí se actualizarán a la nueva mesa en los módulos de sesiones y compras.

## 14. Permisos

Se reutilizaron los permisos existentes:

| Permiso           | SUPERADMIN | PARTNER | CASHIER | Uso                                                              |
| ----------------- | :--------: | :-----: | :-----: | ---------------------------------------------------------------- |
| `chips:read`      |     ✅     |   ✅    |   ✅    | Inventario, maletines, movimientos, arqueos                      |
| `chips:operate`   |     ✅     |   ✅    |   ✅    | Inicial, entradas, bajas, ajustes, arqueos, confirmar, conciliar |
| `settings:manage` |     ✅     |    —    |    —    | (Módulo 02) catálogo de denominaciones                           |

Ningún rol puede borrar ni editar movimientos confirmados: no existe el endpoint y la base lo impide.

## 15. Endpoints

| Método | Ruta                                       | Permiso         |
| ------ | ------------------------------------------ | --------------- |
| GET    | `/api/chip-inventory`                      | `chips:read`    |
| GET    | `/api/chip-inventory/:chipSetId`           | `chips:read`    |
| GET    | `/api/chip-containers`                     | `chips:read`    |
| GET    | `/api/chip-inventory/movements`            | `chips:read`    |
| POST   | `/api/chip-inventory/initial-stock`        | `chips:operate` |
| POST   | `/api/chip-inventory/entries`              | `chips:operate` |
| POST   | `/api/chip-inventory/withdrawals`          | `chips:operate` |
| POST   | `/api/chip-inventory/adjustments`          | `chips:operate` |
| GET    | `/api/chip-inventory/counts`               | `chips:read`    |
| POST   | `/api/chip-inventory/counts`               | `chips:operate` |
| GET    | `/api/chip-inventory/counts/:id`           | `chips:read`    |
| PATCH  | `/api/chip-inventory/counts/:id`           | `chips:operate` |
| POST   | `/api/chip-inventory/counts/:id/confirm`   | `chips:operate` |
| POST   | `/api/chip-inventory/counts/:id/reconcile` | `chips:operate` |
| POST   | `/api/chip-inventory/counts/:id/cancel`    | `chips:operate` |

`PATCH /counts/:id` (captura y actualización del esperado) y `POST /counts/:id/cancel` se agregaron porque la captura en borrador y la cancelación los necesitan. El historial admite `chipSetId`, `tableId` (solo filtra: el stock es común), `type`, `denominationId`, `userId`, `from`, `to`, `page` y `pageSize ≤ 100`.

**Pantallas** (`/dashboard/inventario/fichas/*`; `/inventario/*` redirige): tablero del inventario común (una sola tarjeta), detalle del inventario, inventario inicial, entrada, baja, ajustes, movimientos, arqueos, nuevo arqueo y captura/conciliación de un arqueo. Incluyen teclado numérico, resumen antes de confirmar, skeleton, error y estados vacíos.

**Auditoría:** `CHIP_INITIAL_STOCK_CREATED`, `CHIP_STOCK_ENTRY`, `CHIP_STOCK_WITHDRAWAL`, `CHIP_INVENTORY_ADJUSTED`, `CHIP_COUNT_CREATED/CONFIRMED/CANCELLED/RECONCILED`, `CHIP_RESERVATION_CREATED/RELEASED/CONSUMED/EXPIRED` y `CHIP_RETURN_RECORDED`, dentro de la misma transacción que cada cambio.

## 16. Modelos Prisma

`ChipContainer`, `ChipSetInventoryState`, `ChipInventoryBalance`, `ChipInventoryOperation`, `ChipInventoryMovement`, `ChipStockCount`, `ChipStockCountDetail`, `ChipReservation` y `ChipReservationItem`. Enums: `ChipLocation`, `ChipOperationType`, `ChipMovementType`, `ChipWithdrawalCategory`, `ChipAdjustmentKind`, `ChipCountType`, `ChipCountStatus`, `ChipReconciliationStatus` y `ChipReservationStatus`.

**Migración `20261016120000_module04_chip_inventory`** (aditiva; en tablas existentes solo agrega el índice único `(chipSetId, id)` en `chip_denominations`):

- Llaves foráneas compuestas para no mezclar juegos.
- `CHECK` de cantidades y reservas.
- Índices únicos parciales: un maletín principal por juego, un borrador por juego, un `INITIAL` confirmado por juego y una reserva activa por referencia.
- Triggers de inmutabilidad en operaciones, movimientos, arqueos confirmados y renglones de reserva.

## 17. Reglas de concurrencia

1. **Bloqueo del inventario:** cada operación toma `SELECT … FOR UPDATE` sobre `chip_set_inventory_states`. Hay un solo inventario, así que las operaciones de **ambas mesas** se **serializan** entre sí y nunca entregan las mismas fichas disponibles. Leer, validar y escribir ocurre dentro del bloqueo.
2. **Respaldo en la base:** si un bug saltara la validación, los `CHECK` y las FK compuestas abortan la transacción completa.
3. **Transiciones condicionales:** `updateMany … WHERE status = 'ACTIVE'/'PENDING'` y llaves `UNIQUE` (`reconciliationOperationId`, `consumeOperationId`).
4. **Versión de inventario:** detecta arqueos con esperado obsoleto.
5. Margen de transacción de 15 s de espera y 20 s de duración, porque todas las operaciones se serializan.

**Probado en PostgreSQL 16 real**, con varias conexiones y bloqueos reales: 8 entradas simultáneas sin pérdidas, retiros simultáneos de 40 y 30 sobre 50 (uno pasa, el otro 422, nunca negativo), 4 inicializaciones simultáneas, 5 reservas simultáneas, dos consumos y dos conciliaciones simultáneas. Las tres corridas seguidas pasaron.

## 18. Idempotencia

- Toda operación que mueve inventario exige `idempotencyKey`. La genera la UI una vez por intento lógico (`useIdempotencyKey`) y la renueva tras un éxito.
- **En la base:** `chip_inventory_operations.idempotencyKey` es `UNIQUE`. El reintento se detecta **después** de tomar el bloqueo y responde la operación original con `replayed: true` (MOV-13, BAL-09).
- Misma clave con contenido distinto (`requestHash`) → **409**.
- Confirmar y conciliar son idempotentes por transición de estado: un segundo intento devuelve el resultado existente. Reservas, consumos y devoluciones tienen su propia clave única.

## 19. Pruebas

- **Unitarias** (`src/modules/inventory/inventory.test.ts`): identidad (juego, denominación, maletín), enteros, negativos, fracciones, valor nominal exacto con Decimal, validaciones de inicial, entradas, bajas y ajustes, disponibilidad, reservas y circulación, diferencias, ARQ-07, conciliación, huella de idempotencia y permisos.
- **Integración** (`tests/integration/chip-inventory.int.test.ts`, **41 pruebas sobre PostgreSQL 16 real**; 5 del inventario compartido): los 23 casos pedidos, incluidas las pruebas de concurrencia de la sección 17, la reconstrucción de saldos desde el libro y la inmutabilidad en la base.
- **E2E** (`tests/e2e/chip-inventory.spec.ts`, Chrome + iPhone, sobre el MISMO inventario): tablero con una sola tarjeta de inventario, inicial, entrada, baja, ajuste con motivo obligatorio y antes/después, historial con usuario y motivo, arqueo con diferencia, confirmación, conciliación, inventario actualizado, permisos y ausencia de scroll horizontal.
- **Base de pruebas:** el contenedor `postgres:16.4-alpine` (`npm run test:db:up`). `prisma dev` (PGlite) atiende una sola sesión y **no** sirve para las pruebas de concurrencia (ver `docs/SETUP.md`).

## 20. Integraciones futuras

- **Sesiones:** un solo arqueo general del inventario común: `createStockCount(actor, { chipSetId: <inventario activo>, countType: "OPENING" | "CLOSING" }, { sessionId })` y `confirmStockCount`. La caja lo verifica con `assertOpeningReady({ sessionId })`. Las sesiones deben guardar su propia copia de ciegas.
- **Compras (por importe):** dentro de la transacción de la compra, `reserveNominalAmountInTx` (inventario compartido; con `tableId`, `sessionId`, `playerId`), luego `confirmNominalChipDeliveryInTx` o `releaseNominalReservationInTx`. Una compra nunca registra `CHIP_DELIVERY` fuera de su reserva ni guarda desglose por denominación.
- **Liquidaciones (Módulo 11, integrado):** `confirmNominalChipReturnInTx` por importe, con referencia `PlayerSettlement` y clave idempotente por liquidación (`settlement-return-<id>`): una sola entrada nominal por liquidación, nunca un movimiento de $0. El reverso de una liquidación regresa el valor a circulación con reserva + entrega nominal solo si el cajero devolvió físicamente las fichas.
- **Caja (Módulo 05):** ningún movimiento de fichas genera dinero. La caja tendrá su propio libro.
- `expireReservations()`: sin cron todavía; el Módulo 08 lo ejecuta antes de crear o apartar una compra, de modo que un apartado vencido (15 min) se libera.
- **Módulo 08 (implementado):** las compras usan exactamente estos contratos dentro de su transacción; la entrega registra un solo `CHIP_DELIVERY` nominal con referencia `ChipPurchase` y nunca movimientos por denominación.

## 21. Inventario compartido (corrección previa al Módulo 06)

**Regla definitiva:** existe un único inventario físico; las mesas 25/25 y 10/10 comparten las mismas fichas, con denominaciones y existencias comunes. Una sola caja financiera para ambas mesas.

- **Modelo:** se conserva `ChipSet` por compatibilidad, con un solo juego activo (`CHIPSET_MAIN`, «Inventario General de Fichas»), garantizado por el índice único parcial `chip_sets_single_active`. Ambas mesas apuntan a él. Una ubicación física (`INVENTARIO-GENERAL`); no hay contenedores por mesa.
- **Stock global:** compras de ambas mesas consumen el mismo saldo por denominación; devoluciones regresan al mismo saldo; reservas globales (disponible = custodia − reservadas, sin doble conteo). `sharedChipSetId()` resuelve el inventario cuando una operación no indica juego.
- **Trazabilidad:** `chip_inventory_operations`, `chip_inventory_movements` y `chip_reservations` guardan `tableId` (FK a mesa), `sessionId` y `playerId` (FK a jugador). Solo trazan el origen y permiten filtrar el historial por mesa; nunca separan existencias.
- **Concurrencia:** el bloqueo del inventario serializa a las dos mesas (probado: 8 reservas simultáneas de 10 fichas, alternando mesas, sobre 50 disponibles → exactamente 5 pasan).
- **Apertura:** un arqueo general vigente del inventario común (no dos).
- **Migración `20261018120000_shared_chip_inventory`:** aditiva y no destructiva. Se **detiene** si los juegos por mesa tuvieran operaciones, arqueos, reservas o existencias (no suma inventarios que podrían estar contados dos veces). Desactiva juegos, maletines y denominaciones anteriores (sin borrarlos), crea `CHIPSET_MAIN` + `INVENTARIO-GENERAL`, reasigna las mesas y registra `CHIP_INVENTORY_CONSOLIDATED` en `audit_logs` con las denominaciones previas.
- **Datos en Neon al migrar:** 0 existencias, 0 movimientos, 0 arqueos, 0 reservas. Las denominaciones capturadas por juego eran 25 Verde, 100 Gris y 500 Morada (25/25) y 10 Verde, 100 Rojo y 500 Morada (10/10). **No se fusionaron** porque el valor 100 tenía dos colores (y el verde se usaba para 25 y para 10): requieren conciliación física y **captura del catálogo real del inventario común** en Configuración → Inventario de fichas antes del inventario inicial.

## 22. Inventario por valor nominal (corrección previa al Módulo 08)

**Regla permanente:** las compras y recompras se capturan **únicamente por importe nominal**. No se exige ni almacena desglose por denominación en cada entrega. El inventario operativo usa un **saldo nominal compartido**; las cantidades físicas por denominación se verifican en los arqueos.

**Modelo de control.** Hay dos registros separados:

- **Saldo nominal** (fuente de verdad para disponibilidad), en `chip_set_inventory_states`:
  - `custodyNominal`: valor bajo custodia, incluido lo reservado;
  - `reservedNominal`: apartado por compras en borrador;
  - `circulationNominal`: entregado a jugadores.
  - Disponible = custodia − reservado. Un CHECK impide negativos y que lo reservado supere la custodia.
  - Cada cambio queda en el libro inmutable `chip_nominal_movements`, con mesa, sesión, jugador y referencia.
- **Composición por denominación** (`chip_inventory_balances` y `chip_inventory_movements`): referencia física que fijan el inventario inicial, las entradas, bajas y ajustes con desglose, y los arqueos. Las entregas y devoluciones por importe **no** la tocan y la marcan como no exacta (`breakdownExact = false`).

**Servicios** (`reservation.service.ts`):

- `getAvailableNominalValue()` y `validateNominalAvailability(amount)`.
- `reserveNominalAmount`: aparta valor sin descontar la custodia y nunca más del disponible.
- `releaseNominalReservation` y `expireReservations`.
- `confirmNominalChipDelivery`: descuenta **una sola vez**, idempotente; custodia y reservado bajan, circulación sube.
- `confirmNominalChipReturn`: circulación baja, custodia sube; nunca más de lo que está en circulación.
- `reconcileNominalInventory`, que es la conciliación de arqueo (`reconcileStockCount`).

Todos bloquean el inventario compartido (las dos mesas se serializan), son idempotentes, usan `Decimal` y auditan.

**Arqueos** (inicial, apertura, extraordinario y cierre):

1. Se capturan las cantidades reales por denominación.
2. Se calcula el valor físico.
3. Se compara contra el **esperado nominal**.
4. Con composición exacta, también se exige cuadrar por denominación (ARQ-09).
5. Sin composición exacta (hubo entregas o devoluciones por importe):
   - si el **valor** cuadra, la composición pasa a ser lo contado (`COMPOSITION_UPDATE`, sin cambio nominal);
   - si no cuadra, se exige justificación y una conciliación única: ajuste nominal más composición.

No se reconstruyen distribuciones desconocidas de entregas anteriores ni se generan movimientos duplicados. La vigencia queda explícita en `resultingInventoryVersion`.

**Migración** `20261019120000_nominal_chip_inventory` (aditiva): inicializa el saldo nominal con el valor de las existencias ya registradas (custodia, reservado y circulación por denominación × valor) y la vigencia de los arqueos confirmados. No borra ni convierte movimientos. En Neon no había existencias: todo en $0.

**Limitaciones del control nominal:**

1. Tras entregas o devoluciones por importe, las cantidades por denominación son solo una referencia hasta el siguiente arqueo. Las bajas y ajustes por denominación se validan contra esa referencia.
2. Un faltante físico entre dos arqueos solo se detecta al contar.
3. La composición exacta se recupera en cada arqueo.

**Pruebas** (integración): compra de $5,000 sin denominaciones, ambas mesas sobre el mismo saldo, valor insuficiente, reservas concurrentes sin saldo negativo, entrega idempotente en paralelo, cancelación que libera, devolución nominal en otra mesa, arqueo tras entregas (composición actualizada), arqueo con faltante y conciliación única, libro nominal que reconstruye el saldo, ningún desglose ficticio ni movimiento financiero, y compatibilidad con la apertura de sesiones (desde el Módulo 12 la circulación previa se informa y ya no bloquea).

## Integración con el Módulo 12 (implementada)

- El arqueo final de la sesión es un `ChipStockCount` `CLOSING` ligado a la sesión: uno GLOBAL del inventario compartido, capturado por denominación. Lo prepara cualquier rol con `sessions:manage` con la sesión en `CLOSING` (la regla del creador solo aplica a la apertura) y se confirma SOLO desde el cierre (`confirmStockCountInTx`); el endpoint genérico rechaza confirmarlo o conciliarlo (`CLOSING_COUNT_VIA_CLOSURE_MESSAGE`).
- Nuevo estado de diferencia `SUPERSEDED`: la diferencia de un arqueo de cierre sustituida por un recuento físico o por el regreso de la sesión a OPEN, sin ajuste (el arqueo se conserva). Trigger actualizado: PENDING → RECONCILED | SUPERSEDED, ambos finales.
- El ajuste excepcional del cierre usa la misma conciliación (`reconcileStockCountInTx`), solo con autorización de PARTNER/SUPERADMIN registrada en `ClosureAdjustmentAuthorization`.
- Las fichas en circulación (libro nominal) NO son diferencia de arqueo: el esperado es solo lo que está bajo custodia. La circulación es global y continua entre sesiones. Ver `docs/MODULE_12_CLOSURE.md` §8–13.

## Integración con el Módulo 16 (implementada)

Canje posterior y reverso de compra registran su entrada al inventario COMPARTIDO con `confirmNominalChipReturnInTx`, una sola vez (claves `redemption-receipt:<id>` y `purchase-reversal-return:<purchaseId>`, referencias `LateChipRedemption` / `PurchaseReversal`). La base sigue impidiendo devolver más de lo que está en circulación. Un canje puede guardar el conteo por denominación del retorno ACTUAL (informativo; no se atribuye a compras). El reverso solo se atribuye a la sesión de la compra si sigue OPEN.

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
