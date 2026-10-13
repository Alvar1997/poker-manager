# Arquitectura — Poker Manager

## Versiones (verificadas en npm registry al construir el Módulo 00)

| Paquete                                      | Versión              | Nota                                                          |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Next.js                                      | 16.4.0               | App Router, Turbopack                                         |
| React / React DOM                            | 19.3.0               |                                                               |
| TypeScript                                   | 5.x (`strict: true`) |                                                               |
| Tailwind CSS                                 | 4.x                  | config CSS-first, sin `tailwind.config.js`                    |
| shadcn/ui (CLI)                              | 4.21.4               | estilo `base-nova`, sobre `@base-ui/react` (no Radix)         |
| Prisma + @prisma/client + @prisma/adapter-pg | 7.10.0               | estable — se descartó `8.0.0-rc.22` por ser release candidate |
| next-auth (Auth.js)                          | 5.0.0-beta.32        | ver nota abajo                                                |
| @tanstack/react-query                        | 5.104.2              |                                                               |
| Zod                                          | 4.6.7                |                                                               |
| react-hook-form / @hookform/resolvers        | 7.90.0 / 5.9.1       |                                                               |
| date-fns                                     | 4.4.0                |                                                               |
| bcryptjs                                     | 3.0.3                | puro JS, sin bindings nativos                                 |
| pino                                         | 10.4.0               | logger estructurado                                           |
| Vitest / @testing-library/react              | 5.0.4 / 16.3.3       |                                                               |
| Playwright                                   | 1.64.0               |                                                               |

### Por qué Auth.js v5 (beta) y no v4

`next-auth@4` (última estable, 4.24.15) es la rama **Pages Router**; no tiene soporte real de Route Handlers de App Router. `next-auth@5` lleva ~2 años en beta pero es la línea diseñada para App Router y es la que recomienda la documentación oficial para este caso. Se usa deliberadamente, documentado aquí para que quede claro que no es un descuido.

### Por qué Prisma 7 cambió `schema.prisma`

En Prisma 7, `datasource.url`/`directUrl` **ya no se declaran en `schema.prisma`** (el motor de migraciones lo rechaza con `P1012`). La URL de runtime se pasa como `adapter` al construir `PrismaClient` (ver `src/lib/prisma.ts`, usa `DATABASE_URL` pooled); la URL para Migrate/Studio se configura en `prisma.config.ts` → `datasource.url` (usa `DIRECT_URL`, sin pooling — Neon lo requiere para DDL). Son dos mecanismos independientes.

### Por qué el cliente Prisma es perezoso (`src/lib/prisma.ts`)

Mientras no exista una base de Neon real, `next build` no debe fallar por falta de credenciales. `src/lib/prisma.ts` expone un `Proxy` que solo construye el `PrismaClient` real (y solo entonces valida `DATABASE_URL`) en el primer acceso a una propiedad — no al importar el módulo. Así:

- El build compila y tipa sin DB.
- `/api/health/ready` sí falla de verdad (503) si la DB no responde — no hay una ruta "falsa" de éxito.

### Por qué `src/lib/auth.ts` está partido en dos archivos

`src/proxy.ts` (el middleware/proxy de Next, protege `/dashboard`) corre en **Edge Runtime**. El cliente de Prisma generado y `bcryptjs` usan APIs de Node (`node:path`, etc.) que Edge Runtime no soporta — intentarlo rompe el build (`A Node.js module is loaded… not supported in the Edge Runtime`). Por eso:

- `src/lib/auth.config.ts`: la parte _edge-safe_ de la config de Auth.js (sesión JWT, páginas, callbacks) — **sin** el provider de Credentials.
- `src/lib/auth.ts`: la config completa, con el provider de Credentials (que sí usa Prisma + bcryptjs) — se usa solo en Route Handlers/Server Components (Node runtime).
- `src/proxy.ts` construye su propia instancia ligera de `auth()` a partir de `auth.config.ts`, sin tocar Prisma.

### Por qué `cacheComponents`/`partialPrefetching` están desactivados

`next.config.ts` generado por `create-next-app` 16 los activa por defecto. Son incompatibles con `export const dynamic = "force-dynamic"` en Route Handlers (como los health checks) y, en general, exigen anotar explícitamente qué se cachea. Esta aplicación es dinámica por naturaleza (auth, caja en tiempo real) — se desactivaron para mantener el modelo de renderizado simple, como pide el alcance del Módulo 00.

### Por qué no hay modelos `Account`/`Session`/`VerificationToken`

Auth.js con `Credentials` provider no es compatible con el adaptador de base de datos (la verificación de credenciales es responsabilidad de `authorize`, y Auth.js solo soporta sesión JWT en ese caso). No hacían falta esos modelos para el Módulo 00.

~~Limitación del Módulo 00: la desactivación solo surtía efecto al expirar el JWT.~~ **Resuelto en el Módulo 01:** cada request valida al usuario contra la base (`isActive` + `sessionVersion`), así que desactivar, cambiar el rol o cambiar/restablecer la contraseña invalida las sesiones existentes de inmediato. Ver `docs/AUTHENTICATION.md`.

### Por qué el `form` de shadcn se escribió a mano (`src/components/ui/form.tsx`)

El registry de shadcn para el estilo `base-nova` (el que usa este proyecto, sobre `@base-ui/react`) tiene el componente `form` como un _stub_ vacío — todavía no publican su implementación para ese estilo. Se escribió un equivalente basado en React Hook Form que evita la dependencia de `@radix-ui/react-slot` (no instalada en este proyecto): `FormControl` clona su hijo con `React.cloneElement` en vez de usar `<Slot>`.

### Por qué los botones usan `render` y no `asChild`

Los componentes de este proyecto están construidos sobre `@base-ui/react`, que usa la prop `render` (no `asChild`, que es la convención de Radix) para renderizado polimórfico. Ejemplo: `<Button render={<Link href="/">Texto</Link>} />`.

## Capas del backend

```
Route Handler  →  Autenticación/Autorización  →  Validación (Zod)  →  Servicio  →  Prisma
   route.ts        src/config/permissions.ts       src/lib/validation.ts  src/modules/*/*.service.ts
```

**Cambio en el Módulo 01:** la autorización va **antes** de la validación del body. Así un usuario sin sesión siempre recibe 401 (y uno sin permiso 403) sin importar lo que envíe, y no se revela la forma del contrato a quien no puede usarlo. Si un campo del body exige un permiso adicional (p. ej. `role` → `roles:manage`), se verifica justo después de validar.

- `src/lib/api-handler.ts`: envuelve cada Route Handler — genera `requestId`, loguea, captura errores y los traduce al formato de respuesta estándar.
- `src/lib/errors.ts`: `AppError` y subclases (`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `BusinessRuleError`) — cada una mapea a un código HTTP fijo.
- `src/lib/api-response.ts`: formato `{ success, data, message, requestId }` / `{ success: false, error: { code, message, details }, requestId }`.
- `src/config/permission-matrix.ts`: **única fuente de verdad** de roles → permisos (capacidades). Puro, lo usan servidor y navegación.
- `src/config/permissions.ts`: `getCurrentUser` (valida el JWT contra la base: usuario activo + `sessionVersion`), `requireUser`, `requirePermission`, `requirePagePermission`, `can`. Reemplaza a `requireRole`/`hasRole` del Módulo 00 (autorización por capacidad, no por rol). Ver `docs/ROLES_AND_PERMISSIONS.md` y `docs/AUTHENTICATION.md`.
- `src/lib/api-handler.ts`: además rechaza con 403 las mutaciones de otro origen (`assertSameOrigin`, defensa CSRF).
- `src/modules/audit/audit.service.ts`: `recordAudit` (dentro de transacciones) y `recordAuditSafe` (eventos que no deben bloquear la respuesta).

## Flujo de una request autenticada típica

1. El navegador llama a un Route Handler bajo `src/app/api/**`.
2. `withApiHandler` genera un `requestId` y arranca el log de la request.
3. El handler llama a `requirePermission(PERMISSIONS.X, { requestId })` (o `requireUser()`) — lanza `UnauthorizedError`/`ForbiddenError` si no corresponde; los 403 se auditan.
4. El handler valida el body/query con Zod (`parseJsonBody`/`parseQueryParams`); los schemas de entrada son `strictObject` (campos no previstos → 400).
5. El handler delega en un servicio de `src/modules/<dominio>/` (`users`, `auth`, `audit` desde el Módulo 01).
6. El servicio usa `prisma` (`src/lib/prisma.ts`) — en una `$transaction` si mueve dinero o fichas.
7. La respuesta se devuelve con `ok()`/`fail()`, con el mismo `requestId` en los logs y en la respuesta HTTP.

## Estructura de carpetas

Ver el árbol propuesto en el encargo original — se siguió sin cambios salvo los ya documentados arriba. Los directorios de módulos de negocio (`src/modules/sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) no se crearon vacíos — se documentan en `docs/MODULES.md` y se crean cuando se implementen.

## Decisiones del Módulo 01

- **Sin dependencias nuevas.** Se agregaron los componentes shadcn `dropdown-menu` y `alert-dialog` (código copiado al repo, sobre `@base-ui/react` ya instalado).
- **Modelo nuevo `LoginThrottle`** (justificación): el limitador de intentos debe compartirse entre instancias serverless; la memoria del proceso no sirve. No se crearon modelos de sesión (JWT) ni de tokens de recuperación (no hay recuperación por correo todavía).
- **`sessionVersion` en `User`** en vez de una tabla de sesiones: con JWT basta un contador para revocar todas las sesiones de un usuario, sin duplicar lo que Auth.js ya maneja.
- **Permisos derivados del rol**, no almacenados por usuario.
- **Credenciales temporales generadas por el servidor** y mostradas una sola vez (no se envían por correo).
- **Trigger de inmutabilidad en `audit_logs`** (en la migración): la auditoría no se puede alterar ni borrar ni por un bug.
- **`forbidden()` de Next no se usa**: sigue siendo experimental en 16.4 (`authInterrupts`); se redirige a `/dashboard/access-denied`.
- **Pruebas de integración contra Postgres real** (`prisma dev`, sin Docker) con salvaguarda que impide apuntar a una base remota.
- **Proxy en Node**: en Next 16 `proxy.ts` corre en Node.js; se mantiene ligero de todas formas (sin Prisma).

## Decisiones del Módulo 02

- **Rutas en español bajo `/dashboard`**: `/dashboard/configuracion/*` conserva la protección del proxy y el layout del Módulo 01. `/configuracion/*` redirige allí (`next.config.ts`).
- **Montos como string en la API, `Decimal` en la base** (`src/lib/money.ts`): ningún `number` de JS toca dinero. `positiveMoneySchema` es puro (sirve en cliente y servidor).
- **Singletons con `CHECK (id = 1)`** y caja única con `CHECK (code = 'MAIN')`: la unicidad la garantiza la base, no solo el código.
- **Reglas fijas como constantes tipadas** (`src/config/operational-rules.ts`), no como columnas editables. Solo las políticas de efectivo se persisten (`enum` de un valor). No hay motor genérico de reglas.
- **Cifrado de datos bancarios** con AES-256-GCM (`src/lib/crypto.ts`) y clave en `SETTINGS_ENCRYPTION_KEY`, con últimos 4 dígitos en claro para enmascarar. Sin la clave se puede usar todo el sistema, pero no capturar números.
- **Folios con `UPDATE … RETURNING`**: atómico sin locks explícitos; la edición del formato usa `updateMany` condicionado a `lastIssuedAt IS NULL`.
- **Permisos nuevos `settings:read` y `catalogs:read`** en la misma matriz del Módulo 01; secciones de configuración filtradas por capacidad (`src/config/settings-sections.ts`).
- **Enlaces con estilo de botón**: `<Link className={buttonVariants()}>`, no `<Button render={<Link/>}>`. Con `nativeButton={false}`, Base UI agrega `role="button"` y el enlace deja de anunciarse como enlace.
- **Sin dependencias nuevas.**

## Decisiones de UI/Mobile

- `next-themes` para claro/oscuro (clase `.dark` en `<html>`, respeta `prefers-color-scheme` por defecto).
- Safe-area insets (`env(safe-area-inset-*)`) aplicados en `globals.css` para notch/gestos de iOS/Android.
- Área táctil mínima recomendada (44px) para acciones primarias en móvil: usar `size="lg"` (h-9) o superior en `<Button>` para CTAs principales; los tamaños `xs`/`sm`/`icon-*` son para UI densa de escritorio/tablas.
- Desde el Módulo 01, inputs y botones de formularios usan `h-11 md:h-9` (44px en celular), los selects son nativos (`NativeSelect`, abren el selector del sistema) y los listados usan tarjetas en vez de tablas.
- Navegación: barra lateral en `md+`; en celular, menú a pantalla completa desde el header.
