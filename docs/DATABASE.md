# Base de datos — Neon + Prisma

## Proveedor

PostgreSQL alojado en [Neon](https://neon.tech). No se usa la base administrada de Prisma (Prisma Postgres) ni Supabase/Firebase.

## Dos cadenas de conexión — por qué

Neon ofrece una conexión **pooled** (vía PgBouncer, puerto con sufijo `-pooler`) y una **directa**. Prisma 7 las usa en lugares distintos:

| Variable       | Conexión              | Usada por                                                                                       |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Pooled                | El runtime de la app (`src/lib/prisma.ts`, vía `PrismaPg` adapter)                              |
| `DIRECT_URL`   | Directa (sin pooling) | El motor de migraciones (`prisma migrate`, `prisma studio`) — configurado en `prisma.config.ts` |

Usar la conexión pooled para migraciones puede fallar (PgBouncer en modo transacción no soporta algunas operaciones DDL/prepared statements que Migrate necesita) — por eso Neon recomienda separar ambas, y así quedó configurado.

## Cómo obtener las credenciales (si no las tienes)

1. Crea una cuenta/proyecto en [neon.tech](https://neon.tech).
2. En el dashboard del proyecto → **Connect** → copia:
   - **Pooled connection** → `DATABASE_URL`
   - **Direct connection** → `DIRECT_URL`
3. Pégalas en tu `.env.local` (nunca en `.env` ni en un archivo versionado).

**Nadie debe inventar estas URLs.** Si no las tienes, todo lo que no dependa de una conexión real ya está implementado (ver reporte del Módulo 00) — migra y haz seed en cuanto las tengas.

## Prisma 7: dónde vive cada cosa

- `prisma/schema.prisma`: solo modelos + `datasource { provider = "postgresql" }` (sin `url`/`directUrl` — Prisma 7 los rechaza aquí, ver `docs/ARCHITECTURE.md`).
- `prisma.config.ts`: `datasource.url` (usa `DIRECT_URL`, para Migrate/Studio), ruta de `schema` y de `migrations`.
- `src/lib/prisma.ts`: el `PrismaClient` de runtime, construido perezosamente con `new PrismaPg({ connectionString: DATABASE_URL })`.

## Generar el cliente

```bash
npm run db:generate
```

Se genera en `src/generated/prisma/` (ignorado por git — se regenera en cada instalación/build vía este script; no se versiona).

## Migraciones

```bash
npm run db:migrate   # desarrollo: crea y aplica una migración nueva
npm run db:deploy    # producción: aplica migraciones pendientes sin generar nuevas
npm run db:studio    # explorador visual de la base
```

## Modelos (Módulos 00–01)

- `User` (`@@map("users")`): `id`, `name`, `email` (único), `passwordHash`, `role` (`Role`: `SUPERADMIN`/`PARTNER`/`CASHIER`), `isActive`, `createdAt`, `updatedAt`, `lastLoginAt?`; desde el Módulo 01: `mustChangePassword` (credencial temporal pendiente), `passwordChangedAt?`, `sessionVersion` (revocación de sesiones), `createdById?`/`updatedById?` → `User`. Nunca se borra físicamente.
- `AuditLog` (`@@map("audit_logs")`): `id`, `actorUserId?` → `User`, `action`, `entityType`, `entityId?`, `result` (`AuditResult`: `SUCCESS`/`FAILURE`/`DENIED`), `requestId?`, `metadata` (`Json?`), `createdAt`. **Nunca** contiene contraseñas/tokens/secretos. **Solo inserción**: un trigger (`audit_logs_immutable`) rechaza `UPDATE`/`DELETE`.
- `LoginThrottle` (`@@map("login_throttles")`): `key` (`email:<sha256>` / `ip:<ip>` / `password-change:<userId>`), `failures`, `windowStartedAt`, `lockedUntil?`, `updatedAt`. Limitador de intentos de login — ver `docs/AUTHENTICATION.md`.

Migraciones: `20261013044915_init` (Módulo 00) y `20261013180000_module01_security` (Módulo 01, aditiva).

## Backups

Neon mantiene point-in-time recovery según el plan de tu proyecto (revisa el dashboard de Neon → Settings → Backups/Restore). No hay un mecanismo de backup adicional implementado en la aplicación — queda fuera de alcance del Módulo 00.

## Qué NO hacer

- No ejecutar `prisma migrate dev` ni `db push` contra una base de producción.
- No commitear `.env`/`.env.local` con credenciales reales.
- No usar `DATABASE_URL` (pooled) para migraciones.
