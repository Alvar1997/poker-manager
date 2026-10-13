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

**Limitación conocida:** si se desactiva un usuario (`isActive = false`), pierde acceso en su próximo login o cuando su JWT expire (8 horas — ver `src/lib/auth.config.ts`), no instantáneamente. Revocación inmediata de sesiones activas queda fuera de alcance del Módulo 00.

### Por qué el `form` de shadcn se escribió a mano (`src/components/ui/form.tsx`)

El registry de shadcn para el estilo `base-nova` (el que usa este proyecto, sobre `@base-ui/react`) tiene el componente `form` como un _stub_ vacío — todavía no publican su implementación para ese estilo. Se escribió un equivalente basado en React Hook Form que evita la dependencia de `@radix-ui/react-slot` (no instalada en este proyecto): `FormControl` clona su hijo con `React.cloneElement` en vez de usar `<Slot>`.

### Por qué los botones usan `render` y no `asChild`

Los componentes de este proyecto están construidos sobre `@base-ui/react`, que usa la prop `render` (no `asChild`, que es la convención de Radix) para renderizado polimórfico. Ejemplo: `<Button render={<Link href="/">Texto</Link>} />`.

## Capas del backend

```
Route Handler  →  Validación (Zod)  →  Autorización  →  Servicio  →  Prisma
   route.ts        src/lib/validation.ts  src/config/permissions.ts  src/modules/*/*.service.ts
```

- `src/lib/api-handler.ts`: envuelve cada Route Handler — genera `requestId`, loguea, captura errores y los traduce al formato de respuesta estándar.
- `src/lib/errors.ts`: `AppError` y subclases (`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `BusinessRuleError`) — cada una mapea a un código HTTP fijo.
- `src/lib/api-response.ts`: formato `{ success, data, message, requestId }` / `{ success: false, error: { code, message, details }, requestId }`.
- `src/config/permissions.ts`: `getCurrentUser`, `requireUser`, `requireRole`, `hasRole` — única fuente de verdad de autorización, siempre en servidor.

## Flujo de una request autenticada típica

1. El navegador llama a un Route Handler bajo `src/app/api/**`.
2. `withApiHandler` genera un `requestId` y arranca el log de la request.
3. El handler valida el body/query con Zod (`parseJsonBody`/`parseQueryParams`).
4. El handler llama a `requireRole(...)` (o `requireUser()`) — lanza `UnauthorizedError`/`ForbiddenError` si no corresponde.
5. El handler delega en un servicio de `src/modules/<dominio>/` (aún no implementado para los módulos de negocio — ver `docs/MODULES.md`).
6. El servicio usa `prisma` (`src/lib/prisma.ts`) — en una `$transaction` si mueve dinero o fichas.
7. La respuesta se devuelve con `ok()`/`fail()`, con el mismo `requestId` en los logs y en la respuesta HTTP.

## Estructura de carpetas

Ver el árbol propuesto en el encargo original — se siguió sin cambios salvo los ya documentados arriba. Los directorios de módulos de negocio (`src/modules/sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) no se crearon vacíos — se documentan en `docs/MODULES.md` y se crean cuando se implementen.

## Decisiones de UI/Mobile

- `next-themes` para claro/oscuro (clase `.dark` en `<html>`, respeta `prefers-color-scheme` por defecto).
- Safe-area insets (`env(safe-area-inset-*)`) aplicados en `globals.css` para notch/gestos de iOS/Android.
- Área táctil mínima recomendada (44px) para acciones primarias en móvil: usar `size="lg"` (h-9) o superior en `<Button>` para CTAs principales; los tamaños `xs`/`sm`/`icon-*` son para UI densa de escritorio/tablas.
