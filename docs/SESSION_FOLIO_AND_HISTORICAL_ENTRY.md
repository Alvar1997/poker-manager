# Folios de sesión S-0001-YYYYMMDD y captura de sesiones históricas

Mejora del Módulo 06. Código: `src/modules/sessions/session-folio.ts` (reglas puras), `src/modules/settings/folio.service.ts#issueSessionFolio`, `src/modules/sessions/session.service.ts#createSession`; migraciones `20261031120000_session_folio_enums` y `20261031130000_session_folio_historical`.

## 1. Formato del folio

`S-0001-20261014` = `S` (sesión) + **consecutivo global** (mínimo 4 dígitos, con ceros a la izquierda; desde 10000 se muestra completo, sin truncar) + **fecha operativa** `YYYYMMDD`.

- El consecutivo es **global**: no se reinicia por año ni por fecha y se asigna en el **orden real de creación**, no en el de las fechas operativas. Dos sesiones pueden compartir fecha operativa con consecutivos distintos (`S-0001-20261014`, `S-0004-20261014`).
- Lo genera **solo el servidor** y es **inmutable**: no cambia al editar, cambiar de estado, cerrar ni ordenar reportes (trigger `poker_sessions_guard`). Un CHECK (`poker_sessions_folio_format`) exige que el folio coincida exactamente con `sequenceNumber` y `businessDate`.
- El folio es un identificador **público**; las relaciones siguen usando `id`.
- Formato fijo: en Configuración → Folios, «Sesiones» solo permite ajustar el número inicial antes del primer folio (prefijo y dígitos no se editan).

## 2. Consecutivo seguro (concurrencia)

`issueSessionFolio(tx, businessDate)` usa el mismo `UPDATE "folio_sequences" … RETURNING` atómico del resto de los folios (tipo `SESSION`), **dentro de la transacción** que crea la sesión: la fila queda bloqueada hasta el fin de esa transacción, así que dos creaciones simultáneas nunca reciben el mismo número (nunca `MAX()+1`). Si la transacción falla, el número no se consume (sin huecos); los cancelados conservan su número (no se reutiliza ni se renumera). `sequenceNumber` es además `UNIQUE`.

La vista previa (`GET /api/sessions/folio-preview?businessDate=`) es **provisional**: muestra el siguiente número sin reservarlo; el definitivo llega en la respuesta de la creación.

## 3. Fecha operativa (`businessDate`)

- Columna `DATE` (día calendario, sin hora ni zona). Es el día **operativo** al que corresponde la sesión.
- Sesión normal: el servidor la fija con el día local (`APP_TIMEZONE`, America/Monterrey) en que se **crea** la sesión. Una sesión que empieza el 14/10 a las 21:00 y termina el 15/10 a las 03:30 conserva `2026-10-14` (y su folio, `…-20261014`).
- Se mantienen separados: `businessDate` (jornada), `createdAt` (momento real de registro), `openedAt` y `closedAt` (momentos reales de apertura y cierre) y los timestamps reales de cada compra, pago, firma o liquidación. **Nada se sobrescribe para simular fechas pasadas.**
- Reportes por jornada (sesiones, créditos por sesión de origen, financiero por sesión) filtran y muestran `businessDate`. Los movimientos financieros conservan su fecha efectiva: un pago posterior no se reclasifica al día histórico de la sesión. La deuda se sigue agrupando por `sessionId` de origen.

## 4. Captura de sesiones históricas (solo SUPERADMIN)

- Permiso nuevo `sessions:historical-create` (`SESSIONS_HISTORICAL_CREATE`), **exclusivo de SUPERADMIN** (en `ADMIN_ONLY_PERMISSIONS`). PARTNER y CASHIER conservan sus permisos normales.
- Pantalla «Nueva sesión»: el SUPERADMIN ve «Registrar sesión de fecha anterior»; al activarlo elige la «Fecha original de la sesión» (mostrada dd/mm/aaaa), ve el folio provisional y la advertencia: «Esta sesión se registrará como histórica. La fecha de captura real quedará guardada en auditoría y no se modificarán automáticamente caja ni inventario». Al confirmar muestra el folio **definitivo** devuelto por el servidor. Si ya hay una sesión vigente, el listado ofrece «Registrar sesión histórica».
- Servidor (`createSession` con `historical: true` + `businessDate`): exige el permiso (si falta → 403 y auditoría `HISTORICAL_SESSION_CREATION_REJECTED`, resultado DENIED); exige un día **anterior** al día operativo actual (hoy o futuro → 422, también auditado). `businessDate` sin `historical` → 400. El cliente nunca envía folio ni consecutivo (`z.strictObject`).
- Estado nuevo **`HISTORICAL`** (además de `isHistorical = true`, `historicalRecordedAt` = momento real de captura, `historicalRecordedById` = SUPERADMIN):
  - **No ocupa** la sesión vigente (el índice `poker_sessions_single_active` solo cubre DRAFT/PREPARATION/OPEN/CLOSING) y no altera la sesión activa.
  - **No** se prepara, abre ni cierra: no tiene caja, arqueos, efectivo, inventario, mesas, compras ni liquidaciones (todas exigen una sesión OPEN). La única transición es `HISTORICAL → CANCELLED` (solo SUPERADMIN, con motivo), por si se registró por error.
  - No lleva `openedAt`/`closedAt` inventados (trigger de inserción) y nunca se convierte en una sesión OPEN ordinaria.
  - CHECK `poker_sessions_historical_valid`: datos de captura completos; `HISTORICAL ⇔ isHistorical` (una histórica solo es HISTORICAL o CANCELLED).
- **Captura financiera histórica: NO implementada.** Esta mejora registra la sesión (fecha y folio) y deja la estructura lista. Registrar compras, pagos, firmas o liquidaciones antiguas requerirá reglas propias y una conciliación de apertura: nunca usar los flujos en vivo para simular operaciones pasadas, cobrar hoy dinero de entonces, mover el inventario actual ni inventar firmas o entregas.

## 5. Migración de folios existentes

`20261031130000_session_folio_historical` (segura e idempotente; ejecutada en una transacción):

1. Agrega las columnas (nullable mientras se completan).
2. Consecutivo: el número del folio anterior (`SES-000001` → 1) cuando es inequívoco; si un folio no se reconoce o se repite, recibe un número después del mayor, por orden de creación. **Los huecos se conservan** (no se renumera).
3. `businessDate` = día local (America/Monterrey) de `createdAt`.
4. Audita cada equivalencia (`SESSION_FOLIO_MIGRATED`, con folio anterior y nuevo, id determinista: re-ejecutar no duplica).
5. Guarda el folio anterior en `previousFolio` (único) y escribe el nuevo. Solo toca filas sin migrar.
6. Aplica NOT NULL, índices únicos, CHECKs y las guardias nuevas; ajusta el consecutivo `SESSION` (prefijo `S`, 4 dígitos, siguiente número ≥ mayor + 1).

No cambia ids, relaciones, estados, fechas reales, movimientos financieros, firmas ni comprobantes. Los comprobantes y reportes de cierre guardados (JSON inmutable) conservan el folio que tenían; la búsqueda de sesiones encuentra también por `previousFolio` y el detalle y el XLSX lo muestran para conciliar. En producción (verificado en solo lectura antes de aplicar y aplicado el 2026-10-23): `SES-000001` (creada el 22/10/2026 22:27 hora local) → `S-0001-20261022`; siguiente consecutivo 2.

## 6. Auditoría

`SESSION_CREATED` (normal) o `HISTORICAL_SESSION_CREATED` + `SESSION_FOLIO_ASSIGNED` (con folio, consecutivo, fecha operativa, tipo y, si es histórica, el momento real de captura), `SESSION_FOLIO_MIGRATED` y `HISTORICAL_SESSION_CREATION_REJECTED`. Todos en el módulo «Sesiones (M06)», con usuario, rol del momento y `sessionId`. La captura histórica no altera eventos anteriores.

## 7. Idempotencia

La creación usa `idempotencyKey` (único): un doble toque devuelve la misma sesión (`replayed`). La misma clave con otro tipo o fecha → 409.

## 8. Pruebas

- Unitarias (`session-folio.test.ts`): formato, 4 dígitos, > 9999, YYYYMMDD, fechas repetidas, consecutivos únicos, fecha pasada / futura / hoy, medianoche, schema (histórica exige fecha; fecha sin histórico, folio o consecutivo del cliente → 400), permisos por rol y taxonomía.
- Integración (`session-folio.int.test.ts`): normal con folio y auditoría; inmutabilidad y CHECK de formato; histórica del 14/10/2026 sin caja, inventario ni afectar la sesión OPEN; 14/10, 14/10, 17/10 y 10/10 → 1, 2, 3, 4 sin renumerar; 12 creaciones simultáneas → 1..12; idempotencia; hoy/futuro rechazados y auditados; PARTNER/CASHIER → 403 auditado (y 400 manipulando la fecha); no se prepara ni abre, solo SUPERADMIN la cancela; no ocupa la vigente; vista previa sin consumir número; listados y reporte por `businessDate`; **migración real** en una base desechable (SES-000001, SES-000005, RARO-ABC → 1, 5, 6; folio anterior, auditoría y siguiente número; segunda ejecución sin cambios).
- E2E (`session-folio.spec.ts`, Chrome e iPhone): SUPERADMIN registra una histórica con folio provisional y definitivo, fecha operativa y fecha real, sin preparación/mesas/cierre y sin alterar la sesión vigente; filtro por fecha operativa; PARTNER y CASHIER sin la opción y con 403/400 por API; sin desplazamiento horizontal.
