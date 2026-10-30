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

## 4. Sesiones de fecha anterior (solo SUPERADMIN)

**Cambio del 2026-10-29 (decisión del propietario, migración `20261107120000_backdated_sessions`):** una sesión de fecha anterior se **opera completa**, igual que una de hoy. Antes solo se registraban folio y fecha (estado `HISTORICAL`).

- Permiso `sessions:historical-create` (`SESSIONS_HISTORICAL_CREATE`), **exclusivo de SUPERADMIN** (en `ADMIN_ONLY_PERMISSIONS`). PARTNER y CASHIER conservan sus permisos normales.
- Pantalla «Nueva sesión»: el SUPERADMIN marca «Registrar sesión de fecha anterior», elige la «Fecha original de la sesión» (dd/mm/aaaa), ve el folio provisional y el aviso de que se opera completa. Al confirmar entra al asistente de apertura, como una sesión de hoy.
- Servidor (`createSession` con `historical: true` + `businessDate`): exige el permiso (si falta → 403 y auditoría `HISTORICAL_SESSION_CREATION_REJECTED`, DENIED); exige un día **anterior** al día operativo actual (hoy o futuro → 422, auditado). `businessDate` sin `historical` → 400. El cliente nunca envía folio ni consecutivo (`z.strictObject`).
- La sesión nace en **DRAFT** con `isHistorical = true`, `historicalRecordedAt` (momento real de captura) y `historicalRecordedById`, y sigue el ciclo normal DRAFT → PREPARATION → OPEN → CLOSING → CLOSED con TODOS los controles: conteo del inventario compartido, caja $0.00, mesas, compras, firmas (obligatorias igual que en vivo), créditos, liquidaciones y cierre.
- **Ocupa la sesión vigente** (`poker_sessions_single_active`): una a la vez; con otra sesión en curso → 409. No hay sesiones en paralelo.
- Fechas: `businessDate` es la fecha elegida (reportes por jornada); `createdAt`, `openedAt`, `closedAt` y las fechas de cada movimiento son las REALES de captura (el servidor nunca las inventa). La auditoría registra `HISTORICAL_SESSION_CREATED` con la fecha de captura.
- **Registros `HISTORICAL` anteriores al cambio**: se conservan sin modificar (solo folio y fecha; sin caja, inventario ni mesas; no ocupan la sesión vigente) y solo admiten `HISTORICAL → CANCELLED` (SUPERADMIN, con motivo). Ya no se crean sesiones nuevas en ese estado (trigger de inserción: toda sesión nace en DRAFT).
- CHECK `poker_sessions_historical_valid`: datos de captura completos y `HISTORICAL ⇒ isHistorical`.

### 4.1 Modalidad, fecha y horas operativas (2026-10-30)

- «Nueva sesión» muestra a SUPERADMIN la **Modalidad de jornada**: «Nueva jornada» (fecha y hora automáticas) o «Registrar jornada histórica» (fecha, **hora de apertura** local y observación opcional). PARTNER y CASHIER solo ven el flujo normal; el servidor rechaza `historical`/`openingTime` sin el permiso (403) o sin modo histórico (400).
- Campos nuevos en `poker_sessions` (migración `20261107120000_backdated_sessions`): `operatedOpenedAt` (hora OPERATIVA de apertura, obligatoria en una jornada histórica viva) y `operatedClosedAt` (hora OPERATIVA de cierre, obligatoria al cerrarla). La conversión local → UTC usa `zonedDateTimeToUtc` (America/Monterrey, `src/lib/format.ts`); se rechazan horas inválidas o futuras. La de apertura solo cambia en DRAFT/PREPARATION (paso 1 del asistente, auditado con el valor anterior); la de cierre se fija una vez (trigger `poker_sessions_operated_guard`) y debe ser posterior a la apertura (CHECK `poker_sessions_operated_times_valid`). Un cierre como 24/10 20:00 → 25/10 04:00 cruza la medianoche sin problema.
- **Fechas reales intactas**: `createdAt`, `openedAt`, `closedAt`, los movimientos y la auditoría conservan el instante REAL de captura; nunca se reescriben para aparentar el pasado.
- **Movimientos**: su fecha operativa es la `businessDate` de la jornada; su HORA operativa individual no se captura (se considera desconocida, no se inventa) y su hora real queda en `createdAt`. Capturar la hora de cada compra/liquidación requeriría un campo por módulo (pendiente, decisión de negocio).
- Asistentes: aviso fijo «JORNADA HISTÓRICA · 24 DE OCTUBRE DE 2026» (`HistoricalBanner`). Paso 1: modalidad, apertura operativa (editable por SUPERADMIN) y avisos `HISTORICAL_SESSION` (INFO), `SAME_DAY_SESSION_EXISTS` (WARNING, no bloquea: otra jornada no cancelada con la misma fecha) y `LATER_SESSIONS_EXIST` (INFO). Paso 2: `HISTORICAL_COUNT_IS_CURRENT` (INFO). Cierre (paso 6): fecha y hora operativa de cierre obligatoria; **solo SUPERADMIN** confirma el cierre de una jornada histórica (`sessions:historical-create`, además de `sessions:close-confirm`).
- Fechas anteriores y fuera de orden: se puede registrar el 24/10 aunque existan el 25/10 o el 29/10; no hay regla de «una jornada por noche» (solo el aviso de duplicado). El consecutivo del folio sigue el orden de captura (`S-0007-20261024` puede ser posterior a `S-0006-20261029`).
- Comprobante de cierre: `content.session.historical` (fecha operativa, horas operativas y captura real). Reportes y XLSX de sesiones: «Apertura operativa», «Cierre operativo», «Apertura/Cierre real (captura)» y «Jornada capturada el»; filtros por fecha operativa.

### 4.2 Inventario de fichas y caja (riesgo crítico)

- **Un solo inventario compartido y vivo**: una jornada histórica usa los mismos servicios (sin contabilidad paralela). Su conteo inicial es del inventario físico que existe HOY (se compara con las existencias actuales); por eso no duplica fichas ni toca los arqueos de jornadas posteriores. Durante la noche, las entregas y devoluciones nominales se aplican al inventario actual una sola vez (idempotencia por referencia) y se neutralizan al cerrar: entregado = devuelto + rake + propinas + diferencia. Rake y propinas son fichas que vuelven a la custodia.
- **Lo que sí cambia hoy** al capturar una noche pasada: la circulación/custodia si queda una diferencia nominal (se documenta con motivo, sin ajustes), las deudas y cuentas por pagar de los jugadores (son reales) y los saldos derivados actuales. No se modifican sesiones, arqueos, comprobantes ni snapshots posteriores (probado).
- **No admitido**: capturar el conteo «de papel» de aquella noche como si fuera el inventario actual (una diferencia obligaría a conciliar y alteraría las existencias de hoy). Si el conteo actual no coincide, se resuelve con la conciliación auditable del Módulo 04 como cualquier día.
- **Caja**: caja propia de la jornada (scope = id de sesión), inicia en $0, se retira todo al cerrar; no arrastra ni afecta otras cajas. Mientras la jornada histórica esté ABIERTA es la sesión vigente: un abono en sesión registrado en ese momento entraría a SU caja (registra los abonos de hoy como administrativos o después de cerrarla).

## 5. Migración de folios existentes

`20261031130000_session_folio_historical` (segura e idempotente; ejecutada en una transacción):

1. Agrega las columnas (nullable mientras se completan).
2. Consecutivo: el número del folio anterior (`SES-000001` → 1) cuando es inequívoco; si un folio no se reconoce o se repite, recibe un número después del mayor, por orden de creación. **Los huecos se conservan** (no se renumera).
3. `businessDate` = día local (America/Monterrey) de `createdAt`.
4. Audita cada equivalencia (`SESSION_FOLIO_MIGRATED`, con folio anterior y nuevo, id determinista: re-ejecutar no duplica).
5. Guarda el folio anterior en `previousFolio` (único) y escribe el nuevo. Solo toca filas sin migrar.
6. Aplica NOT NULL, índices únicos, CHECKs y las guardias nuevas; ajusta el consecutivo `SESSION` (prefijo `S`, 4 dígitos, siguiente número ≥ mayor + 1).

No cambia ids, relaciones, estados, fechas reales, movimientos financieros, firmas ni comprobantes. Los comprobantes y reportes de cierre guardados (JSON inmutable) conservan el folio que tenían; la búsqueda de sesiones encuentra también por `previousFolio` y el detalle y el XLSX lo muestran para conciliar. En producción (verificado en solo lectura antes de aplicar y aplicado el 2026-10-23): `SES-000001` (creada el 22/10/2026 22:27 hora local) → `S-0001-20261022`; siguiente consecutivo 2. Ese mismo día, a pedido del propietario, su fecha operativa se corrigió al 21/10/2026 (`S-0001-20261021`) con una corrección controlada en la base, auditada como `SESSION_BUSINESS_DATE_CORRECTED` (folio y fecha de antes y después). El folio y la fecha siguen siendo inmutables para la aplicación: este tipo de corrección no tiene endpoint y solo se hace de forma excepcional y auditada.

## 6. Auditoría

`SESSION_CREATED` (normal) o `HISTORICAL_SESSION_CREATED` + `SESSION_FOLIO_ASSIGNED` (con folio, consecutivo, fecha operativa, tipo y, si es histórica, el momento real de captura), `SESSION_FOLIO_MIGRATED` y `HISTORICAL_SESSION_CREATION_REJECTED`. Todos en el módulo «Sesiones (M06)», con usuario, rol del momento y `sessionId`. La captura histórica no altera eventos anteriores.

## 7. Idempotencia

La creación usa `idempotencyKey` (único): un doble toque devuelve la misma sesión (`replayed`). La misma clave con otro tipo o fecha → 409.

## 8. Pruebas

- Unitarias (`session-folio.test.ts`): formato, 4 dígitos, > 9999, YYYYMMDD, fechas repetidas, consecutivos únicos, fecha pasada / futura / hoy, medianoche, schema (histórica exige fecha; fecha sin histórico, folio o consecutivo del cliente → 400), permisos por rol y taxonomía.
- Integración (`session-folio.int.test.ts`): normal con folio y auditoría; inmutabilidad y CHECK de formato; histórica del 14/10/2026 sin caja, inventario ni afectar la sesión OPEN; 14/10, 14/10, 17/10 y 10/10 → 1, 2, 3, 4 sin renumerar; 12 creaciones simultáneas → 1..12; idempotencia; hoy/futuro rechazados y auditados; PARTNER/CASHIER → 403 auditado (y 400 manipulando la fecha); no se prepara ni abre, solo SUPERADMIN la cancela; no ocupa la vigente; vista previa sin consumir número; listados y reporte por `businessDate`; **migración real** en una base desechable (SES-000001, SES-000005, RARO-ABC → 1, 5, 6; folio anterior, auditoría y siguiente número; segunda ejecución sin cambios).
- E2E (`session-folio.spec.ts`, Chrome e iPhone): SUPERADMIN registra una histórica con folio provisional y definitivo, fecha operativa y fecha real, sin preparación/mesas/cierre y sin alterar la sesión vigente; filtro por fecha operativa; PARTNER y CASHIER sin la opción y con 403/400 por API; sin desplazamiento horizontal.
