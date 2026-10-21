# Poker Manager

Aplicación web privada para administrar sesiones presenciales de póker: caja central, mesas simultáneas, inventario de fichas, compras, créditos, liquidaciones y notificaciones por WhatsApp.

> **Estado:** Módulos 00 a 12 completados (infraestructura, usuarios y seguridad, configuración, jugadores, inventario de fichas compartido y nominal, caja central, sesiones y apertura, mesas y participación, compras y recompras por importe, firmas de reconocimiento de crédito y comprobantes digitales PNG, créditos y abonos FIFO con custodia administrativa, liquidaciones con firma obligatoria, compensación opcional y pagos pendientes, cierre de mesas y sesiones con arqueo global único, caja final en $0 y confirmación de socio) y Módulo 14 (reportes y estadísticas: deuda por jugador, sesión de origen y compra, deuda al cierre vs actual, finanzas separadas, comparativos y exportación XLSX). Módulo 15 (auditoría, correcciones excepcionales, integridad, incidencias, respaldos cifrados con verificación, pruebas de restauración y recuperación protegida; la programación diaria de respaldos requiere configuración, ver `docs/BACKUP_SETUP.md`). Módulo 16 (operaciones financieras especiales: canje posterior de fichas, reverso completo de compras, corrección de liquidaciones con pagos y devolución de fondos no aplicados, siempre con movimientos reales). El Módulo 13 (WhatsApp) está en pausa. Ver [`docs/MODULES.md`](docs/MODULES.md).

## Stack

Next.js 16 (App Router) · TypeScript estricto · Tailwind CSS 4 · shadcn/ui (`base-nova`, sobre `@base-ui/react`) · Prisma ORM 7 + Neon PostgreSQL · Auth.js v5 (Credentials + JWT) · TanStack Query · Zod · React Hook Form · Vitest · Playwright.

Decisiones y versiones exactas: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requisitos

- Node.js ≥ 22 (LTS; probado con 22.13.1)
- npm ≥ 11
- Una base de datos PostgreSQL en [Neon](https://neon.tech)

## Instalación

```bash
npm install
cp .env.example .env.local   # completa DATABASE_URL, DIRECT_URL, AUTH_SECRET…
openssl rand -base64 33       # genera un valor para AUTH_SECRET (pégalo en .env.local)
npm run db:migrate            # crea las tablas en tu base de Neon
```

Guía detallada paso a paso (incluye cómo obtener las credenciales de Neon): [`docs/SETUP.md`](docs/SETUP.md).

## Primer usuario (SUPERADMIN)

No hay registro público. El primer SUPERADMIN se crea con:

```bash
SEED_SUPERADMIN_NAME="Tu Nombre" \
SEED_SUPERADMIN_EMAIL="tu@correo.com" \
SEED_SUPERADMIN_PASSWORD="una-contraseña-fuerte-de-al-menos-12-caracteres" \
npm run db:seed
```

Es idempotente: si ya existe un SUPERADMIN, no hace nada.

## Ejecución

```bash
npm run dev      # http://localhost:3000
```

## Scripts disponibles

| Script                            | Qué hace                                                                  |
| --------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`                     | Servidor de desarrollo (Turbopack)                                        |
| `npm run build`                   | Build de producción                                                       |
| `npm run start`                   | Sirve el build de producción                                              |
| `npm run lint`                    | ESLint                                                                    |
| `npm run typecheck`               | `tsc --noEmit`                                                            |
| `npm test`                        | Pruebas unitarias (Vitest)                                                |
| `npm run test:watch`              | Vitest en modo watch                                                      |
| `npm run test:integration`        | Integración contra Postgres real (`TEST_DATABASE_URL`, ver docs/SETUP.md) |
| `npm run test:e2e`                | Pruebas E2E (Playwright)                                                  |
| `npm run db:generate`             | Regenera el cliente de Prisma                                             |
| `npm run db:migrate`              | Aplica migraciones en desarrollo                                          |
| `npm run db:deploy`               | Aplica migraciones en producción                                          |
| `npm run db:studio`               | Abre Prisma Studio                                                        |
| `npm run db:seed`                 | Bootstrap del primer SUPERADMIN                                           |
| `npm run format` / `format:check` | Prettier                                                                  |

## Documentación

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — arquitectura, decisiones técnicas, capas, flujo de una request.
- [`docs/DATABASE.md`](docs/DATABASE.md) — Neon, Prisma, conexiones, migraciones, variables.
- [`docs/BUSINESS_RULES.md`](docs/BUSINESS_RULES.md) — reglas de negocio conocidas del dominio.
- [`docs/MODULES.md`](docs/MODULES.md) — checklist de los 16 módulos (00–15).
- [`docs/SETUP.md`](docs/SETUP.md) — guía de configuración desde cero en macOS.
- [`CLAUDE.md`](CLAUDE.md) — reglas permanentes para trabajar en este repo con asistencia de IA.
