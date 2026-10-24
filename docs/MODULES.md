# Checklist de módulos — Poker Manager

Roadmap propuesto de 16 módulos (00–15). Cada módulo crea su propio directorio bajo `src/modules/<dominio>/` cuando se implementa (no se crean vacíos de antemano). El orden respeta las dependencias de negocio descritas en `docs/BUSINESS_RULES.md`.

| #             | Módulo                                | Responsabilidad                                                                                                                                                                                                                   | Estado                     |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 00            | Infraestructura                       | Next.js, TS estricto, Tailwind, shadcn, Prisma+Neon, auth básica, errores, logging, health checks, PWA base                                                                                                                       | ✅ Completado              |
| 01            | Usuarios, roles y seguridad           | Usuarios (SUPERADMIN), roles, permisos por capacidad, sesiones seguras, auditoría de seguridad                                                                                                                                    | ✅ Completado (2026-10-13) |
| 02            | Configuración general                 | Negocio, caja central única, mesas, juegos de fichas, denominaciones, pagos, banco, folios, políticas, WhatsApp pendiente                                                                                                         | ✅ Completado (2026-10-14) |
| 03            | Jugadores                             | Directorio, teléfono E.164 único, historial de teléfonos, consentimiento WhatsApp, crédito sin límite (política)                                                                                                                  | ✅ Completado (2026-10-15) |
| 04            | Inventario central de fichas          | Inventario físico ÚNICO compartido por ambas mesas, existencias por denominación, libro inmutable, inicial, entradas, bajas, ajustes, arqueos, conciliación, reservas (interno)                                                   | ✅ Completado (2026-10-16) |
| 05            | Caja central y cuentas de pago        | Libro de partida doble efectivo/banco, apertura en $0, aportaciones, retiros, transferencias con verificación manual, reversos, arqueos de efectivo                                                                               | ✅ Completado (2026-10-17) |
| 06            | Sesiones y apertura operativa         | Sesión vigente única, máquina de estados, regla del creador, arqueo del inventario compartido, caja $0, checklist derivado, apertura sin mesas                                                                                    | ✅ Completado (2026-10-18) |
| 07            | Mesas y participación                 | Mesas en la sesión, ciclos de apertura/cierre/reapertura, participación única por jugador, transferencias sin efectos financieros ni físicos                                                                                      | ✅ Completado (2026-10-19) |
| 08            | Compras y recompras                   | Por IMPORTE nominal (sin desglose), pagos con componentes (efectivo, transferencia, tarjeta por terminal, crédito con socio autorizador), entrega transaccional                                                                   | ✅ Completado (2026-10-22) |
| 09            | Firmas y comprobantes                 | Firma táctil del jugador en compras con crédito (snapshot inmutable, evidencia privada), comprobante digital con descarga PNG y compartición manual (sin PDF)                                                                     | ✅ Completado (2026-10-23) |
| 10            | Control de créditos                   | Deudas derivadas, abonos en sesión y administrativos, FIFO automático, custodia de efectivo administrativo, transferencias y terminal, comprobantes PNG, reversos                                                                 | ✅ Completado (2026-10-24) |
| 11            | Liquidaciones                         | Devolución nominal, firma obligatoria, compensación OPCIONAL con FIFO, cuenta por pagar, pagos en efectivo/transferencia/mixtos, SETTLING, comprobantes PNG, reversos                                                             | ✅ Completado (2026-10-25) |
| 12            | Cierre de mesas y sesión              | Ciclos de mesa independientes, prevalidación, CLOSING ⇄ OPEN auditado, arqueo GLOBAL único, fichas en circulación ≠ faltante, ajustes autorizados, caja $0, retiro con receptor, confirmación PARTNER/SUPERADMIN, comprobante PNG | ✅ Completado (2026-10-26) |
| 13            | Notificaciones automáticas            | WhatsApp Cloud API real (número exclusivo pendiente de recepción)                                                                                                                                                                 | En pausa (sin número)      |
| 14            | Reportes y estadísticas               | Dashboard, sesiones, mesas, compras, finanzas separadas (nominal/monetario/CxC/CxP), deuda por jugador → sesión de origen → compra, deuda al cierre vs actual, liquidaciones, fichas, jugadores, comparativos, exportación XLSX   | ✅ Completado (2026-10-27) |
| 15            | Auditoría, administración y respaldos | Auditoría transversal, correcciones excepcionales, integridad, incidencias, seguridad, respaldos cifrados verificados, restauración aislada, recuperación protegida, salud (respaldo diario: configuración pendiente)             | ✅ Completado (2026-10-28) |
| 16            | Operaciones financieras especiales    | Canje posterior de fichas, reverso completo de compras, reverso de liquidaciones con pagos reales, devolución de fondos no aplicados                                                                                              | **Siguiente**              |
| por confirmar | PWA, hardening, despliegue            | UX móvil avanzada, revisión de seguridad, operación                                                                                                                                                                               | Pendiente                  |

> La numeración confirmada por los encargos es: 02 Configuración general, 03 Jugadores, 04 Inventario central de fichas, 05 Caja central y cuentas de pago, 06 Sesiones y apertura operativa y 13 Notificaciones automáticas. El orden del resto se confirmará al planear cada módulo.

## Módulo 01 — entregado

- Matriz central de permisos por capacidad (`src/config/permission-matrix.ts`) — ver `docs/ROLES_AND_PERMISSIONS.md`.
- Administración de usuarios (solo SUPERADMIN): listar, buscar, filtrar, crear, editar, activar/desactivar, restablecer contraseña (credencial temporal), sin borrado físico.
- Login/logout con Auth.js, limitador de intentos, revocación inmediata por `sessionVersion`, credencial temporal obligatoria de cambiar, CSRF, auditoría de seguridad inmutable — ver `docs/AUTHENTICATION.md`.
- Pantallas Mobile First: login, perfil, usuarios (lista/alta/edición), acceso denegado, navegación por capacidades.
- Pruebas: unitarias (Vitest), integración contra Postgres real (`npm run test:integration`) y E2E con sesión real (Playwright, Chrome + iPhone).

Pendientes conocidos (fuera de alcance de 01):

- Recuperación de contraseña por correo con token de un solo uso (hoy solo restablece un SUPERADMIN, en persona).
- Pantalla de consulta de la auditoría (`AUDIT_READ`/`AUDIT_SECURITY_READ` ya existen; la vista es del Módulo 12).
- 2FA para SUPERADMIN.

## Módulo 02 — entregado

Detalle: [`docs/MODULE_02_CONFIGURATION.md`](MODULE_02_CONFIGURATION.md).

- Configuración del negocio, Caja Central `MAIN` única, mesas 25/25 y 10/10 (desde la corrección de inventario compartido, ambas usan `CHIPSET_MAIN`), denominaciones del inventario (sin inventar), métodos de pago `CASH`/`BANK_TRANSFER`, cuenta bancaria única cifrada (pendiente de captura), folios con emisión atómica, políticas `NEW_FUND_PER_SESSION` (reemplazada en el Módulo 05 por `ZERO_OPENING_BALANCE`)/`FULL_WITHDRAWAL` y reglas fijas, WhatsApp `PENDING_CONFIGURATION`.
- Ninguna operación financiera, existencia ni folio emitido.

Pendientes conocidos (fuera de alcance de 02):

- Capturar las denominaciones reales del inventario común y los datos bancarios (tarea del SUPERADMIN, no de código).
- Aplicar `dateFormat`/`timeFormat` a las pantallas (hoy se usa es-MX).
- Bloquear el cambio de valor de denominaciones con movimientos (DEN-11), en el módulo de inventario.
- Integración WhatsApp real: Módulo 13, cuando llegue el número.

## Módulo 03 — entregado

Detalle: [`docs/MODULE_03_PLAYERS.md`](MODULE_03_PLAYERS.md).

- `Player` separado de `User`; teléfono obligatorio en E.164, único en la base (también ante altas simultáneas); México por defecto e internacionales válidos (libphonenumber-js).
- `PlayerPhoneHistory` y `PlayerNotificationConsent` de solo inserción. El consentimiento vigente es derivado y está ligado al número.
- Política de crédito sin límite documentada (`src/config/credit-policy.ts`, regla `NO_CREDIT_LIMIT`), sin campos de deuda, saldo ni límite.
- Directorio paginado en servidor, alta, perfil y edición Mobile First; permisos `players:create/update/consent` y auditoría `PLAYER_*`.

Pendientes conocidos (fuera de alcance de 03):

- Política de conservación y derechos ARCO de los historiales de datos personales: definir con asesoría legal.
- Revisión legal y de Meta del texto del aviso de consentimiento antes del Módulo 13.
- Verificación de titularidad del número (SMS): no requerida por ahora.

## Módulo 04 — entregado

Detalle: [`docs/MODULE_04_CHIP_INVENTORY.md`](MODULE_04_CHIP_INVENTORY.md).

- Un inventario físico compartido por ambas mesas (`CHIPSET_MAIN`) en una ubicación (`INVENTARIO-GENERAL`); existencias por (ubicación, denominación, estado), con FK compuestas que impiden mezclar juegos. (Originalmente se entregó con un maletín por juego y mesa; ver «Corrección: inventario compartido».)
- Libro de movimientos inmutable con operaciones idempotentes; bloqueo del inventario (`SELECT … FOR UPDATE`) y CHECKs: nunca negativos, nunca doble descuento, también entre las dos mesas.
- Inventario inicial (una sola vez), entradas, bajas, ajustes (los tres roles, motivo obligatorio, sin aprobación), arqueos reutilizables con detección de esperado obsoleto y conciliación única.
- Reservas, entregas y devoluciones como servicios internos para compras y liquidaciones (sin endpoints públicos).
- Pruebas de integración y concurrencia sobre PostgreSQL 16 real (Docker).

Pendientes conocidos (fuera de alcance de 04):

- Capturar en producción las denominaciones reales y el inventario inicial del inventario común (tarea operativa).
- `INTERNAL_TRANSFER` operativo solo si llega a haber más de una ubicación física real. `CHIP_CONVERSION` ya no aplica (el inventario es compartido).
- Programar `expireReservations()` cuando existan compras.

## Módulo 05 — entregado

Detalle: [`docs/MODULE_05_CASH_BOX.md`](MODULE_05_CASH_BOX.md).

- Libro financiero de partida doble (`CashTransaction` + `CashTransactionEntry`) con 9 cuentas técnicas; efectivo por sesión y banco global; proyección de saldos con bloqueo `FOR UPDATE`, CHECK de no negativos y trigger de cuadre.
- Política `ZERO_OPENING_BALANCE` (migración segura desde `NEW_FUND_PER_SESSION`), sin fondo, sin arrastre, sin saldos negativos y sin gastos operativos.
- Aportaciones, retiros, traslado efectivo→banco, reversos y arqueos de efectivo (servicios y API); transferencias bancarias con verificación manual por los tres roles (servicios, API y pantalla).
- Contratos para el Módulo 06 (`SessionGateway`, `evaluateOpeningReadiness`/`assertOpeningReady` con arqueos de fichas del Módulo 04) y para compras, abonos, liquidaciones y cierre.
- Pantallas `/dashboard/caja/*`; entrada, salida y nuevo arqueo son informativas hasta que existan sesiones.

Pendientes conocidos (fuera de alcance de 05):

- Implementar el `SessionGateway` real y los formularios de entrada/salida/arqueo dentro de la sesión (Módulo 06).
- Pagos con transferencia saliente (`BANK_TRANSFER_PAYOUT`): el tipo existe pero ningún flujo lo usa todavía.
- Conciliación contra el estado de cuenta bancario real (hoy solo se muestra el neto registrado).

## Corrección arquitectónica — inventario compartido (previa al Módulo 06)

**UN INVENTARIO FÍSICO COMPARTIDO + DOS MESAS OPERATIVAS + UNA CAJA FINANCIERA CENTRAL.** La decisión anterior (un juego físico de fichas por mesa) quedó cancelada.

- Migración `20261018120000_shared_chip_inventory`: `CHIPSET_MAIN` + ubicación `INVENTARIO-GENERAL`, ambas mesas reasignadas, juegos/maletines por mesa desactivados (no borrados), índice `chip_sets_single_active`, trazabilidad `tableId`/`sessionId`/`playerId` en operaciones, movimientos y reservas. Se detiene si hubiera existencias que fusionar.
- Datos en Neon: no había existencias, movimientos, arqueos ni reservas. Las 6 denominaciones capturadas en los juegos por mesa (25 Verde, 100 Gris, 500 Morada; 10 Verde, 100 Rojo, 500 Morada) **no se fusionaron** (el 100 tenía dos colores): quedan inactivas como historial y en la auditoría. **Pendiente:** capturar el catálogo real del inventario común.
- Caja (Módulo 05) intacta; la apertura exige un solo arqueo general (`assertOpeningReady({ sessionId })`).

## Corrección — inventario por valor nominal (previa al Módulo 08)

- Compras y recompras SOLO por importe nominal; saldo nominal compartido (custodia, reservado, circulación) con libro inmutable `chip_nominal_movements`; la composición por denominación se verifica en los arqueos. Detalle: `docs/MODULE_04_CHIP_INVENTORY.md` § 22 y `docs/MODULE_08_PURCHASES.md`.
- Las reservas, entregas y devoluciones por denominación se sustituyeron por `reserveNominalAmount`/`confirmNominalChipDelivery`/`releaseNominalReservation`/`confirmNominalChipReturn` (no tenían datos reales).

## Módulo 06 — entregado

Detalle: [`docs/MODULE_06_SESSIONS.md`](MODULE_06_SESSIONS.md). Sesiones con folio, una vigente a la vez, máquina de estados con historial, regla del creador con excepción auditada de SUPERADMIN, arqueo OPENING del inventario compartido (Módulo 04), caja $0 (Módulo 05), checklist derivado de 10 pasos, apertura atómica e idempotente sin mesas, cancelación sin borrar.

## Módulo 07 — entregado

Detalle: [`docs/MODULE_07_TABLES.md`](MODULE_07_TABLES.md). Mesas por sesión con ciclos (apertura, cierre, reapertura), participantes con una participación activa por jugador, transferencias atómicas sin efectos financieros ni de inventario, historial y contratos para compras, liquidaciones y cierre.

Pendientes conocidos (fuera de alcance de 06/07):

- Cierre de sesión (Módulo 12) y salida definitiva por liquidación (Módulo 11).

## Módulo 08 — entregado

Detalle: [`docs/MODULE_08_PURCHASES.md`](MODULE_08_PURCHASES.md). Compras y recompras solo por importe sobre el inventario nominal compartido; numeración por (sesión, jugador); pagos mixtos (efectivo, transferencia pendiente/verificada, `CARD_DEBIT`/`CARD_CREDIT` por terminal con cuenta «por liquidar» y depósito sin doble ingreso); crédito con socio autorizador (VERBAL/MESSAGE) y firma obligatoria vía contrato del Módulo 09; deuda `PlayerDebt` con saldo derivado; evento outbox para WhatsApp; confirmación atómica e idempotente; cancelación que respeta cobros reales; solicitud de reverso.

Pendientes conocidos:

- Módulo 09: verificador real de firmas — entregado (ver abajo).
- **Módulo 10/11**: abonos, FIFO y devolución de fichas (entregados); ejecución de reversos de compras (pendiente).
- Catálogo de terminales y conciliación de comisiones de terminal (no se inventan porcentajes).

## Módulo 09 — entregado

Detalle: [`docs/MODULE_09_SIGNATURES_RECEIPTS.md`](MODULE_09_SIGNATURES_RECEIPTS.md). Resumen de reconocimiento preparado por el servidor (snapshot inmutable con huella canónica y declaración versionada), firma táctil por trazos con PNG generado en el servidor y guardado en almacenamiento privado (PostgreSQL), invalidación por cambios materiales conservando evidencia, verificador real integrado en la entrega del Módulo 08, comprobante digital para toda compra confirmada con descarga PNG y compartición manual. Sin PDF ni WhatsApp.

Pendientes conocidos: driver de almacenamiento de objetos (S3/R2) cuando existan credenciales; sección de «movimientos actualizados» del comprobante al llegar los abonos (Módulo 10); anulación de comprobantes al ejecutar reversos (Módulo 11, contrato `voidReceiptInTx` listo).

## Módulo 10 — entregado

Detalle: [`docs/MODULE_10_CREDITS.md`](MODULE_10_CREDITS.md). Cuentas por cobrar con saldo derivado del libro de aplicaciones, abonos en sesión y administrativos (sin tocar cajas cerradas), FIFO automático, pagos de compra vinculados a su deuda, custodia de efectivo administrativo con depósito sin doble ingreso, transferencias y terminal reutilizando el Módulo 05, fondos no aplicados (sin saldos a favor), comprobantes PNG, reversos con contraasientos y contrato de compensación para el Módulo 11.

Pendientes conocidos: devolución de fondos no aplicados y de abonos por transferencia (salida bancaria real); reverso de compras; cierre de sesión (Módulo 12).

## Módulo 11 — entregado

Detalle: [`docs/MODULE_11_SETTLEMENTS.md`](MODULE_11_SETTLEMENTS.md). Liquidación de la participación activa final por valor nominal (incluido $0), firma obligatoria con snapshot canónico y parte material revalidada al recibir, compensación opcional (no/parcial/máxima) con el FIFO del Módulo 10, entrada nominal única al inventario compartido, cuenta por pagar con desembolsos en efectivo (caja de la sesión o custodia administrativa tras el cierre), transferencias salientes con reserva y verificación manual, pagos mixtos y parciales, participación SETTLING/SETTLED, comprobante de recepción y anexos PNG, reversos sin pagos reales, contratos para el Módulo 12.

Pendientes conocidos: reverso completo de compras; reverso de liquidaciones con pagos reales (resolución administrativa); devolución de fondos no aplicados del Módulo 10.

## Módulo 12 — entregado

Detalle: [`docs/MODULE_12_CLOSURE.md`](MODULE_12_CLOSURE.md). Cierre independiente de ciclos de mesa (SETTLING permitido), prevalidación derivada (BLOCKING/WARNING/INFO), `OPEN → CLOSING` con bloqueo de operaciones, regreso auditado `CLOSING → OPEN`, cierre sin actividad con motivo, arqueo final ÚNICO y global por denominación (motor del Módulo 04), saldo nominal esperado desde el libro, fichas no retornadas y circulación global separadas de la diferencia física, recuento o ajuste excepcional autorizado por PARTNER/SUPERADMIN, arqueo de efectivo y retiro final exacto con receptor declarado (caja $0), confirmación definitiva con huella del resumen, obligaciones que sobreviven, comprobante inmutable con PNG, auditoría y contrato para el canje posterior de fichas.

Cambio en el Módulo 06 documentado: la circulación de sesiones cerradas ya no bloquea la apertura (se informa).

Pendientes conocidos: ninguno del cierre (el canje posterior se entregó en el Módulo 16; la auditoría en el Módulo 15; los reportes en el Módulo 14).

## Módulo 14 — entregado

Detalle: [`docs/MODULE_14_REPORTS.md`](MODULE_14_REPORTS.md). Capa de solo lectura sin modelos nuevos: dashboard con periodos explícitos y actualización al volver/al foco/tras mutaciones; reportes de sesiones (vista histórica del cierre y vista actual separadas), mesas por ciclo, compras por importe, caja y finanzas en cuatro categorías separadas, créditos en tres niveles (jugador → sesión de origen → compra/recompra → aplicaciones), abonos sin duplicar, deuda al cierre vs actual, liquidaciones y compensaciones, inventario y circulación, estadísticas de jugadores y comparativos; filtros Zod persistidos en la URL; exportación exclusiva XLSX (ExcelJS) auditada; los tres roles consultan y exportan; 9 índices nuevos.

Cambios en módulos anteriores documentados: CASHIER obtiene `reports:view`/`reports:financial` (DEC-08) y nuevo `reports:export`; `QueryProvider` invalida `["reports"]` tras cada mutación.

Migraciones de los Módulos 11, 12 y 14 aplicadas en Neon (2026-10-20). Pendientes conocidos: Módulo 13 al recibir el número de WhatsApp.

## Módulo 15 — entregado

Detalle: [`docs/MODULE_15_AUDIT_ADMIN_BACKUP.md`](MODULE_15_AUDIT_ADMIN_BACKUP.md), [`docs/BACKUP_SETUP.md`](BACKUP_SETUP.md) y [`docs/DISASTER_RECOVERY_RUNBOOK.md`](DISASTER_RECOVERY_RUNBOOK.md). Auditoría transversal ampliada sobre `audit_logs`; correcciones excepcionales (aprobar no mueve saldos; ejecución solo enlazando la operación real; Módulo 16 pendiente); 48 comprobaciones de integridad de solo lectura; centro de incidencias deduplicadas; seguridad y monitoreo; respaldo lógico cifrado y verificado por CLI; prueba de restauración aislada y recuperación protegida en base nueva (solo SUPERADMIN, mantenimiento 503); salud del sistema; panel `/dashboard/administracion`.

Cambios en módulos anteriores documentados: CASHIER obtiene `audit:read` (DEC-03); el historial telefónico del jugador pasa a `players:history`; la auditoría de compras confirmadas registra sesión y ciclo; `withApiHandler` aplica el modo mantenimiento.

Pendientes conocidos: configurar destino, clave y tarea programada de respaldos (automatización hoy NO operativa); base aislada para pruebas mensuales. (Migraciones del Módulo 15 aplicadas en Neon el 2026-10-21.)

## Módulo 16 — entregado

Detalle: [`docs/MODULE_16_SPECIAL_OPERATIONS.md`](MODULE_16_SPECIAL_OPERATIONS.md). Operaciones financieras especiales con movimientos reales y lo original inmutable: canje posterior de fichas (validación del socio, recepción física con firma, obligación y pagos), reverso completo de compras confirmadas (solicitud aprobada + devolución física completa; extinción de deuda sin dinero y reembolso solo de lo pagado), corrección de liquidaciones con pagos (reverso de compensación o pago adicional, con firma) y devolución de fondos no aplicados. Pagos especiales en efectivo (custodia o caja abierta de origen) o transferencia (en trámite → ejecutada). Panel `/dashboard/operaciones-especiales`; endpoints `/api/special-operations/*`; 7 comprobaciones de integridad nuevas.

Pendientes conocidos: reclamar dinero pagado de más en una liquidación (NOT_IMPLEMENTED). (Migraciones del Módulo 16 aplicadas en Neon el 2026-10-21.)

## Rediseño de la mesa interactiva — entregado

Detalle: [`docs/POKER_TABLE_UX_REDESIGN.md`](POKER_TABLE_UX_REDESIGN.md). La pantalla de mesa se vuelve el centro operativo: mesa ovalada con nueve asientos fijos, dealer como persona entre los asientos 7 y 6, paño configurable por mesa y paneles inferiores para sentar (pendiente de compra), compra inicial/recompra rápida (Módulos 08/09/10), liquidación (Módulo 11), cambio de asiento, transferencia con asiento destino (Módulo 07) y retiro sin compra. Módulo `src/modules/table-floor`; migraciones `20261030120000_table_floor_enums` y `20261030130000_table_floor` (aplicadas en Neon el 2026-10-23).

Pendientes conocidos: montos rápidos configurables desde la interfaz; pantalla de catálogo de dealers.

## Folios de sesión y captura histórica — entregado

Detalle: [`docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md`](SESSION_FOLIO_AND_HISTORICAL_ENTRY.md). Folio `S-0001-YYYYMMDD` (consecutivo global + fecha operativa `businessDate`), migración segura de los folios `SES-…` y registro de sesiones de fechas anteriores exclusivo de SUPERADMIN (estado `HISTORICAL`, sin caja, inventario ni operación). Listados y reportes por fecha operativa. Migraciones `20261031120000_session_folio_enums` y `20261031130000_session_folio_historical`.

Migraciones aplicadas en Neon el 2026-10-23. Pendientes conocidos: captura financiera histórica (compras, pagos, liquidaciones antiguas) no implementada por diseño.

## Módulo 17 — entregado

Detalle: [`docs/MODULE_17_BANKED_PLAYERS.md`](MODULE_17_BANKED_PLAYERS.md). Jugadores bancados por la casa, PRIVADO (`/dashboard/administracion/bancaje`, `/api/admin/banking/*`): acuerdos con porcentajes versionados, ciclos de cuatro jugadas (una por sesión), compras financiadas sin dinero ni deuda (Módulo 08, `fundingSource = HOUSE`), conciliación física sin pago automático, motor de compensación (ganancias → reserva → arrastre) con tramos de porcentaje y distribución de pérdidas decidida por un socio, anticipos con autorización verbal/mensaje y límite conservador, cortes con aprobación digital por huella, reserva y retiros aprobados, pagos reales sobre las obligaciones del Módulo 16, regularizaciones caso por caso, XLSX privado, auditoría `BANKING_*` restringida y 3 comprobaciones de integridad. La mesa no muestra ninguna señal.

Migraciones aplicadas en Neon el 2026-10-23. Pendientes conocidos: jugadas en sesiones históricas, regularización de ciclos cerrados y devolución de excedentes por transferencia (NOT_IMPLEMENTED).

## Notas

- `src/modules/*` del árbol de referencia (`auth`, `users`, `sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) se reparten entre estos módulos numerados — `sessions`+`tables` corresponden al Módulo 02, `reports` al Módulo 14 y `audit` al Módulo 15, etc.
- Ningún módulo de negocio (02 en adelante) debe implementarse antes que el Módulo 01 (seguridad/roles) esté terminado — todos dependen de autorización por rol correcta.
- Este archivo se actualiza al cerrar cada módulo (mover su fila a "✅ Completado" y anotar la fecha).

## Conciliación global de fichas — entregado

Detalle: [`docs/CHIP_GLOBAL_RECONCILIATION.md`](CHIP_GLOBAL_RECONCILIATION.md). Sustituye la advertencia «Fichas no retornadas» por la conciliación GLOBAL (en juego / conciliada / diferencia por conciliar), retorno cero explícito en liquidaciones, resultado individual visible, conciliación autorizada (`session_chip_reconciliations`), reportes con «diferencia nominal» y comprobación de integridad `SESSION_NOMINAL_BALANCE`. Migración `20261102120000_chip_global_reconciliation` (pendiente en Neon).
