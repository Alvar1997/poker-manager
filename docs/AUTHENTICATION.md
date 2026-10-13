# Autenticación y seguridad — Poker Manager

Cómo se inicia y cierra sesión, cómo se valida cada request y qué protecciones existen. Permisos por rol: [`docs/ROLES_AND_PERMISSIONS.md`](ROLES_AND_PERMISSIONS.md).

## Componentes

| Archivo                              | Responsabilidad                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/lib/auth.config.ts`             | Config de Auth.js sin Prisma: estrategia JWT, `maxAge` 8 h, callbacks que copian claims al token |
| `src/lib/auth.ts`                    | Auth.js completo: provider Credentials → `authenticateWithCredentials`, evento de logout         |
| `src/modules/auth/auth.service.ts`   | Login, `loadSessionUser` (validación contra BD), perfil, cambio de contraseña                    |
| `src/modules/auth/login-throttle.ts` | Limitador de intentos de login persistido en Postgres                                            |
| `src/config/permissions.ts`          | `getCurrentUser`, `requireUser`, `requirePermission`, `requirePagePermission`                    |
| `src/lib/password.ts`                | bcrypt (costo 12), credenciales temporales, igualador de tiempos                                 |
| `src/modules/audit/audit.service.ts` | Registro de eventos de seguridad (sin secretos)                                                  |
| `src/proxy.ts`                       | Redirección UX a `/login` si no hay cookie                                                       |

## Inicio de sesión

Lo resuelve Auth.js (`POST /api/auth/callback/credentials`, con su token CSRF de doble envío). **No hay endpoints propios de login/logout.**

`authenticateWithCredentials`:

1. Valida el body con Zod (`loginSchema`).
2. Si el correo o la IP están bloqueados por el limitador → rechaza con código `rate_limited` (sin verificar la contraseña) y audita `AUTH_LOGIN_RATE_LIMITED`.
3. Busca el usuario por correo normalizado (minúsculas).
4. Cuenta inexistente o **inactiva** → ejecuta un bcrypt descartable (mismo tiempo de respuesta) y rechaza.
5. Contraseña incorrecta → rechaza.
6. Cualquier rechazo: suma un fallo al limitador y audita `AUTH_LOGIN_FAILED` (con el motivo interno: `unknown_account`/`inactive`/`bad_password`, que **nunca** se expone al cliente).
7. Éxito: limpia el contador del correo, actualiza `lastLoginAt`, audita `AUTH_LOGIN_SUCCEEDED` y entrega a Auth.js `{ id, name, email, role, isActive, sessionVersion }` (nunca `passwordHash`).

El cliente solo ve dos mensajes: "Correo o contraseña incorrectos." o "Demasiados intentos fallidos…". El bloqueo se aplica igual a correos inexistentes, así que tampoco permite enumerar cuentas.

### Limitador de intentos

| Clave                       | Umbral                  | Bloqueo |
| --------------------------- | ----------------------- | ------- |
| `email:<sha256 del correo>` | 5 fallos en 15 minutos  | 15 min  |
| `ip:<dirección>`            | 30 fallos en 15 minutos | 15 min  |
| `password-change:<userId>`  | 5 fallos en 15 minutos  | 15 min  |

- Persistido en la tabla `login_throttles` (en serverless no hay memoria compartida entre instancias). Actualización atómica con `INSERT … ON CONFLICT`.
- El correo se guarda como hash: la tabla no contiene PII en claro.
- La IP viene de `x-forwarded-for` (fijado por Vercel). Fuera de un proxy de confianza es falsificable; por eso el control principal es por correo.

## Sesión

- **Estrategia JWT** (Credentials de Auth.js no admite el adaptador de base de datos). No existen modelos `Account`/`Session`/`VerificationToken`.
- **Cookies**: `httpOnly`, `SameSite=Lax`; en producción (`AUTH_URL` https) con flag `Secure` y prefijo `__Secure-`. Ningún token se guarda en `localStorage` ni es legible desde JavaScript.
- **Expiración**: 8 horas (`SESSION_MAX_AGE_SECONDS`).
- **Claims del JWT**: `id`, `role`, `isActive`, `sessionVersion`. Son una pista para la UI y el proxy, **no** para autorizar.

### Validación en cada request (revocación inmediata)

`getCurrentUser()` decodifica el JWT y luego **lee al usuario en la base** (`loadSessionUser`). La sesión se considera inválida si:

- el usuario ya no existe,
- `isActive = false`, o
- `user.sessionVersion !== token.sessionVersion`.

`User.sessionVersion` se incrementa al:

| Evento                          | Efecto                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Cambiar la contraseña propia    | Todas las sesiones del usuario (incluida la actual) caducan; debe volver a entrar |
| Restablecimiento por SUPERADMIN | Todas las sesiones del usuario caducan                                            |
| Cambio de rol                   | Todas las sesiones del usuario caducan                                            |
| Desactivación                   | Todas las sesiones caducan (además `isActive=false`)                              |

Así, desactivar a alguien o cambiar su rol surte efecto en su **siguiente request**, no al expirar el JWT. El rol y el estado usados para autorizar siempre son los vigentes en la base, nunca los que diga el navegador. La consulta es una lectura por clave primaria, memoizada por request con `React.cache`.

## Cierre de sesión

`signOut()` de Auth.js (POST con CSRF) borra la cookie; el evento `signOut` audita `AUTH_LOGOUT`. Disponible en el header y en `/dashboard/profile`.

## Credenciales iniciales y restablecimiento

- No hay registro público. El primer SUPERADMIN se crea con `npm run db:seed` (contraseña por variable de entorno, nunca en el código); el resto, desde la administración de usuarios.
- Al crear un usuario o restablecer su contraseña, el **servidor genera una credencial temporal aleatoria** (`crypto.randomInt`, 20 caracteres sin ambiguos ≈ 114 bits) y la devuelve **una sola vez** al SUPERADMIN (respuesta con `Cache-Control: no-store`). Se guarda solo su hash.
- El usuario queda con `mustChangePassword = true`: al entrar solo ve la pantalla "Cambia tu contraseña temporal", y `requirePermission` rechaza cualquier otra acción (403) hasta que la cambie.
- **No se envían credenciales por correo.** El SUPERADMIN la entrega en persona. Un flujo de recuperación por correo con token de un solo uso queda fuera de alcance (ver pendientes en `docs/MODULES.md`).

### Política de contraseñas

Mínimo 12 caracteres, con letras y números, máximo 72 bytes (límite real de bcrypt), distinta de la actual. Definida en `src/modules/auth/auth.schemas.ts` (la misma validación en cliente y servidor).

## CSRF

- Rutas de Auth.js: token CSRF propio de Auth.js.
- API propia (`withApiHandler`): la cookie `SameSite=Lax` no viaja en POST/PATCH desde otro sitio, y además `assertSameOrigin` rechaza con 403 cualquier método mutante con `Sec-Fetch-Site` cross-site o un `Origin` distinto del host.

## Protección de rutas

| Tipo                  | Sin sesión                                            | Sin permiso                                          |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Página `/dashboard/*` | Redirección a `/login?callbackUrl=…` (proxy y layout) | Redirección a `/dashboard/access-denied` + auditoría |
| API `/api/**`         | `401 UNAUTHORIZED`                                    | `403 FORBIDDEN` + auditoría                          |

`callbackUrl` solo acepta rutas internas (evita redirecciones abiertas).

## Auditoría de seguridad

Tabla `audit_logs`: usuario responsable (`actorUserId`), acción, entidad (`entityType`/`entityId`), fecha (`createdAt`), `requestId`, resultado (`SUCCESS`/`FAILURE`/`DENIED`) y metadatos permitidos.

| Acción                                                  | Cuándo                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `AUTH_LOGIN_SUCCEEDED`                                  | Login correcto                                        |
| `AUTH_LOGIN_FAILED`                                     | Credenciales inválidas, cuenta inactiva o inexistente |
| `AUTH_LOGIN_RATE_LIMITED`                               | Intento durante un bloqueo                            |
| `AUTH_LOGOUT`                                           | Cierre de sesión                                      |
| `AUTH_ACCESS_DENIED`                                    | 403 en API o página                                   |
| `AUTH_PASSWORD_CHANGED` / `AUTH_PASSWORD_CHANGE_FAILED` | Cambio de contraseña propia                           |
| `AUTH_PROFILE_UPDATED`                                  | Cambio de nombre propio                               |
| `USER_CREATED`                                          | Alta de usuario                                       |
| `USER_UPDATED`                                          | Cambio de nombre/correo (con valores antes/después)   |
| `USER_ROLE_CHANGED`                                     | Cambio de rol (antes/después)                         |
| `USER_ACTIVATED` / `USER_DEACTIVATED`                   | Cambio de estado                                      |
| `USER_PASSWORD_RESET`                                   | Restablecimiento por SUPERADMIN                       |

Garantías:

- Las mutaciones administrativas auditan **dentro de la misma transacción**: si la auditoría falla, el cambio no se aplica.
- `sanitizeMetadata` elimina cualquier clave que parezca contener secretos (`password`, `hash`, `token`, `secret`, `cookie`, `authorization`).
- **Inmutable a nivel base de datos**: un trigger rechaza todo `UPDATE`/`DELETE` sobre `audit_logs`. Ni un bug de la aplicación puede alterar el historial.

## Pruebas relacionadas

- Unitarias: `src/config/permission-matrix.test.ts`, `src/config/permissions.test.ts`, `src/config/navigation.test.ts`, `src/modules/auth/auth.schemas.test.ts`, `src/lib/api-handler.test.ts`, `src/lib/password.test.ts`.
- Integración (Postgres real): `tests/integration/*.int.test.ts`.
- E2E (sesión real en Chrome y iPhone/WebKit): `tests/e2e/auth-and-users.spec.ts`.
