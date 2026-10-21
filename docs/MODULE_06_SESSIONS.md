# Módulo 06 — Sesiones y apertura operativa

Código: `src/modules/sessions/` · API: `src/app/api/sessions/` · Pantallas: `src/app/(dashboard)/dashboard/sesiones/` (atajo `/sesiones/*`) · Migración: `prisma/migrations/20261020120000_module06_sessions/`.

> **Regla prioritaria.** La única forma válida de abrir una sesión es **CREAR → PREPARAR → CONTAR EL INVENTARIO FÍSICO COMPARTIDO → CONCILIAR → CONFIRMAR EFECTIVO FÍSICO $0 → CONFIRMAR APERTURA**. Ningún rol, ni SUPERADMIN, omite estos controles. La sesión puede quedar abierta sin mesas y la hora real la asigna el servidor.

## 1. Definición de sesión

`PokerSession` es un periodo de operación con folio, caja central (`MAIN`), estado, responsable (creador) y fechas reales. Puede cruzar medianoche (p. ej. sábado 21:00 → domingo 04:00): el cambio de día no crea otra sesión. Folio, creador, caja, fechas reales y estado los fija el servidor; un trigger los vuelve inmutables (`openedAt`, `closedAt` y `cancelledAt` no cambian una vez fijados).

## 2. Máquina de estados

| Desde         | Hacia                      | Dónde                                                |
| ------------- | -------------------------- | ---------------------------------------------------- |
| —             | `DRAFT`                    | Crear (único estado inicial: trigger)                |
| `DRAFT`       | `PREPARATION`, `CANCELLED` | Preparar / cancelar                                  |
| `PREPARATION` | `OPEN`, `CANCELLED`        | Confirmar apertura / cancelar sin efectos pendientes |
| `OPEN`        | `CLOSING`                  | Módulo 12 (inicio del cierre)                        |
| `CLOSING`     | `OPEN`                     | Módulo 12 (regreso auditado con motivo)              |
| `CLOSING`     | `CLOSED`                   | Módulo 12 (confirmación PARTNER/SUPERADMIN)          |

Prohibidas: `OPEN → PREPARATION`, `CLOSED → OPEN/CLOSING`, `CANCELLED → OPEN`, `CLOSED → DRAFT` (y cualquier salida de `CLOSED`/`CANCELLED`). La lógica pura está en `session.state.ts`. Toda transición pasa por `transitionInTx`: bloqueo `FOR UPDATE`, actualización condicional sobre el estado de origen, historial y auditoría. El trigger `poker_sessions_guard` repite la validación en la base.

## 3. Sesión vigente única

Vigentes: `DRAFT`, `PREPARATION`, `OPEN`, `CLOSING`. Índice único parcial (SQL manual):

```sql
CREATE UNIQUE INDEX "poker_sessions_single_active" ON "poker_sessions" ((true))
  WHERE "status" IN ('DRAFT', 'PREPARATION', 'OPEN', 'CLOSING');
```

Dos creaciones simultáneas, aunque vengan de instancias serverless distintas, dejan una sola sesión: la otra recibe 409 «Ya existe una sesión vigente (folio…)». Probado con 4 creaciones concurrentes de usuarios distintos. Las sesiones terminadas siguen consultables.

## 4. Creador responsable

`createdById` es el usuario autenticado (nunca se acepta del cliente) y es inmutable (CRE-01/08). Solo el creador continúa la preparación y confirma la apertura (`canManagePreparation`). Otro CASHIER u otro PARTNER no puede modificarla aunque tenga el mismo rol (CRE-09: sí puede consultarla). La regla aplica a la preparación y la apertura, no a la operación posterior (CRE-10).

## 5. Excepción de SUPERADMIN

SUPERADMIN puede intervenir en cualquier preparación (CRE-06). Se audita `SESSION_SUPERADMIN_INTERVENTION` con su identidad real (CRE-07) y la apertura guarda `superadminIntervention = true`. Si el creador está desactivado, solo SUPERADMIN puede recuperarla (CRE-11).

## 6. Arqueo del inventario compartido

Hay un único inventario físico para ambas mesas, así que se hace **un solo arqueo general por apertura** (nunca uno por mesa). Se reutiliza `ChipStockCount` del Módulo 04 con `countType = OPENING` y `sessionId`:

- `POST /api/sessions/:id/opening-chip-count` inicia o retoma el conteo. Si ya hay uno vigente lo reutiliza y no obliga a recontar.
- La captura, confirmación y conciliación usan el mismo motor del Módulo 04 (`/api/chip-inventory/counts/:id/*`), que **valida la regla del creador** para todo arqueo ligado a una sesión (no hay atajo por endpoints genéricos).
- El esperado es el **valor nominal** bajo custodia. Ver la corrección nominal en `docs/MODULE_04_CHIP_INVENTORY.md` § 22: con composición exacta, las diferencias se ven por denominación (ARQ-08/09); sin ella, cuenta el valor total.
- **Vigencia (ARQ-18/21):** `resultingInventoryVersion` del arqueo (la versión tras sus propios efectos: confirmación, actualización de composición y conciliación) debe ser igual a la versión actual del inventario. Cualquier otro movimiento lo vuelve obsoleto. Las conciliaciones propias del arqueo no obligan a recontar.
- El arqueo de otra sesión no sirve (ARQ-17), y el inventario inicial no sustituye al arqueo de apertura (ARQ-02).
- **Circulación previa (ARQ-20):** si hay valor en circulación o reservas activas de sesiones anteriores, la apertura queda bloqueada hasta registrar la devolución o conciliar. No se crean ajustes ficticios.

## 7. Conciliación

Con diferencias (de valor, o por denominación cuando la composición es exacta), el arqueo queda `PENDING` y bloquea la apertura. Conciliar exige motivo, se aplica **una sola vez** (transición condicional y `UNIQUE reconciliationOperationId`) y deja auditoría. No hace falta autorización adicional (ARQ-14). Los arqueos confirmados son inmutables.

## 8. Caja inicial en cero

`POST /api/sessions/:id/opening-cash` con `countedAmount` y `physicallyVerified: true`. El usuario declara que **contó físicamente** la caja; el saldo lógico cero no basta. Crea un `CashReconciliation` OPENING (esperado **siempre** $0, por CHECK) y lo confirma:

- No crea ningún movimiento de dinero, tampoco de $0 (CASH-04/05).
- Si se cuenta dinero, exige explicar su procedencia; queda como evidencia y **bloquea** la apertura hasta retirarlo y volver a contar en $0. No hay ajuste ni fondo inicial (CASH-07/08/09).
- Debe seguir vigente al abrir: sin movimientos de efectivo y con la misma versión del saldo (CASH-12).
- No toca el banco ni las deudas (CASH-11).

## 9. Checklist derivado del backend

`GET /api/sessions/:id/opening-checklist` → 10 pasos con `id`, `label`, `status` (`DONE`/`PENDING`/`BLOCKED`), `completedAt`, `completedBy` y `message`:

1. `SESSION_CREATED` · 2. `IN_PREPARATION` · 3. `CHIPS_COUNTED` · 4. `CHIP_COUNT_CONFIRMED` · 5. `DIFFERENCES_RECONCILED` · 6. `INVENTORY_CURRENT` · 7. `NO_PENDING_CIRCULATION` · 8. `CASH_COUNTED` · 9. `CASH_ZERO_CONFIRMED` · 10. `USER_AUTHORIZED`.

No hay booleanos editables: todo se deriva de los registros (`computeOpeningChecklist`). El navegador solo lo presenta.

## 10. Apertura sin mesas

`POST /api/sessions/:id/open` no recibe mesas. Una sesión `OPEN` con 0 mesas es válida (TAB-04). No se crean mesas automáticamente (`session_tables` vacío) y las mesas se abren después (Módulo 07) sin repetir el arqueo (TAB-09). Las compras, entregas y participaciones exigirán una mesa abierta (TAB-05/06/07).

## 11. Fecha y hora automáticas

`openedAt` lo genera el servidor (TIME-01). El cliente no puede enviarlo: `z.strictObject` responde 400 (TIME-02/03), y el trigger impide cambiarlo después (TIME-08). Se guarda en UTC con milisegundos y se muestra en America/Monterrey (`src/lib/format.ts`). El folio es un consecutivo (`SES-000001`) que no depende de la fecha (TIME-05).

## 12. Permisos

| Acción                                              | SUPERADMIN |   PARTNER    |   CASHIER    |
| --------------------------------------------------- | :--------: | :----------: | :----------: |
| Crear y consultar sesiones (`sessions:read/manage`) |     ✅     |      ✅      |      ✅      |
| Preparar y abrir                                    | Cualquiera | Solo propias | Solo propias |
| Cancelar (DRAFT/PREPARATION)                        | Cualquiera | Solo propias | Solo propias |

La regla del creador es **adicional** al permiso del rol y se valida en el backend. No hay rutas administrativas que la eviten.

## 13. Idempotencia

- Crear: `idempotencyKey` único en `poker_sessions`. El reintento devuelve la misma sesión (200).
- Abrir: `SessionOpening.idempotencyKey` único. La misma clave devuelve la apertura existente (`replayed: true`); otra clave sobre una sesión ya abierta responde 409.
- Preparar es idempotente por estado. La caja inicial reemplaza el borrador anterior.

## 14. Concurrencia

La apertura corre en una transacción que bloquea la sesión (`FOR UPDATE`), el inventario compartido (`lockChipSet`) y el efectivo de la sesión (`lockCashBalance`), y **vuelve a evaluar el checklist** antes de escribir. Dos confirmaciones simultáneas producen una sola apertura (probado con 3 en paralelo). `SessionOpening.sessionId` es `UNIQUE`. Las garantías están en PostgreSQL, no en memoria ni en el navegador.

## 15. Cancelación

`POST /api/sessions/:id/cancel` con motivo obligatorio, solo en DRAFT o PREPARATION (CAN-08: nunca OPEN):

- Exige conciliar antes las diferencias pendientes de arqueo, y que no haya movimientos de dinero.
- Cancela los borradores de arqueo de la sesión.
- **No revierte** ajustes reales ya aplicados ni elimina arqueos confirmados (CAN-06/07).
- Conserva el folio, que no se reutiliza (CAN-04/05).

Registra usuario, fecha y motivo. Cancelar no es borrar: no existe `DELETE`.

## 16. Auditoría

`SESSION_CREATED`, `SESSION_PREPARATION_STARTED`, `SESSION_OPENING_COUNT_STARTED`, `SESSION_OPENING_CASH_CONFIRMED`, `SESSION_OPENED`, `SESSION_CANCELLED` y `SESSION_SUPERADMIN_INTERVENTION`, además de las auditorías de los arqueos (Módulos 04 y 05). El historial de estados queda en `session_status_history` (solo inserción).

## 17. Endpoints

| Método   | Ruta                                              | Permiso                                |
| -------- | ------------------------------------------------- | -------------------------------------- |
| GET      | `/api/sessions` (status, q, from, to, sort, page) | `sessions:read`                        |
| POST     | `/api/sessions`                                   | `sessions:manage`                      |
| GET      | `/api/sessions/active`                            | `sessions:read`                        |
| GET      | `/api/sessions/:id`                               | `sessions:read`                        |
| POST     | `/api/sessions/:id/prepare`                       | `sessions:manage` + creador/SUPERADMIN |
| GET/POST | `/api/sessions/:id/opening-chip-count`            | read / manage + creador                |
| POST     | `/api/sessions/:id/opening-cash`                  | manage + creador                       |
| GET      | `/api/sessions/:id/opening-checklist`             | `sessions:read`                        |
| GET      | `/api/sessions/:id/opening`                       | `sessions:read`                        |
| POST     | `/api/sessions/:id/open`                          | manage + creador                       |
| POST     | `/api/sessions/:id/cancel`                        | manage + creador                       |
| GET      | `/api/sessions/:id/status-history`                | `sessions:read`                        |

Errores: 400 datos inválidos · 401 sin autenticación · 403 sin permiso o no creador · 404 no existe · 409 conflicto de estado, vigencia o concurrencia · 422 requisitos de apertura no cumplidos (con los pasos en `details`).

## 18. Pantallas

- `/sesiones`: listado con búsqueda por folio, filtros, orden y paginación; la sesión vigente aparece destacada.
- `/sesiones/nueva`: confirmación simple, sin mesa, fondo ni fecha.
- `/sesiones/[id]`: folio, estado, responsable, fechas, evidencia de apertura e historial.
- `/sesiones/[id]/preparacion`: checklist con progreso, acciones según permisos, y modo lectura para quien no es creador.
- `/sesiones/[id]/arqueo-fichas`: reutiliza el formulario de captura del Módulo 04.
- `/sesiones/[id]/apertura`: resumen y botón **Abrir sesión**, habilitado solo con el checklist completo.

Son Mobile First, con skeleton, manejo de errores y confirmaciones. Las acciones usan TanStack Query (`useMutation`) y no muestran éxito antes de la respuesta del servidor.

## 19. Pruebas

- **Unitarias** (`src/modules/sessions/session.test.ts`): transiciones válidas e inválidas, regla del creador y excepción SUPERADMIN, permisos, schemas (creador, folio, estado y `openedAt` rechazados; caja en $0 con verificación física), medianoche y milisegundos, schemas del Módulo 07 e importes nominales.
- **Integración** (`tests/integration/sessions.int.test.ts`, PostgreSQL 16 real): creaciones concurrentes, idempotencia, creador, otro CASHIER/PARTNER (403), SUPERADMIN, endpoints genéricos protegidos, creador desactivado, apertura sin arqueo, con diferencias, con caja ≠ 0, apertura válida con 0 mesas y sin efectos, `openedAt` no editable, aperturas concurrentes, sin reapertura, arqueo obsoleto, arqueo de otra sesión, circulación previa, medianoche, cancelación con historial y movimientos conservados, 401/403.
- **E2E** (`tests/e2e/sessions.spec.ts`, Chrome + iPhone): crear y consultar folio, modo lectura para otro usuario, acceso de SUPERADMIN, sin arqueo no se abre, conteo con diferencia y conciliación, caja $0, checklist 10/10, apertura con 0 mesas y hora del servidor, diseño móvil.

## 20. Integración futura con los Módulos 07 y 12

- **Módulo 07:** las mesas solo se abren con la sesión `OPEN` (implementado, ver `docs/MODULE_07_TABLES.md`).
- **Módulo 12 (implementado):** `OPEN → CLOSING`, `CLOSING → OPEN` (regreso auditado) y `CLOSING → CLOSED` con `transitionInTx` y el trigger actualizado. Ver `docs/MODULE_12_CLOSURE.md`.
- **Cambio en la apertura por el Módulo 12:** el paso `NO_PENDING_CIRCULATION` ya NO bloquea por fichas en circulación de sesiones cerradas (se informan como valor pendiente de retorno, global y continuo); siguen bloqueando las reservas activas y la circulación por denominación del modelo anterior. Sin este cambio, una sola ficha no retornada impediría abrir cualquier sesión futura.
- La regla del creador no aplica al cierre: cualquier rol con `sessions:manage` lo prepara y solo PARTNER/SUPERADMIN lo confirma.
- El gateway de sesiones de la caja (`prismaSessionGateway`) ya lee `poker_sessions`.
