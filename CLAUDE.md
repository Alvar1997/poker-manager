# CLAUDE.md — Poker Manager

Reglas permanentes para trabajar en este repositorio. Léelas antes de modificar cualquier módulo.

## Arquitectura

- Full Stack con Next.js 16 (App Router, TypeScript estricto).
- Prisma ORM 7 (driver adapter `@prisma/adapter-pg`) como capa de datos.
- PostgreSQL alojado en Neon.
- Arquitectura modular por dominio bajo `src/modules/*` (auth, users, sessions, tables, players, chips, cash, purchases, debts, settlements, notifications, reports, audit — ver `docs/MODULES.md`).
- Mobile First: todo se diseña primero para pantalla de celular.
- Patrón de capas en el backend: **Route Handler → Autorización (`src/config/permissions.ts`) → Validación (Zod) → Servicio (`src/modules/*`) → Prisma** (desde el Módulo 01 la autorización va primero: sin sesión siempre 401, sin permiso siempre 403). Los componentes React nunca contienen lógica financiera ni hacen queries directas a la base de datos.

Detalle completo de decisiones técnicas: `docs/ARCHITECTURE.md`.

## Reglas de negocio globales

- Una única caja central. El dinero se administra exclusivamente desde ahí.
- Dos mesas (25/25 y 10/10) pueden operar simultáneamente desde el inicio.
- Cada movimiento pertenece a una sesión y, cuando corresponde, a una mesa — nunca se duplica entre mesas.
- Cada compra pertenece a una sesión, una mesa y un jugador.
- El crédito **no** representa dinero recibido — es una deuda del jugador.
- El inventario de fichas es independiente del saldo de dinero.
- El cajero confirma apertura y cierre de sesión (arqueo) sin necesitar autorización de un supervisor.
- Las compras a crédito no requieren aprobación externa — el cajero puede otorgarlo.
- SUPERADMIN y PARTNER tienen prácticamente las mismas capacidades de operación y visibilidad financiera. Administración de usuarios, roles, seguridad y configuración crítica son exclusivas de SUPERADMIN. CASHIER opera la caja sin aprobación de socios.
- Usuarios: nunca borrado físico (solo desactivar); siempre al menos un SUPERADMIN activo; nadie cambia su propio rol.
- Caja central única (`CashBox` `MAIN`), sin campo de saldo: los saldos se derivan de movimientos. Cada mesa usa un juego FÍSICO de fichas propio (`ChipSet`); el inventario se identifica por (juego, denominación), nunca por mesa. Las sesiones deben guardar una fotografía de ciegas y juego.
- Fondo de efectivo nuevo en cada sesión y retiro total al cierre. El crédito no es un método de pago; el pago mixto es una operación con componentes.
- WhatsApp: el número exclusivo está pendiente; la integración real corresponde al Módulo 13 y su ausencia no bloquea nada. Nunca guardes tokens en la base de datos.
- Jugadores (`Player`) separados de los usuarios administrativos: sin correo, contraseña ni rol.
- Teléfono del jugador obligatorio, normalizado a E.164 con `src/lib/phone.ts` (México por defecto) y único en la base. Nunca concatenar +52 a mano.
- Crédito ilimitado: sin límite por jugador ni global (`src/config/credit-policy.ts`); nunca agregar campos o controles de límite sin una decisión de negocio documentada.
- Deudas y saldos SIEMPRE derivados de movimientos reales confirmados; nunca campos editables del jugador.
- Consentimiento de WhatsApp independiente del teléfono: explícito, versionado, revocable, ligado al número; los envíos deben consultar `getConsentStatus(playerId).granted`.
- Sin borrado físico de jugadores (desactivar); un inactivo no se selecciona para operaciones nuevas (`assertPlayerSelectable`), pero sus deudas siguen vigentes.
- Las entregas de fichas requieren firma del jugador en el celular del cajero.
- Las deudas se compensan por antigüedad (FIFO) al liquidar.
- Los mensajes de WhatsApp de compras/recompras a crédito se envían **después** de confirmar la compra, no antes.
- Una sesión cerrada no admite edición directa (correcciones van por un mecanismo de auditoría explícito, no por mutar el histórico).

Detalle completo: `docs/BUSINESS_RULES.md`.

## Reglas técnicas

- Migraciones de Prisma siempre versionadas y commiteadas (`prisma/migrations/`).
- Toda entrada externa se valida con Zod (`src/lib/validation.ts`) antes de tocar la base de datos.
- Los permisos se verifican **en el servidor** (`src/config/permissions.ts`), nunca solo ocultando botones en el cliente. Un usuario nunca puede autoasignarse un rol vía parámetro de cliente.
- Autoriza por **capacidad**: `requirePermission(PERMISSIONS.X)` en endpoints y `requirePagePermission(PERMISSIONS.X)` en páginas. Nunca `role === "..."` disperso. La matriz rol → permisos vive solo en `src/config/permission-matrix.ts` (denegado por defecto). Ver `docs/ROLES_AND_PERMISSIONS.md`.
- El rol y estado vigentes se leen de la base en cada request (`getCurrentUser` → `loadSessionUser`); el JWT solo identifica. Cambios de rol, desactivación o de contraseña incrementan `User.sessionVersion` (revoca sesiones). Ver `docs/AUTHENTICATION.md`.
- Schemas Zod de entrada como `z.strictObject`: un campo no previsto (p. ej. `role`) es 400, no se ignora.
- Nunca devolver `passwordHash`/`sessionVersion`: lecturas de usuario siempre con `publicUserSelect` (`src/modules/users/user.dto.ts`).
- `audit_logs` es de solo inserción (trigger en BD). Las mutaciones administrativas auditan dentro de su misma transacción.
- Catálogos de configuración: sin `DELETE` (activar/desactivar), códigos internos inmutables, montos como string en la API y `Decimal` en la base (`src/lib/money.ts`). Reglas fijas en `src/config/operational-rules.ts`. Folios solo con `issueFolio(tx, tipo)` dentro de la transacción del documento.
- Datos bancarios cifrados (`src/lib/crypto.ts`, `SETTINGS_ENCRYPTION_KEY`); nunca devolver números completos.
- Enlaces con estilo de botón: `<Link className={buttonVariants()}>`, nunca `<Button render={<Link/>}>`.
- Pruebas de integración (`npm run test:integration`) y E2E con sesión real requieren `TEST_DATABASE_URL` local desechable (`npx prisma dev`), nunca Neon — ver `docs/SETUP.md`.
- Dinero: siempre `Decimal` de Prisma — **nunca** `Float`/`number` de JS para cálculos financieros.
- Fichas: siempre enteros no negativos (`src/lib/validation.ts#nonNegativeInt`).
- Operaciones que mueven dinero o fichas van en una transacción de Prisma (`$transaction`).
- Las operaciones deben ser idempotentes cuando el negocio lo requiera (p. ej. bootstrap de SUPERADMIN).
- Toda acción relevante del negocio se audita en el modelo `AuditLog` — nunca loguear contraseñas, tokens ni secretos ahí ni en `src/lib/logger.ts`.
- Cobertura de pruebas: unitarias (Vitest) para lógica de validación/errores/permisos/utilidades, E2E (Playwright) para flujos de navegación críticos.
- Nunca exponer secretos con el prefijo `NEXT_PUBLIC_`.
- Mantener compatibilidad Mobile First en cualquier pantalla nueva.
- No introducir una dependencia nueva sin justificarla (ver sección "No utilizar" en `docs/ARCHITECTURE.md`).

## Flujo de trabajo

Antes de modificar código existente:

1. Revisa los archivos relacionados (el módulo de dominio, sus tipos, sus tests).
2. Identifica qué otros módulos dependen de lo que vas a cambiar.
3. Verifica qué reglas de negocio/técnicas de este documento aplican.
4. Implementa el cambio.
5. Corre `npm run lint && npm run typecheck && npm test` (y `npm run test:integration` + `npm run test:e2e` con `TEST_DATABASE_URL` si el cambio toca servicios, navegación o auth).
6. Documenta el cambio (README/docs/comentarios) si alteró una decisión arquitectónica.

No modifiques un módulo ya cerrado/entregado sin una razón técnica explícita y documentada en el commit.

## Estado actual

- Módulos 00 (infraestructura), 01 (usuarios, roles y seguridad), 02 (configuración general) y 03 (jugadores) completados — ver `docs/MODULES.md` y `docs/MODULE_0X_*.md`.
- WhatsApp en `PENDING_CONFIGURATION` por diseño (número exclusivo pendiente; integración en el Módulo 13).
- Siguiente: **Módulo 04 — Inventario central de fichas**, por (juego físico, denominación): los juegos de las mesas 25/25 y 10/10 son inventarios distintos.
