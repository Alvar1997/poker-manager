# CLAUDE.md — Poker Manager

Reglas permanentes para trabajar en este repositorio. Léelas antes de modificar cualquier módulo.

## Arquitectura

- Full Stack con Next.js 16 (App Router, TypeScript estricto).
- Prisma ORM 7 (driver adapter `@prisma/adapter-pg`) como capa de datos.
- PostgreSQL alojado en Neon.
- Arquitectura modular por dominio bajo `src/modules/*` (auth, users, sessions, tables, players, chips, cash, purchases, debts, settlements, notifications, reports, audit — ver `docs/MODULES.md`).
- Mobile First: todo se diseña primero para pantalla de celular.
- Patrón de capas en el backend: **Route Handler → Validación (Zod) → Autorización (`src/config/permissions.ts`) → Servicio (`src/modules/*`) → Prisma**. Los componentes React nunca contienen lógica financiera ni hacen queries directas a la base de datos.

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
- Las entregas de fichas requieren firma del jugador en el celular del cajero.
- Las deudas se compensan por antigüedad (FIFO) al liquidar.
- Los mensajes de WhatsApp de compras/recompras a crédito se envían **después** de confirmar la compra, no antes.
- Una sesión cerrada no admite edición directa (correcciones van por un mecanismo de auditoría explícito, no por mutar el histórico).

Detalle completo: `docs/BUSINESS_RULES.md`.

## Reglas técnicas

- Migraciones de Prisma siempre versionadas y commiteadas (`prisma/migrations/`).
- Toda entrada externa se valida con Zod (`src/lib/validation.ts`) antes de tocar la base de datos.
- Los permisos se verifican **en el servidor** (`src/config/permissions.ts`), nunca solo ocultando botones en el cliente. Un usuario nunca puede autoasignarse un rol vía parámetro de cliente.
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
5. Corre `npm run lint && npm run typecheck && npm test` (y `npm run test:e2e` si el cambio toca navegación/auth).
6. Documenta el cambio (README/docs/comentarios) si alteró una decisión arquitectónica.

No modifiques un módulo ya cerrado/entregado sin una razón técnica explícita y documentada en el commit.

## Estado actual

Módulo 00 (infraestructura) completado — ver el reporte de entrega. El siguiente trabajo es el **Módulo 01: Usuarios, roles y seguridad** (`docs/MODULES.md`).
