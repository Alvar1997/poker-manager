# Guía de configuración (macOS)

Pasos verificados en este repositorio (macOS, Apple Silicon, zsh). Si usas otro shell/OS, ajusta solo la sintaxis de variables de entorno.

## 1. Node.js

```bash
node --version   # se probó con v22.13.1 — cualquier Node 22 LTS funciona
npm --version     # 11.x
```

Si no tienes Node 22, instálalo con [nvm](https://github.com/nvm-sh/nvm) o el instalador oficial de [nodejs.org](https://nodejs.org).

## 2. Clonar e instalar dependencias

```bash
cd poker-manager
npm install
```

## 3. Crear el proyecto en Neon

1. Entra a [neon.tech](https://neon.tech) y crea una cuenta/proyecto (tiene plan gratuito).
2. En el dashboard del proyecto, pestaña **Connect**, verás dos cadenas:
   - **Pooled connection** (el host tiene el sufijo `-pooler`) → esta es tu `DATABASE_URL`.
   - **Direct connection** → esta es tu `DIRECT_URL`.
3. Copia ambas — las necesitas en el paso 4.

## 4. Variables de entorno

```bash
cp .env.example .env.local
```

Edita `.env.local`:

```dotenv
DATABASE_URL="<pooled connection de Neon>"
DIRECT_URL="<direct connection de Neon>"
AUTH_SECRET=""              # lo genera el siguiente comando
AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_APP_NAME="Poker Manager"
APP_TIMEZONE="America/Monterrey"
```

Genera `AUTH_SECRET`:

```bash
openssl rand -base64 33
```

Pega el valor directamente en `.env.local`. (**No** uses `npx auth secret` — ese comando instala y ejecuta el paquete npm `auth`, que es el CLI de _Better Auth_, una librería completamente distinta a Auth.js/next-auth que usa este proyecto. `openssl` viene preinstalado en macOS y no depende de terceros.)

**Nunca** commitees `.env.local`. Ya está en `.gitignore` (`.env*`, con excepción explícita de `.env.example`).

## 5. Migrar la base de datos

```bash
npm run db:generate   # genera el cliente de Prisma (src/generated/prisma)
npm run db:migrate    # crea las tablas en tu base de Neon
```

Si ves un error de conexión, revisa que `DIRECT_URL` sea la conexión **directa** (no la pooled) — Migrate la necesita así.

## 6. Configuración inicial y primer SUPERADMIN

`npm run db:seed` siempre siembra la configuración del Módulo 02 (caja central, mesas, juegos de fichas, métodos de pago, folios, políticas y WhatsApp pendiente). Es idempotente y no pisa lo que edites después. Si además defines las variables de abajo, crea el primer SUPERADMIN:

```bash
SEED_SUPERADMIN_NAME="Tu Nombre" \
SEED_SUPERADMIN_EMAIL="tu@correo.com" \
SEED_SUPERADMIN_PASSWORD="una-contraseña-fuerte-de-al-menos-12-caracteres" \
npm run db:seed
```

Es seguro volver a correrlo: no duplica la configuración y, si ya existe un SUPERADMIN, no crea otro.

Para capturar datos bancarios (Configuración → Cuenta bancaria), define también `SETTINGS_ENCRYPTION_KEY` en `.env.local` (y en las variables de entorno del hosting):

```bash
openssl rand -base64 32
```

Las variables `WHATSAPP_*` se dejan vacías: el número exclusivo de WhatsApp aún no está disponible (Módulo 13).

## 7. Ejecutar en local

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) → redirige a `/login`. Entra con el correo/contraseña del paso 6.

Para crear las cuentas de socios y cajero: **Usuarios → Nuevo usuario**. El sistema genera una credencial temporal que verás una sola vez; entrégala en persona y el usuario deberá cambiarla en su primer acceso.

## 8. Pruebas

```bash
npm test                  # unitarias (Vitest) — no requieren base de datos
npm run test:integration  # integración contra Postgres real desechable (requiere TEST_DATABASE_URL)
npm run test:e2e          # E2E (Playwright) — primera vez: npx playwright install
```

### Base de pruebas desechable (integración y E2E con sesión real)

Las pruebas de integración y los E2E de login/usuarios **vacían tablas**, así que nunca usan tu Neon. Usan una base local que levanta el propio CLI de Prisma (sin Docker):

```bash
npx prisma dev -n poker-test -d     # levanta Postgres local en segundo plano
npx prisma dev ls                   # copia la URL "TCP" (postgres://postgres:postgres@localhost:<puerto>/template1?sslmode=disable)
export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:<puerto>/template1?sslmode=disable"

npm run test:integration
npm run test:e2e
npx prisma dev stop poker-test      # al terminar
```

- Las migraciones se aplican solas antes de cada corrida.
- Por seguridad, `TEST_DATABASE_URL` debe ser `localhost` (salvo `ALLOW_REMOTE_TEST_DATABASE=1`, p. ej. para una rama desechable de Neon en CI).
- Los E2E crean usuarios por rol con contraseñas **aleatorias** en cada corrida (`tests/e2e/.auth/users.json`, ignorado por git).
- `prisma dev` (PGlite) atiende una sola sesión a la vez: con esa base Playwright corre en un solo worker.
- Sin `TEST_DATABASE_URL`, `npm run test:e2e` corre solo los smoke tests que no necesitan base (los demás aparecen como _skipped_).

## Errores frecuentes

| Síntoma                                                                             | Causa probable                                                                                        | Solución                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Variables de entorno inválidas o faltantes` al hacer login/consultar algo          | Falta `.env.local` o le falta una variable                                                            | Revisa el paso 4                                                                                                       |
| `prisma migrate dev` falla con error de conexión                                    | Usaste la URL pooled en `DIRECT_URL`, o la base de Neon está "suspendida" por inactividad (plan free) | Usa la conexión directa; abre el dashboard de Neon para "despertar" la base                                            |
| `/api/health/ready` responde 503                                                    | No hay conexión a la DB (credenciales mal puestas, o la base de Neon está dormida)                    | Es el comportamiento esperado — no debe dar 200 si la DB no responde. Revisa `.env.local`                              |
| `next build` falla por Edge Runtime / `node:path`                                   | Se importó Prisma o bcryptjs desde `src/proxy.ts`                                                     | No importes `@/lib/auth` (el completo) desde el proxy — usa `@/lib/auth.config.ts`                                     |
| ESLint/Prettier marcan diferencias                                                  | No corriste `npm run format` después de editar                                                        | `npm run format` antes de commitear                                                                                    |
| `npm run typecheck` falla con `Cannot find name 'LayoutProps'` en un checkout nuevo | Next.js genera ese tipo en `.next/types/` y aún no existe (nunca corriste `dev`/`build`/`typecheck`)  | Ya resuelto: `npm run typecheck` corre `next typegen` primero. Si llamas `tsc` directo, corre `npx next typegen` antes |
