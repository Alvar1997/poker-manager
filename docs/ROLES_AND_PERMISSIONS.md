# Roles y permisos — Poker Manager

Fuente de verdad en código: [`src/config/permission-matrix.ts`](../src/config/permission-matrix.ts). Este documento la explica; si discrepan, manda el código (y hay que corregir este documento).

## Principios

1. **SUPERADMIN y PARTNER poseen prácticamente las mismas capacidades de operación y visibilidad financiera.** Un socio puede consultar y operar todo el negocio: dashboard financiero, caja, ambas mesas, sesiones y arqueos, compras, créditos, abonos, liquidaciones, deudas, ganancias, reportes, fichas, firmas, historial y auditoría de operaciones, y correcciones operativas autorizadas.
2. **La administración de usuarios, roles, seguridad y configuración crítica está reservada exclusivamente a SUPERADMIN.**
3. **CASHIER puede realizar las operaciones normales de caja sin aprobación de socios**: abrir sesiones, contar y arquear, operar ambas mesas, registrar compras y recompras, otorgar crédito, capturar firmas, registrar abonos, liquidar (con compensación FIFO automática) y cerrar. No ve reportes de ganancias globales ni administra nada.
4. **Permisos por capacidad, no por rol suelto.** El código pregunta `requirePermission(PERMISSIONS.CASH_OPERATE)`, nunca `role === "SUPERADMIN"`. Los roles solo existen para agrupar capacidades en la matriz.
5. **Denegado por defecto.** Un permiso que no esté asignado explícitamente a un rol está denegado; un rol desconocido no tiene permisos.
6. **Permisos derivados del rol, no almacenados por usuario.** No hay tabla de permisos por usuario: cambiar la matriz cambia a todos los usuarios de ese rol de forma consistente.
7. **Un permiso no exime de las reglas de negocio.** Tener `sessions:manage` no permite editar una sesión cerrada: el servicio de cada módulo valida además el estado de la operación.

## Matriz

✅ = concedido · — = denegado

| Permiso                | Valor                  | SUPERADMIN | PARTNER | CASHIER |
| ---------------------- | ---------------------- | :--------: | :-----: | :-----: |
| `USERS_READ`           | `users:read`           |     ✅     |    —    |    —    |
| `USERS_CREATE`         | `users:create`         |     ✅     |    —    |    —    |
| `USERS_UPDATE`         | `users:update`         |     ✅     |    —    |    —    |
| `USERS_DISABLE`        | `users:disable`        |     ✅     |    —    |    —    |
| `USERS_RESET_PASSWORD` | `users:reset-password` |     ✅     |    —    |    —    |
| `ROLES_MANAGE`         | `roles:manage`         |     ✅     |    —    |    —    |
| `SETTINGS_MANAGE`      | `settings:manage`      |     ✅     |    —    |    —    |
| `SETTINGS_READ`        | `settings:read`        |     ✅     |   ✅    |    —    |
| `CATALOGS_READ`        | `catalogs:read`        |     ✅     |   ✅    |   ✅    |
| `AUDIT_SECURITY_READ`  | `audit:security-read`  |     ✅     |    —    |    —    |
| `DASHBOARD_VIEW`       | `dashboard:view`       |     ✅     |   ✅    |   ✅    |
| `DASHBOARD_FINANCIAL`  | `dashboard:financial`  |     ✅     |   ✅    |    —    |
| `SESSIONS_READ`        | `sessions:read`        |     ✅     |   ✅    |   ✅    |
| `SESSIONS_MANAGE`      | `sessions:manage`      |     ✅     |   ✅    |   ✅    |
| `PLAYERS_READ`         | `players:read`         |     ✅     |   ✅    |   ✅    |
| `PLAYERS_CREATE`       | `players:create`       |     ✅     |   ✅    |   ✅    |
| `PLAYERS_UPDATE`       | `players:update`       |     ✅     |   ✅    |   ✅    |
| `PLAYERS_MANAGE`       | `players:manage`       |     ✅     |   ✅    |   ✅    |
| `PLAYERS_CONSENT`      | `players:consent`      |     ✅     |   ✅    |   ✅    |
| `CASH_READ`            | `cash:read`            |     ✅     |   ✅    |   ✅    |
| `CASH_OPERATE`         | `cash:operate`         |     ✅     |   ✅    |   ✅    |
| `PURCHASES_READ`       | `purchases:read`       |     ✅     |   ✅    |   ✅    |
| `PURCHASES_CREATE`     | `purchases:create`     |     ✅     |   ✅    |   ✅    |
| `CREDITS_READ`         | `credits:read`         |     ✅     |   ✅    |   ✅    |
| `CREDITS_OPERATE`      | `credits:operate`      |     ✅     |   ✅    |   ✅    |
| `SETTLEMENTS_READ`     | `settlements:read`     |     ✅     |   ✅    |   ✅    |
| `SETTLEMENTS_OPERATE`  | `settlements:operate`  |     ✅     |   ✅    |   ✅    |
| `CHIPS_READ`           | `chips:read`           |     ✅     |   ✅    |   ✅    |
| `CHIPS_OPERATE`        | `chips:operate`        |     ✅     |   ✅    |   ✅    |
| `SIGNATURES_READ`      | `signatures:read`      |     ✅     |   ✅    |   ✅    |
| `SIGNATURES_CAPTURE`   | `signatures:capture`   |     ✅     |   ✅    |   ✅    |
| `CORRECTIONS_OPERATE`  | `corrections:operate`  |     ✅     |   ✅    |    —    |
| `REPORTS_VIEW`         | `reports:view`         |     ✅     |   ✅    |    —    |
| `REPORTS_FINANCIAL`    | `reports:financial`    |     ✅     |   ✅    |    —    |
| `AUDIT_READ`           | `audit:read`           |     ✅     |   ✅    |    —    |

### Decisiones sobre capacidades añadidas

Además de las del encargo se agregaron, sin crear módulos nuevos:

- `USERS_RESET_PASSWORD`: el restablecimiento es una acción distinta (y más sensible) que editar datos.
- `AUDIT_SECURITY_READ`: la auditoría de seguridad (logins, cambios de rol, restablecimientos) es solo para SUPERADMIN; `AUDIT_READ` (auditoría de operaciones) la comparte PARTNER.
- `PLAYERS_*` (Módulo de jugadores), `SIGNATURES_*` (entregas y firma) y `CORRECTIONS_OPERATE` (correcciones auditadas de sesiones cerradas): corresponden a módulos ya listados en `docs/MODULES.md`.
- `CREDITS_*` cubre créditos, deudas, cobros y abonos.

### Alcance del CASHIER

- **Sin `REPORTS_VIEW`**: la consulta de "comprobantes e historial de sus operaciones" se resolverá con los permisos de lectura de cada módulo (`SESSIONS_READ`, `PURCHASES_READ`, `SIGNATURES_READ`…), limitada por el servicio de cada módulo a lo que el cajero necesita. Los reportes (operativos y de ganancias) quedan para SUPERADMIN/PARTNER.
- **Sin `CORRECTIONS_OPERATE`**: el cajero no elimina ni altera movimientos confirmados.
- `CREDITS_READ` sí: necesita consultar deudas para operar compras y liquidaciones.

### Configuración (Módulo 02)

- `settings:read`: caja central, cuenta bancaria (enmascarada), folios y estado de WhatsApp; además permite ver registros inactivos de los catálogos.
- `catalogs:read`: lo que el cajero necesita para operar (parámetros generales, mesas, juegos de fichas, denominaciones, métodos de pago y reglas operativas), solo registros activos.
- `settings:manage` (solo SUPERADMIN): cualquier modificación de configuración.

Detalle por sección y endpoint: `docs/MODULE_02_CONFIGURATION.md`.

### Jugadores (Módulo 03)

- Los tres roles registran, consultan, editan (nombre, apodo, contacto, notas), activan/desactivan y registran el consentimiento de WhatsApp (`players:read/create/update/manage/consent`).
- El historial de teléfonos completo y la auditoría del jugador son datos personales históricos: exigen `audit:read` (SUPERADMIN y PARTNER).
- Crédito: los tres roles lo otorgarán sin autorización adicional y sin límite (`src/config/credit-policy.ts`).

## Dónde se aplica

| Capa                                    | Mecanismo                                                                      | ¿Es defensa real? |
| --------------------------------------- | ------------------------------------------------------------------------------ | ----------------- |
| Endpoints (`src/app/api/**`)            | `requirePermission(PERMISSIONS.X, { requestId })` → 401/403                    | **Sí**            |
| Páginas (Server Components)             | `requirePagePermission(PERMISSIONS.X)` → `/login` o `/dashboard/access-denied` | **Sí**            |
| Servicios (`src/modules/*`)             | Reglas de negocio (último SUPERADMIN, rol propio, estados)                     | **Sí**            |
| Navegación (`src/config/navigation.ts`) | `navigationFor(role)` oculta opciones sin permiso                              | No — solo UX      |
| Proxy (`src/proxy.ts`)                  | Redirige a `/login` sin cookie de sesión                                       | No — solo UX      |

El rol que se evalúa es **el de la base de datos en ese momento**, no el del JWT ni el del body (ver [`docs/AUTHENTICATION.md`](AUTHENTICATION.md)).

Cada `403` de la API o de una página deja un registro `AUTH_ACCESS_DENIED` en `audit_logs` (usuario, permiso, recurso, `requestId`).

## Reglas de administración de usuarios

- Solo SUPERADMIN accede a `/dashboard/users` y a `/api/users/**`.
- Asignar o cambiar un rol requiere además `ROLES_MANAGE`. Como solo SUPERADMIN lo tiene, **no existe ninguna ruta accesible a PARTNER o CASHIER que asigne SUPERADMIN**.
- Nadie puede cambiar su propio rol (403), ni desactivarse a sí mismo (422).
- El sistema nunca queda sin un SUPERADMIN activo: desactivar o degradar al último devuelve 422. La verificación corre en una transacción `Serializable`, así que dos SUPERADMIN desactivándose mutuamente a la vez no pueden dejar el sistema sin administrador.
- No hay borrado físico de usuarios (no existe `DELETE`): se desactivan y conservan su historial.
- Configuración inicial: 1 SUPERADMIN, 2 PARTNER, 1 CASHIER. Son números iniciales, no límites.

## Navegación por rol

| Opción               | Permiso que la muestra | SUPERADMIN | PARTNER | CASHIER | Estado                                                               |
| -------------------- | ---------------------- | :--------: | :-----: | :-----: | -------------------------------------------------------------------- |
| Inicio               | `dashboard:view`       |     ✅     |   ✅    |   ✅    | Disponible                                                           |
| Sesiones y mesas     | `sessions:read`        |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Jugadores            | `players:read`         |     ✅     |   ✅    |   ✅    | Disponible (Módulo 03)                                               |
| Compras y recompras  | `purchases:read`       |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Fichas               | `chips:read`           |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Caja                 | `cash:read`            |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Créditos y abonos    | `credits:read`         |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Liquidaciones        | `settlements:read`     |     ✅     |   ✅    |   ✅    | Próximamente                                                         |
| Reportes y ganancias | `reports:financial`    |     ✅     |   ✅    |    —    | Próximamente                                                         |
| Auditoría            | `audit:read`           |     ✅     |   ✅    |    —    | Próximamente                                                         |
| Usuarios             | `users:read`           |     ✅     |    —    |    —    | Disponible                                                           |
| Configuración        | `catalogs:read`        |     ✅     |   ✅    |   ✅    | Disponible (Módulo 02; secciones por permiso, solo SUPERADMIN edita) |
| Mi perfil            | (cualquier sesión)     |     ✅     |   ✅    |   ✅    | Disponible                                                           |

Las opciones "Próximamente" se muestran sin enlace ni acción: no aparentan operaciones que todavía no existen. Al construir un módulo se cambia `available: true` en `NAV_ITEMS`.

## Cómo agregar un permiso en un módulo futuro

1. Agrégalo a `PERMISSIONS` en `src/config/permission-matrix.ts`.
2. Si es administrativo, agrégalo a `ADMIN_ONLY_PERMISSIONS` (PARTNER lo pierde automáticamente). Si lo necesita el cajero, agrégalo a `CASHIER_PERMISSIONS`.
3. Protege el endpoint con `requirePermission` y la página con `requirePagePermission`.
4. Actualiza la matriz de este documento y `src/config/permission-matrix.test.ts`.
