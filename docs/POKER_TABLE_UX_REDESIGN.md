# Mesa interactiva — rediseño operativo (asientos, dealer y paño)

La pantalla de una mesa (`/dashboard/sesiones/:id/mesas/:tableId`) es ahora el **centro de operaciones del cajero**: una mesa ovalada de casino con nueve asientos, el dealer como persona y paneles inferiores (bottom sheets) para sentar, comprar, recomprar, liquidar, cambiar de asiento y transferir. **No es una ilustración ni un atajo**: cada acción llama a los mismos servicios transaccionales de su módulo (07, 08, 09, 10, 11) y la vista se refresca con la respuesta del servidor.

Código: `src/modules/table-floor/*` (servicios, schemas, reglas puras y componentes), rutas nuevas en `src/app/api/**` (ver _Endpoints_), migraciones `20261030120000_table_floor_enums` y `20261030130000_table_floor`.

## 1. Mesa y nueve asientos

- Mesa **ovalada** en CSS (sin imágenes): barandal contrastante + paño con degradado. En celular el óvalo es **vertical** (aspecto 10:12) y desde `sm` es **horizontal** (16:10). La topología no cambia.
- **Nueve asientos fijos** (`SEAT_LAYOUT`, en % del contenedor, `table-floor.math.ts`):

  | Asiento | Posición                            |
  | ------- | ----------------------------------- |
  | 1, 2, 3 | arriba (izquierda, centro, derecha) |
  | 4, 5    | lateral derecho (arriba, abajo)     |
  | 6, 7    | abajo (derecha, izquierda)          |
  | 8, 9    | lateral izquierdo (abajo, arriba)   |

- La numeración es estable: no se reorganiza al entrar o salir un jugador ni cambia con el tamaño de pantalla. Cada asiento es un `<button>` con etiqueta accesible (número, jugador, estado y crédito pendiente), foco visible y alto ≥ 44 px.
- Prueba de geometría (`table-floor.test.ts`): con las medidas reales de las tarjetas en 320, 360, 390, 430, 640 y 768 px, ningún asiento ni el dealer se superponen (separación mínima 6 px) ni desbordan horizontalmente. La E2E lo verifica también con las cajas reales del navegador.

## 2. Dealer como persona

- `Dealer` es una **persona registrada**: nombre, apodo opcional, activo/inactivo. **No** es usuario del sistema (sin cuenta, rol ni contraseña), **no** ocupa asiento y **no** tiene compras, deudas ni liquidaciones por su función. Sin borrado físico (se desactiva; un dealer asignado no se desactiva). Avatar: iniciales (no se guardan archivos).
- **Posición**: tarjeta de persona DENTRO del óvalo, abajo al centro, alineada con el hueco entre los asientos 7 y 6 (`DEALER_POSITION`, x = punto medio de 7 y 6). Sin dealer: tarjeta discreta «Sin dealer · Asignar».
- **Asignación por ciclo** (`DealerAssignment`): una vigente por ciclo de mesa y una mesa vigente por dealer (índices únicos parciales). Cambiar de dealer libera la asignación anterior (`CHANGED`) y crea otra en la misma transacción; liberar (`RELEASED`); al cerrar el ciclo de la mesa se libera sola (`CYCLE_CLOSED`). El historial nunca se borra.
- **No** hay botón «D», rotación, manos, rondas ni ciegas ligadas al dealer: esa lógica de juego no está definida y queda fuera de alcance.

## 3. Paño configurable

- `PokerTable.feltColor` (`TableFeltColor`): Verde casino (por defecto), Azul oscuro, Rojo vino, Negro, Gris grafito y Morado oscuro. **Paleta cerrada**: no hay color libre porque no se podría garantizar el contraste; todo texto sobre el paño cumple AA (≥ 4.5:1, probado). Las tarjetas de asiento y dealer tienen fondo propio, así que su contraste no depende del paño.
- Pertenece a la **mesa del catálogo**: 25/25 y 10/10 son independientes y el color se conserva al cerrar y reabrir la mesa (ciclo nuevo).
- Solo visual: no toca caja, inventario, compras, deudas, liquidaciones, participaciones ni reportes. Auditoría `TABLE_FELT_COLOR_CHANGED` solo si el color cambió (repetir el mismo es idempotente).

## 4. Asientos y estados

`TableSeatAssignment`: asiento (1..9) que ocupa una participación ACTIVE en el ciclo vigente. Historial inmutable: cambiar de asiento libera la fila anterior (`SEAT_CHANGE`) y crea otra enlazada (`previousAssignmentId`).

Estado del asiento, **derivado** de registros reales (`deriveSeatState`), nunca guardado:

| Estado                 | Regla                                                                                    | Se muestra                                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Libre                  | sin asignación vigente                                                                   | «+ Libre»                                         |
| `PENDING_BUY`          | sin compra CONFIRMED en la cadena de participaciones (origen por transferencia incluido) | «Pend. compra» (ámbar)                            |
| `PLAYING`              | ya recibió fichas                                                                        | «Jugando» (verde)                                 |
| `PURCHASE_IN_PROGRESS` | compra DRAFT/READY de esta participación                                                 | «En compra» (azul) → «Continuar compra pendiente» |
| `SETTLING`             | liquidación DRAFT/READY                                                                  | «Liquidando» (violeta)                            |

El crédito pendiente se marca con un indicador propio. Los estados nunca dependen solo del color: siempre llevan texto e icono. La mesa no muestra cifras extensas: el detalle aparece al tocar al jugador (compras de la sesión, recompras, acumulado registrado, deuda global, deuda originada en la sesión, operación en curso). **El acumulado es lo registrado en compras confirmadas, no las fichas que el jugador tiene ahora.**

Jugadores **activos sin asiento** (registrados antes por la pantalla de jugadores o por API sin asiento) aparecen bajo la mesa y pueden ocupar un asiento libre. Los que ya devolvieron fichas y esperan pago (SETTLING) no ocupan asiento y aparecen en «falta pagarles», con enlace a sus pagos.

## 5. Sentar sin compra inicial

- Tocar un asiento libre abre la búsqueda: nombre, apodo o teléfono, **sin importar acentos ni mayúsculas** (`translate()` en PostgreSQL). Cada resultado indica si no puede sentarse y por qué (inactivo, activo en otra mesa —usar «Mover de mesa»—, ya está en esta mesa, liquidación pendiente de pago). También se puede registrar un jugador nuevo (Módulo 03) sin salir de la mesa.
- Sentar crea la participación ACTIVE (Módulo 07) **y** el asiento en la misma transacción. **No** genera compra, crédito, firma, salida de fichas ni entrada de dinero. Auditoría: `TABLE_PLAYER_JOINED` + `SEAT_ASSIGNED` + `PLAYER_SEATED_PENDING_BUY`.
- **Retiro sin compra** (`WITHDRAWN`): solo si el jugador nunca recibió fichas en su cadena de participaciones, sin compras en preparación ni liquidación en curso. Pide motivo, libera el asiento (`WITHDRAWAL`) y audita `TABLE_PARTICIPATION_WITHDRAWN`. Si recibió fichas, su salida es una liquidación. La base lo impide aunque se salte el servicio.

## 6. Compra inicial y recompra

- La **primera compra confirmada del jugador en la sesión es inicial**; las siguientes son recompras numeradas por (sesión, jugador), aunque cambie de asiento, de mesa o la mesa cierre y reabra ciclo. Lo decide el **servidor** al confirmar la entrega (`nextPurchaseNumber`, Módulo 08); la interfaz solo muestra la proyección («Compra inicial» o «+ Recompra N») y el usuario no puede elegir el tipo. Las compras pendientes, canceladas o no entregadas no cuentan. Dos compras simultáneas se serializan por la participación y el índice único de numeración.
- **Compra rápida** (`QuickPurchaseSheet`; alias `QuickBuyInSheet`/`QuickRebuySheet`): montos sugeridos $500, $1,000, $2,000, $3,000 y $5,000 (constante `QUICK_BUY_AMOUNTS`; sugerencias, no límites) o importe libre; métodos Efectivo, Transferencia, Terminal débito, Terminal crédito, Crédito y Pago mixto. Flujo con los endpoints del Módulo 08: borrador → pago(s) → (si hay saldo) socio PARTNER + medio → firma del Módulo 09 en el mismo panel → confirmación física de entrega. El paso visible lo marcan los bloqueos que devuelve el servidor (`blockers`), nunca un estado local.
- Una transferencia queda PENDIENTE y no cuenta como cobrada (la diferencia es crédito, con socio y firma). La terminal solo se registra como APROBADA con folio y confirmación explícita; rechazos o «en proceso» se capturan con «Pago mixto». La compra muestra «Continuar compra pendiente» si quedó a medias; se puede cancelar o abrir completa.

## 7. Liquidación desde el asiento

`QuickSettlementSheet` reutiliza el Módulo 11: deudas vigentes, valor nominal recibido, compensación **opcional** (no compensar, parcial o máxima, FIFO automático) con vista previa del neto → firma obligatoria (también con $0) → confirmación física de la recepción por separado (con pago inmediato en efectivo opcional, sin caja negativa). Al confirmar, el servidor libera el asiento (`SETTLEMENT`) en la misma transacción. Si falta pagar, la participación queda SETTLING con su cuenta por pagar en el Módulo 11. La sesión puede cerrarse según las reglas del Módulo 12. No se borra historial.

## 8. Cambio de asiento y transferencia

- **Cambio de asiento**: solo a un asiento LIBRE de la misma mesa y ciclo; sin intercambios automáticos. Misma participación: sin compra, liquidación, caja ni inventario. Auditoría `SEAT_CHANGED` (de → a).
- **Transferencia** (`TableTransferSheet`): mesa destino abierta + asiento libre. Usa `transferPlayer` del Módulo 07 con `destinationSeatNumber`: libera el asiento de origen (`TRANSFER`), cierra el origen como TRANSFERRED, crea la participación destino y ocupa el asiento, todo en una transacción. Conserva compras, deuda y numeración de recompras. Un jugador pendiente de compra sigue pendiente.

## 9. Endpoints

| Método y ruta                                                       | Permiso                             | Qué hace                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sessions/:id/tables/:tableId/seats`                       | `sessions:read`                     | Tablero: 9 asientos, ocupantes con estado derivado, sin asiento, pendientes de pago, dealer, paño, asientos libres de las otras mesas abiertas y efectivo disponible de la sesión |
| `POST /api/sessions/:id/tables/:tableId/seats/:seatNumber/assign`   | `sessions:manage`                   | Sentar (`playerId`) o asignar asiento a un activo sin asiento (`participationId`)                                                                                                 |
| `POST /api/sessions/:id/tables/:tableId/seats/change`               | `sessions:manage`                   | Cambiar de asiento                                                                                                                                                                |
| `GET /api/sessions/:id/tables/:tableId/seats/history`               | `sessions:read`                     | Historial de asientos                                                                                                                                                             |
| `GET /api/sessions/:id/tables/:tableId/seat-candidates?q=`          | `players:read`                      | Búsqueda sin acentos con motivo de bloqueo                                                                                                                                        |
| `POST /api/sessions/:id/participations/:participationId/withdraw`   | `sessions:manage`                   | Retiro sin compra                                                                                                                                                                 |
| `GET/POST /api/dealers`, `PATCH /api/dealers/:id`                   | `sessions:read` / `sessions:manage` | Catálogo de dealers                                                                                                                                                               |
| `POST /api/sessions/:id/tables/:tableId/dealer/assign` · `/release` | `sessions:manage`                   | Asignar o cambiar / liberar dealer                                                                                                                                                |
| `GET /api/sessions/:id/tables/:tableId/dealer/history`              | `sessions:read`                     | Historial de dealers                                                                                                                                                              |
| `PATCH /api/tables/:id/appearance`                                  | `sessions:manage`                   | Color del paño                                                                                                                                                                    |

Cambios compatibles en rutas existentes: `POST /api/sessions/:id/tables/:tableId/players` acepta `seatNumber` opcional y `POST /api/sessions/:id/table-transfers` acepta `destinationSeatNumber` opcional. **No** hay endpoints nuevos de compras, firmas, créditos ni liquidaciones. Todas las entradas usan `z.strictObject` (un campo no previsto → 400) y la autorización va primero (401/403).

## 10. Permisos

Sin política nueva: asientos, dealer y paño usan `sessions:manage` (igual que registrar y transferir jugadores en el Módulo 07); compras `purchases:create`, firmas `signatures:capture`, liquidaciones `settlements:operate`, alta de jugadores `players:create`. Hoy los tres roles (SUPERADMIN, PARTNER y CASHIER) tienen esos permisos. La interfaz oculta lo no permitido, pero el servidor siempre decide.

## 11. Auditoría

Nuevos eventos (módulo «Mesas (M07)»): `SEAT_ASSIGNED`, `SEAT_CHANGED`, `SEAT_RELEASED` (con motivo), `PLAYER_SEATED_PENDING_BUY`, `TABLE_PARTICIPATION_WITHDRAWN`, `DEALER_CREATED`, `DEALER_UPDATED`, `DEALER_ASSIGNED`, `DEALER_CHANGED`, `DEALER_RELEASED`, `TABLE_FELT_COLOR_CHANGED`. La transferencia sigue registrando su evento `TABLE_PLAYER_TRANSFERRED` (no se duplica con otro). Compras, firmas, créditos y liquidaciones conservan sus eventos; iniciarlas desde la mesa no agrega ninguno. Los eventos de ingreso y transferencia del Módulo 07 ahora incluyen `sessionId` y `cycleId`, así que aparecen al filtrar la auditoría por sesión.

## 12. Modelos y garantías en la base

- `TableSeatAssignment` (`table_seat_assignments`): CHECK 1..9; CHECK de liberación coherente (fecha, responsable y motivo juntos); únicos parciales (un ocupante vigente por asiento del ciclo y un asiento vigente por participación); trigger de inserción (la participación debe ser ACTIVE, del mismo ciclo/mesa/sesión/jugador, ciclo OPEN); historial inmutable (solo se registra la liberación, una vez; sin DELETE).
- `Dealer` (`dealers`): nombre ≥ 2; sin DELETE; no se desactiva si está asignado.
- `DealerAssignment` (`dealer_assignments`): únicos parciales por ciclo y por dealer; trigger de inserción (ciclo OPEN, dealer activo, coherencia sesión/mesa/ciclo); inmutable salvo la liberación; reintentos idempotentes (`idempotencyKey`, `releaseIdempotencyKey`).
- `ParticipationStatus.WITHDRAWN` + trigger `table_participations_withdrawal_guard` (sin fichas recibidas en la cadena, sin compras en preparación ni liquidación en curso).
- Trigger `table_participations_seat_released`: una participación no deja de estar ACTIVE con su asiento ocupado.
- Trigger `session_table_cycles_floor_released`: un ciclo no se cierra con asientos ocupados ni con dealer vigente.
- `PokerTable.feltColor` (`TableFeltColor`, por defecto `CASINO_GREEN`).

## 13. Concurrencia e idempotencia

Toda operación bloquea la sesión (`FOR SHARE`) y la mesa (`FOR UPDATE`): las operaciones de asientos y dealer de una mesa se serializan, y cerrar una mesa espera a quien esté sentando o cambiando de asiento. La transferencia bloquea las dos mesas en orden fijo. La participación y el dealer se bloquean `FOR UPDATE`. Los índices únicos parciales son la última defensa (dos operadores sobre el mismo asiento → uno gana y el otro recibe 409 «asiento ocupado»; el mismo jugador en las dos mesas → una sola participación). Cada operación lleva clave de idempotencia (doble toque o reintento de red → mismo resultado, sin duplicar). Las compras y liquidaciones conservan sus propias protecciones (numeración serializada, entrega única, firma por versión).

## 14. Actualización de la vista

El tablero usa React Query con datos iniciales del servidor y se vuelve a pedir tras cada operación exitosa (`invalidateQueries` + `router.refresh()`) y al volver a la pestaña. El éxito solo se muestra con la respuesta del servidor; no hay estados optimistas ni WebSockets.

## 15. Pruebas

- Unitarias (`src/modules/table-floor/table-floor.test.ts`, 17): nueve asientos y numeración, topología, **sin superposición en 6 tamaños de pantalla**, dealer dentro del óvalo entre 7 y 6, paleta y contraste, estados y acciones por estado, numeración inicial/recompra, schemas (strict, rangos, uno-de), permisos de los tres roles, taxonomía de auditoría, utilidades.
- Integración (`tests/integration/table-floor.int.test.ts`, 27, PostgreSQL de Docker): tablero vacío; sentar sin dinero ni fichas; asiento ocupado y jugador en otra mesa rechazados; idempotencia; concurrencia (mismo asiento, misma persona en dos mesas, cambio de asiento al mismo destino, dos dealers); compra inicial y recompras con su numeración; compra en curso; crédito con socio + firma visible como deuda global y de sesión; cambio de asiento sin caja ni inventario e historial; transferencia con asiento destino y continuidad de recompras en la mesa destino; liquidación que libera el asiento y deja SETTLING; retiro sin compra (también bloqueado por la base); garantías de la base; dealer (asignar, cambiar, liberar, historial, cierre de mesa, una mesa por dealer); paño por mesa persistente entre ciclos; API (401, 400 por campo extra, asiento fuera de rango, color fuera de paleta); búsqueda sin acentos.
- E2E (`tests/e2e/table-floor.spec.ts`, 14 × Chrome e iPhone): mesa ovalada, nueve asientos, dealer entre 7 y 6 y sin superposiciones; paño persistente e independiente; sentar buscando sin acentos; compra inicial en efectivo con entrega; recompra a crédito con socio, firma táctil y entrega; reportes y crédito; cambio de asiento; transferencia y continuidad «+ Recompra 2»; dealer (asignar, cambiar, historial); liquidación con firma y recepción; retiro sin compra; auditoría filtrada por sesión; pantalla de 320 px; reintentos y concurrencia.

## 16. No implementado (fuera de alcance)

- Botón «D», rotación del dealer, manos, rondas y ciegas por dealer (no definidos todavía).
- Color de paño personalizado (solo paleta cerrada: no se puede garantizar el contraste de un color libre).
- Montos rápidos configurables desde la interfaz: hoy son una constante del código (`QUICK_BUY_AMOUNTS`).
- Pantalla de catálogo de dealers aparte: el alta se hace desde el panel del dealer y el cambio de nombre o la desactivación por `PATCH /api/dealers/:id`.
- Fotografía del dealer: se usan iniciales.
- El registro rápido de jugador no captura el consentimiento de WhatsApp (se gestiona en Jugadores, Módulo 03).
