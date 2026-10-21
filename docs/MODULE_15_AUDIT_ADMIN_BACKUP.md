# Módulo 15 — Auditoría, administración, integridad, incidencias, respaldos y recuperación

Estado: **implementado y probado; la automatización diaria de respaldos requiere configuración** (ver §13). El Módulo 13 (WhatsApp) sigue en pausa y no es dependencia. Los procesos financieros del Módulo 16 se implementan en su propio módulo (§27).

Leyenda usada abajo: **IMPLEMENTED** (código hecho) · **TESTED** (probado por pruebas automatizadas reales) · **CONFIGURATION_REQUIRED** (necesita infraestructura/variables que no existen hoy) · **NOT_IMPLEMENTED**.

## 1. Auditoría (IMPLEMENTED · TESTED)

Se **amplió** la tabla existente `audit_logs` (Módulo 01, solo inserción por trigger) en lugar de crear otra. Columnas nuevas, todas opcionales y derivadas al insertar por `recordAudit`, de modo que **todas** las llamadas existentes de los Módulos 01–14 las llenan sin cambiar cada servicio:

| Columna                                             | Origen                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `actorRole`                                         | rol del actor **en el momento del evento** (consulta al insertar) |
| `module`                                            | derivado de la acción (`audit-taxonomy.ts`)                       |
| `sessionId`, `playerId`, `tableCycleId`             | metadatos `sessionId`, `playerId`, `cycleId`                      |
| `idempotencyKey`, `reason`, `amount`, `evidenceRef` | metadatos homónimos / `nominalAmount` / `fileId`                  |
| `relatedEventId`                                    | explícito (evento relacionado)                                    |
| `requestId`                                         | ya existía (correlación de la request HTTP)                       |

Los eventos anteriores al Módulo 15 no tienen esas columnas (no pueden actualizarse: son inmutables); al leer, su módulo se deriva de la acción.

**Atomicidad:** cada servicio audita **dentro de su misma transacción** (`recordAudit(entry, tx)`); si la operación falla, el evento no queda (probado). No hay sistema externo de auditoría, por lo que no se requiere outbox; la recuperación sí escribe además un registro externo (§20).

## 2. Eventos

Los de los Módulos 01–14 (`AUDIT_ACTIONS`) más los del Módulo 15: `CORRECTION_*`, `INTEGRITY_CHECK_*`, `INCIDENT_*`, `BACKUP_*`, `RESTORE_TEST_*`, `RECOVERY_*`, `MAINTENANCE_*`. Módulos: SECURITY, USERS, CONFIGURATION, PLAYERS, INVENTORY, CASH, SESSIONS, TABLES, PURCHASES, SIGNATURES, CREDITS, SETTLEMENTS, CLOSURE, REPORTS, ADMINISTRATION, INFRASTRUCTURE.

## 3. Campos sensibles

`sanitizeMetadata` elimina claves que contengan `password|hash|token|secret|cookie|authorization` y enmascara `clabe|accountNumber|cardNumber|pan` (`••••1234`). Los teléfonos ya llegan enmascarados del Módulo 03. Nunca se guardan imágenes de firmas (solo el id de `StoredFile`), cadenas de conexión ni variables de entorno.

## 4. Permisos

| Permiso                                                    | SUPERADMIN | PARTNER | CASHIER |
| ---------------------------------------------------------- | :--------: | :-----: | :-----: |
| `audit:read` (auditoría operativa y financiera)            |     ✅     |   ✅    |   ✅    |
| `audit:security-read` (inicios de sesión, IPs, seguridad)  |     ✅     |    —    |    —    |
| `corrections:request`                                      |     ✅     |   ✅    |   ✅    |
| `corrections:operate` (aprobar/rechazar/enlazar ejecución) |     ✅     |   ✅    |    —    |
| `integrity:run` (diagnóstico de solo lectura)              |     ✅     |   ✅    |   ✅    |
| `incidents:manage` (crear, comentar, asignar)              |     ✅     |   ✅    |   ✅    |
| `incidents:resolve` (resolver/descartar)                   |     ✅     |   ✅    |    —    |
| `backups:read` · `system:health` (infraestructura)         |     ✅     |   ✅    |    —    |
| `recovery:manage` (recuperación, mantenimiento)            |     ✅     |    —    |    —    |
| `players:history` (historial de teléfonos)                 |     ✅     |   ✅    |    —    |

`players:history` es nuevo: antes el historial telefónico dependía de `audit:read`; como CASHIER ahora tiene `audit:read` (DEC-03), el dato personal conserva su protección con un permiso propio. La autorización general de auditoría **no** expone eventos de seguridad ni de infraestructura.

## 5–6. Solicitudes de corrección y autorizaciones (IMPLEMENTED · TESTED)

Modelos: `CorrectionRequest` (folio `COR-`), `CorrectionApproval` (decisión **única**, inmutable), `CorrectionEvent` (historial inmutable). Estados: REQUESTED → UNDER_REVIEW → APPROVED/REJECTED → EXECUTED/FAILED, CANCELLED. Un trigger impide salir de estados terminales y modificar los datos originales.

**Regla fundamental:** aprobar **no** mueve dinero ni fichas (probado: cero asientos, cero aplicaciones, cero movimientos de fichas). EXECUTED solo se alcanza **enlazando** una operación real ya registrada por el servicio legítimo de su módulo, que se verifica en la base:

| Tipo                                                                                                      | Servicio legítimo              | Referencia verificada                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `RECEIVABLE_PAYMENT_REVERSAL`                                                                             | Módulo 10 `reversePayment`     | `ReceivablePaymentReversal` del mismo abono      |
| `CASH_MOVEMENT_REVERSAL`                                                                                  | Módulo 05 `reverseTransaction` | `CashTransaction` REVERSAL del mismo movimiento  |
| `SETTLEMENT_REVERSAL` (sin pagos)                                                                         | Módulo 11 `reverseSettlement`  | `SettlementReversal` de la misma liquidación     |
| `PURCHASE_REVERSAL`, `SETTLEMENT_REVERSAL_WITH_PAYOUTS`, `UNAPPLIED_FUNDS_RETURN`, `LATE_CHIP_REDEMPTION` | **Módulo 16 (no existe)**      | — : quedan «aprobadas · pendientes de ejecución» |
| `OTHER`                                                                                                   | —                              | sin ejecución enlazable                          |

DEC-06: al aprobar se reevalúan las restricciones del módulo de origen (p. ej. caja de sesión cerrada, abono por transferencia, liquidación con pagos); si el módulo no lo permitiría, la aprobación se rechaza. Autoaprobación bloqueada si hay otro PARTNER/SUPERADMIN activo. Concurrencia: bloqueo `FOR UPDATE`, versión esperada, decisión única, una solicitud activa por movimiento y tipo (índice parcial), idempotencia por clave. Se registra quién solicitó, quién decidió (y con qué rol) y quién ejecutó (el autor del reverso real).

## 7–8. Integridad financiera y de inventario (IMPLEMENTED · TESTED)

`integrity.checks.ts`: 48 comprobaciones de **solo lectura** ejecutadas en una transacción REPEATABLE READ (foto consistente). Cada resultado: `checkCode`, `status` (OK/WARNING/ERROR/NOT_EVALUATED), `severity`, `checkedAt`, entidad, esperado, real, diferencia, explicación y referencias. Un fallo técnico de una comprobación es NOT_EVALUATED, nunca OK.

- **Caja:** caja única, apertura en $0, partida doble cuadrada, proyección = libro, sin negativos, caja cerrada en $0, sin movimientos posteriores al cierre, retiro final = salida del libro, sin asientos duplicados por reintento.
- **Compras:** confirmada ⇔ una entrega, salida nominal = valor, crédito ⇔ obligación del mismo importe, autorizador socio, firma VALID en crédito (no se exige sin crédito), snapshot firmado = compra/obligación, fechas de estado.
- **Deudas:** origen (sesión/mesa/jugador) conservado, original > 0, no sobreaplicadas, **desglose jugador → sesión → compra cuadra con la deuda global** (árbol del Módulo 14 vs. agregado SQL), deuda al cierre del comprobante vs. reconstrucción (advertencia; el comprobante no se modifica), abonos no exceden lo recibido, **orden FIFO**, pagos vinculados en su compra, posibles duplicados, compensaciones sin dinero, reversos correctos.
- **Liquidaciones:** firma, una entrada nominal por el importe devuelto, compensación = aplicaciones FIFO, cuenta por pagar = pago neto, pagos ejecutados ≤ obligación (pago duplicado), asientos solo en ejecutados, SETTLED sin saldo pendiente.
- **Inventario:** un juego activo, sin existencias por mesa, proyección = libro nominal, sin valores imposibles, diferencias de arqueo registradas, faltantes físicos pendientes (A), **circulación como estado legítimo (B)**.
- **Banco/terminal:** verificadas con asiento y pendientes/rechazadas sin asiento, depósito de terminal sin doble reconocimiento.
- **Evidencias y auditoría:** SHA-256 de cada evidencia activa contra su huella; trigger de inmutabilidad de `audit_logs` presente.

Estados legítimos (deudas por cobrar, obligaciones por pagar, transferencias por verificar, fichas en circulación) se reportan como **OK/INFO** y nunca abren incidencias. Ejecución: `IntegrityCheckRun` (una en curso a la vez; una colgada >15 min se cierra como FAILED) + `IntegrityFinding` (inmutables).

## 9. Incidencias (IMPLEMENTED · TESTED)

`OperationalIncident` (folio `INC-`, nunca se borra) + `IncidentHistory` (solo inserción). Estados OPEN/IN_REVIEW/RESOLVED/DISMISSED; severidades LOW/MEDIUM/HIGH/CRITICAL; orígenes MANUAL/INTEGRITY/BACKUP/RESTORE/SECURITY. **Sin duplicados:** índice único parcial por huella mientras esté abierta; la repetición incrementa `occurrences` y registra REOCCURRED. Automáticas (CRITICAL/HIGH): hallazgos ERROR graves, respaldo fallido/parcial/verificación fallida, prueba de restauración fallida, acceso administrativo denegado (`recovery:manage` CRITICAL; usuarios, roles, configuración crítica y auditoría de seguridad HIGH). Ninguna incidencia corrige datos.

## 10. Seguridad (IMPLEMENTED · TESTED)

Se reutiliza todo lo existente (autorización por capacidad en servidor, `sessionVersion`, limitador de intentos, CSRF, Zod `strictObject`, nadie cambia su propio rol, evidencias privadas solo por endpoint autorizado) y se agrega: incidencias por denegaciones sensibles, reautenticación con contraseña para recuperación y mantenimiento, modo mantenimiento (503 en escrituras), pantalla `/dashboard/administracion/seguridad` (SUPERADMIN) sobre la auditoría `AUTH_*`/roles existente (sin tabla `SecurityEvent` paralela).

## 11. Administración

`/dashboard/administracion` (atajo `/administracion`): panel con Auditoría, Correcciones, Integridad, Incidencias, Seguridad, Respaldos, Recuperación y Estado del sistema; enlaza a Usuarios (Módulo 01) y Configuración (Módulo 02) sin duplicarlos. Pestañas según permiso; cada página y endpoint vuelve a autorizar.

## 12. Respaldos automáticos (IMPLEMENTED · TESTED · **CONFIGURATION_REQUIRED** para la automatización)

**Mecanismo real:** instantánea **lógica** consistente (`backup.snapshot.ts`) en una transacción REPEATABLE READ READ ONLY, comprimida (gzip) y cifrada (AES-256-GCM), escrita de forma atómica e inmutable (temporal + enlace sin sobrescritura, permisos 0400).

Por qué no `pg_dump`: Neon ejecuta **PostgreSQL 18.6** y el único `pg_dump` disponible en la infraestructura del proyecto (contenedor Docker de pruebas) es 16.4, que no puede volcar un servidor más nuevo. La instantánea lógica no depende de binarios.

Se ejecuta por CLI, **nunca por HTTP**: `npm run backup:daily` (programado) o `npm run backup:run` (manual). Clave de idempotencia diaria (`daily:AAAA-MM-DD`), un respaldo en curso a la vez (índice parcial + bloqueo asesor). Estados reales PENDING/RUNNING/SUCCESS/FAILED/PARTIAL/VERIFICATION_FAILED; SUCCESS exige artefacto, checksum, punto de recuperación y verificación (CHECK en base).

## 13. Configuración requerida (CONFIGURATION_REQUIRED)

Hoy **no existe** programador de tareas, destino externo ni credenciales: la automatización diaria **no está operativa** y el panel lo muestra como `NOT_CONFIGURED` (se infiere solo de respaldos SCHEDULED reales terminados). Pasos en `docs/BACKUP_SETUP.md`.

## 14. Cobertura de evidencias

Las evidencias privadas (firmas) viven en PostgreSQL (`evidence_blobs`, driver `postgres`), por lo que la **misma instantánea** contiene compra, snapshot firmado, firma, huella y archivo en el mismo punto de recuperación. El manifiesto lista cada archivo con su propósito, compra/liquidación, firma, huella registrada y huella real; un archivo activo faltante o alterado deja el respaldo PARTIAL con incidencia crítica. Si en el futuro se agrega un driver externo (S3/R2), deberá respaldarse con versionado y el mismo manifiesto.

## 15. Manifiestos

`BackupExecution` + `BackupArtifact` (snapshot y manifiesto, inmutables) + archivo `.manifest.json`: id, fechas, estado, punto de recuperación, versión de PostgreSQL, versión de esquema y lista de migraciones, componentes, conteo y SHA-256 por tabla, filas totales, evidencias, tamaño, checksum del artefacto, cifrado y **huella** de la clave (nunca la clave), ubicación lógica, verificación y error. La interfaz no muestra rutas absolutas ni credenciales.

## 16. Cifrado

AES-256-GCM con `BACKUP_ENCRYPTION_KEY` (32 bytes, distinta de `SETTINGS_ENCRYPTION_KEY`); formato `PMBK1 | IV | cifrado | etiqueta`. Una alteración del archivo o una clave incorrecta hacen fallar el descifrado (probado). **Si se pierde la clave, los respaldos son irrecuperables**: guárdala fuera del equipo y del destino de respaldos.

## 17. Retención

Parametrizable (`BACKUP_RETENTION_DAILY_DAYS` = 30, `BACKUP_RETENTION_MONTHLY_MONTHS` = 6): diarios 30 días + el primer exitoso de cada mes 6 meses; nunca se elimina el último exitoso. Se borran solo archivos; el registro queda con `prunedAt`. El periodo mensual de prueba de restauración es la recomendación inicial (`npm run restore:monthly`).

## 18. Verificación

Inmediata al terminar cada respaldo y bajo demanda (`npm run ops -- backup:verify <id>`): checksum del archivo, descifrado GCM, descompresión, conteo y huella de cada tabla contra el manifiesto. Un fallo deja VERIFICATION_FAILED con incidencia crítica (probado).

## 19. Pruebas de restauración (IMPLEMENTED · TESTED en Docker · CONFIGURATION_REQUIRED en producción)

`npm run restore:test [-- <backupId>] [--keep]` con `RESTORE_TEST_DATABASE_URL` (base aislada cuyo nombre contenga restore/recovery/sandbox/test; nunca la de origen). Pasos reales: verificar el respaldo → validar versión de esquema → vaciar el destino aislado → `prisma migrate deploy` → cargar en una transacción (`session_replication_role = replica`) → validar filas y huellas de **todas** las tablas, usuarios (≥1 SUPERADMIN activo), sesiones, compras, inventario, caja, deudas, liquidaciones, auditoría, firmas y evidencias → motor de integridad sobre la base restaurada → registrar `RestoreValidation` → limpiar el entorno (salvo `--keep`). La base restaurada no se conecta a la operación ni envía notificaciones ni pagos. Sin destino configurado el resultado es `NOT_CONFIGURED` y no se registra un éxito.

## 20. Recuperación protegida (IMPLEMENTED · TESTED en Docker)

Solo SUPERADMIN. La web **prepara, valida y da seguimiento**; no existe ningún endpoint que restaure. Flujo: solicitud (motivo + contraseña; respaldo SUCCESS y verificado; evaluación de datos posteriores al punto de recuperación) → VALIDATED (prueba aislada APROBADA del mismo respaldo) → mantenimiento activo → aprobación (contraseña + «RECUPERAR») → ejecución por CLI `npm run recovery:execute -- <id>` en `RECOVERY_TARGET_DATABASE_URL` (base **nueva y vacía** con «recovery» en el nombre) → verificación posterior → COMPLETED solo con referencia y resultado reales (CHECK en base). El cambio de conexión es manual (`docs/DISASTER_RECOVERY_RUNBOOK.md`). Cada paso se audita en la base y en `BACKUP_STORAGE_DIR/recovery-audit.jsonl` (fuera del sistema restaurable).

## 21. Endpoints

| Método y ruta                                                                                                                     | Permiso                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /api/admin/audit`, `GET /api/admin/audit/:id`                                                                                | `audit:read`                                           |
| `GET/POST /api/admin/corrections`, `GET /api/admin/corrections/:id`, `POST …/:id/comments`, `POST …/:id/cancel`                   | `corrections:request`                                  |
| `POST /api/admin/corrections/:id/review`, `…/approve`, `…/reject`, `…/execution`, `…/fail`                                        | `corrections:operate`                                  |
| `GET /api/admin/integrity`, `GET /api/admin/integrity/runs/:id`                                                                   | `audit:read`                                           |
| `POST /api/admin/integrity/check`                                                                                                 | `integrity:run`                                        |
| `GET /api/admin/incidents`, `GET /api/admin/incidents/:id`                                                                        | `audit:read`                                           |
| `POST /api/admin/incidents`, `PATCH /api/admin/incidents/:id`                                                                     | `incidents:manage` (+ `incidents:resolve` para cerrar) |
| `GET /api/admin/backups`, `…/:id`, `…/status`, `GET /api/admin/restore-tests`, `…/:id`                                            | `backups:read`                                         |
| `GET/POST /api/admin/recovery`, `POST /api/admin/recovery/:id/validation`, `…/approve`, `…/cancel`, `POST /api/admin/maintenance` | `recovery:manage`                                      |
| `GET /api/admin/system/health`                                                                                                    | `system:health`                                        |

## 22. Modelos

`CorrectionRequest`, `CorrectionApproval`, `CorrectionEvent`, `IntegrityCheckRun`, `IntegrityFinding`, `OperationalIncident`, `IncidentHistory`, `BackupExecution`, `BackupArtifact`, `RestoreValidation`, `RestoreRequest`, `SystemMaintenance`; columnas nuevas en `audit_logs`; folios `CORRECTION` (COR-) e `INCIDENT` (INC-). Equivalencias: `AuditEvent` = `AuditLog` ampliado; `AuditOutboxEvent` no necesario (no hay replicación externa); `BackupManifest` = `BackupExecution.manifest` + artefacto MANIFEST; `SecurityEvent` = auditoría `AUTH_*` existente. Migraciones `20261028120000_module15_enums` y `20261028130000_module15_audit_admin_backup` (aplicadas en Neon el 2026-10-21; aditivas; triggers de solo inserción y de no borrado, CHECKs, índices únicos parciales de concurrencia y deduplicación, siembra idempotente de folios y mantenimiento).

## 23. Jobs

| Job                       | Comando                                | Frecuencia recomendada | Estado                 |
| ------------------------- | -------------------------------------- | ---------------------- | ---------------------- |
| Respaldo diario           | `npm run backup:daily`                 | diaria                 | CONFIGURATION_REQUIRED |
| Prueba de restauración    | `npm run restore:monthly`              | mensual                | CONFIGURATION_REQUIRED |
| Diagnóstico de integridad | `npm run integrity:run -- --scheduled` | diaria (opcional)      | CONFIGURATION_REQUIRED |
| Estado                    | `npm run ops -- status`                | bajo demanda           | IMPLEMENTED            |

Todos devuelven JSON con el resultado real y código de salida ≠ 0 al fallar o sin configuración. Reintentos: el respaldo diario reintenta con clave `daily:…:retry-N` si el anterior falló; nunca duplica uno exitoso.

## 24. Variables de entorno (sin valores)

`BACKUP_STORAGE_DIR`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_SOURCE_DATABASE_URL` (opcional, por defecto `DIRECT_URL`), `BACKUP_RETENTION_DAILY_DAYS`, `BACKUP_RETENTION_MONTHLY_MONTHS`, `RESTORE_TEST_DATABASE_URL`, `RECOVERY_TARGET_DATABASE_URL`. Ninguna es `NEXT_PUBLIC_` ni se expone en la interfaz (solo sus nombres cuando faltan).

## 25. Pruebas

| Tipo                          | Archivo                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias                     | `src/modules/admin/module15.test.ts` (taxonomía, saneado y enmascarado, filtros, reglas de correcciones, motor de integridad, incidencias, configuración y credenciales, guardas de destino, cifrado y alteración, formato, evidencias, retención, almacenamiento inmutable) y `src/config/permission-matrix.test.ts`                                                                                                        |
| Integración (PostgreSQL real) | `tests/integration/admin.int.test.ts` (auditoría atómica e inmutable y su visibilidad por rol; correcciones con permisos, concurrencia, autoaprobación y ejecución enlazada real; integridad con inconsistencias inyectadas y sin falsos errores; incidencias sin duplicados; respaldo real, idempotencia, fallo real y alteración; restauración aislada real; recuperación protegida real en base nueva; mantenimiento 503) |
| E2E (Chrome + iPhone)         | `tests/e2e/admin.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                    |

## 26. Limitaciones

- El destino de respaldos implementado es **sistema de archivos**; si está en el mismo equipo que la operación no hay separación real del entorno. Usa un volumen externo o una carpeta sincronizada fuera del equipo, o agrega un driver S3/R2 cuando existan credenciales.
- La carga restaurada usa `session_replication_role = replica`, que requiere privilegios suficientes en el destino (probado en Docker como superusuario; en una rama de Neon debe confirmarse con el rol propietario).
- La restauración exige que el código tenga exactamente las migraciones del respaldo.
- La app web no puede saber si existe una tarea programada; la infiere de respaldos SCHEDULED reales.
- La comprobación FIFO verifica el orden de las aplicaciones de cada abono, no reconstruye el saldo histórico de cada deuda en el instante del pago.
- Neon ofrece restauración propia (PITR/ramas) según el plan; no se usa ni se asume porque no hay API key ni se verificó el plan.

## 27. Integración con el Módulo 16 (implementada)

Los cuatro procesos se ejecutan en Operaciones especiales (`docs/MODULE_16_SPECIAL_OPERATIONS.md`). `CORRECTION_TYPE_META` declara su servicio (`PurchaseReversal`, `SettlementCorrection`, `UnappliedFundsRefund`, `LateChipRedemption`) y `verifyExecutionReference` solo acepta hechos EJECUTADOS. El ejecutor exige la solicitud aprobada (`requireApprovedCorrectionInTx`) y la enlaza en su misma transacción (`linkExecutionInTx`); estos tipos no se enlazan a mano. Solicitar y aprobar generan además `PURCHASE_REVERSAL_REQUESTED/APPROVED` y `SETTLEMENT_CORRECTION_REQUESTED/APPROVED`. El diagnóstico suma 7 comprobaciones (categoría `SPECIAL_OPERATIONS`, 55 en total).
