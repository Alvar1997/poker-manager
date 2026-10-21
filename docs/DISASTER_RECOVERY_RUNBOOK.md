# Runbook de recuperación ante desastres (Módulo 15)

Procedimiento protegido para recuperar Poker Manager desde un respaldo. **Solo SUPERADMIN.** Nunca se sobrescribe la base actual: se restaura en una base **nueva**, se verifica y después se cambia la conexión. Ningún secreto en este documento.

## 0. Antes de empezar

- ¿Es realmente necesario? Un error puntual se corrige con una **corrección excepcional** (Administración → Correcciones), no con una recuperación: recuperar descarta todo lo registrado después del punto del respaldo.
- Ten a mano: la clave `BACKUP_ENCRYPTION_KEY`, el acceso al destino de respaldos y permisos para crear una base en Neon.

## 1. Probar en aislamiento (obligatorio)

1. Crea una base aislada (p. ej. rama de Neon `…_restore_test`) y ponla en `RESTORE_TEST_DATABASE_URL`.
2. `npm run restore:test -- <backupId>`.
3. Debe terminar `PASSED`. Revisa en Administración → Respaldos las comprobaciones (filas y huellas, usuarios, sesiones, compras, inventario, caja, deudas, liquidaciones, auditoría, firmas y evidencias).

## 2. Preparar en la aplicación

1. Administración → Recuperación → **Activar mantenimiento** (motivo + contraseña). La API rechaza escrituras de negocio (503); avisa a cajeros y socios.
2. **Solicitar recuperación**: respaldo, motivo y contraseña. Revisa «Datos posteriores al punto de recuperación»: eso se perderá o deberá recapturarse (anótalo antes de continuar).
3. Si la solicitud no quedó VALIDATED, enlaza la prueba aislada aprobada.
4. **Aprobar** con contraseña y la palabra `RECUPERAR`.

## 3. Ejecutar (CLI, equipo de operación)

1. Crea una base **nueva y vacía** cuyo nombre contenga `recovery` (p. ej. `neondb_recovery_20261021`) y ponla en `RECOVERY_TARGET_DATABASE_URL`.
2. `npm run recovery:execute -- <restoreRequestId>`.
3. El resultado debe ser `passed: true`; la solicitud queda `COMPLETED` con la referencia del destino. Si falla queda `FAILED` con el motivo; la base actual no se tocó.

## 4. Cambio de conexión

1. En el proveedor de despliegue, cambia `DATABASE_URL` y `DIRECT_URL` a la base recuperada (pooler y directa).
2. Reinicia o redespliega la app.
3. Verifica: inicio de sesión, Administración → Estado del sistema, Integridad (ejecuta un diagnóstico) y un reporte de créditos.
4. La base recuperada conserva su propio modo mantenimiento según el respaldo; si está activo, desactívalo desde Recuperación (contraseña).
5. Conserva la base anterior sin borrarla hasta confirmar la operación normal; no la reutilices para operar.

## 5. Después

- Recaptura las operaciones posteriores al punto de recuperación que anotaste (cada una por su flujo normal).
- Revisa `recovery-audit.jsonl` en el destino de respaldos: es el registro externo del procedimiento (la base recuperada no contiene los pasos posteriores a su punto).
- Programa un respaldo manual inmediato (`npm run backup:run`).

## Precauciones

- No ejecutes restauraciones contra la base de producción (el sistema lo rechaza).
- No compartas cadenas de conexión ni la clave por chat o correo.
- Si algo falla a mitad del procedimiento, deja el mantenimiento activo, conserva ambas bases y documenta el estado en una incidencia.
