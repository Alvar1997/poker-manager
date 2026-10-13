# Checklist de módulos — Poker Manager

Roadmap propuesto de 16 módulos (00–15). Cada módulo crea su propio directorio bajo `src/modules/<dominio>/` cuando se implementa (no se crean vacíos de antemano). El orden respeta las dependencias de negocio descritas en `docs/BUSINESS_RULES.md`.

| #             | Módulo                      | Responsabilidad                                                                                                           | Estado                     |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 00            | Infraestructura             | Next.js, TS estricto, Tailwind, shadcn, Prisma+Neon, auth básica, errores, logging, health checks, PWA base               | ✅ Completado              |
| 01            | Usuarios, roles y seguridad | Usuarios (SUPERADMIN), roles, permisos por capacidad, sesiones seguras, auditoría de seguridad                            | ✅ Completado (2026-10-13) |
| 02            | Configuración general       | Negocio, caja central única, mesas, juegos de fichas, denominaciones, pagos, banco, folios, políticas, WhatsApp pendiente | ✅ Completado (2026-10-14) |
| 03            | Jugadores                   | Alta/edición de jugadores, historial por jugador                                                                          | **Siguiente**              |
| por confirmar | Mesas y sesiones            | Apertura (fondo nuevo + arqueo inicial), mesas simultáneas, snapshot de ciegas/juego, `businessDate`                      | Pendiente                  |
| por confirmar | Inventario de fichas        | Existencias por (juego, denominación), movimientos, conversiones entre juegos, conciliación                               | Pendiente                  |
| por confirmar | Caja central (movimientos)  | Libro de movimientos de efectivo/banco, saldo derivado, vínculo sesión/mesa                                               | Pendiente                  |
| por confirmar | Compras y recompras         | Pagada/parcial/crédito, pagos con componentes (efectivo + transferencia + crédito)                                        | Pendiente                  |
| por confirmar | Entregas y firma            | Entrega de fichas con firma del jugador                                                                                   | Pendiente                  |
| por confirmar | Deudas y abonos             | Deuda por jugador, abonos, saldo pendiente                                                                                | Pendiente                  |
| por confirmar | Liquidaciones               | Compensación FIFO, devolución de fichas, pago neto                                                                        | Pendiente                  |
| por confirmar | Cierre de sesión            | Arqueo final, retiro total, diferencias, bloqueo post-cierre, correcciones auditadas                                      | Pendiente                  |
| 13            | Notificaciones automáticas  | WhatsApp Cloud API real (número exclusivo pendiente de recepción)                                                         | Pendiente                  |
| por confirmar | Reportes y auditoría        | Reportes operativos/financieros, consulta de `AuditLog`                                                                   | Pendiente                  |
| por confirmar | PWA, hardening, despliegue  | UX móvil avanzada, revisión de seguridad, operación                                                                       | Pendiente                  |

> La numeración confirmada por el encargo es: 02 Configuración general, 03 Jugadores y 13 Notificaciones automáticas. El orden del resto se confirmará al planear cada módulo.

## Módulo 01 — entregado

- Matriz central de permisos por capacidad (`src/config/permission-matrix.ts`) — ver `docs/ROLES_AND_PERMISSIONS.md`.
- Administración de usuarios (solo SUPERADMIN): listar, buscar, filtrar, crear, editar, activar/desactivar, restablecer contraseña (credencial temporal), sin borrado físico.
- Login/logout con Auth.js, limitador de intentos, revocación inmediata por `sessionVersion`, credencial temporal obligatoria de cambiar, CSRF, auditoría de seguridad inmutable — ver `docs/AUTHENTICATION.md`.
- Pantallas Mobile First: login, perfil, usuarios (lista/alta/edición), acceso denegado, navegación por capacidades.
- Pruebas: unitarias (Vitest), integración contra Postgres real (`npm run test:integration`) y E2E con sesión real (Playwright, Chrome + iPhone).

Pendientes conocidos (fuera de alcance de 01):

- Recuperación de contraseña por correo con token de un solo uso (hoy solo restablece un SUPERADMIN, en persona).
- Pantalla de consulta de la auditoría (`AUDIT_READ`/`AUDIT_SECURITY_READ` ya existen; la vista es del Módulo 12).
- 2FA para SUPERADMIN.

## Módulo 02 — entregado

Detalle: [`docs/MODULE_02_CONFIGURATION.md`](MODULE_02_CONFIGURATION.md).

- Configuración del negocio, Caja Central `MAIN` única, mesas 25/25 y 10/10 con juegos físicos independientes, denominaciones por juego (sin inventar), métodos de pago `CASH`/`BANK_TRANSFER`, cuenta bancaria única cifrada (pendiente de captura), folios con emisión atómica, políticas `NEW_FUND_PER_SESSION`/`FULL_WITHDRAWAL` y reglas fijas, WhatsApp `PENDING_CONFIGURATION`.
- Ninguna operación financiera, existencia ni folio emitido.

Pendientes conocidos (fuera de alcance de 02):

- Capturar las denominaciones reales de cada juego y los datos bancarios (tarea del SUPERADMIN, no de código).
- Aplicar `dateFormat`/`timeFormat` a las pantallas (hoy se usa es-MX).
- Bloquear el cambio de valor de denominaciones con movimientos (DEN-11), en el módulo de inventario.
- Integración WhatsApp real: Módulo 13, cuando llegue el número.

## Notas

- `src/modules/*` del árbol de referencia (`auth`, `users`, `sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) se reparten entre estos módulos numerados — `sessions`+`tables` corresponden al Módulo 02, `reports`+`audit` al Módulo 12, etc.
- Ningún módulo de negocio (02 en adelante) debe implementarse antes que el Módulo 01 (seguridad/roles) esté terminado — todos dependen de autorización por rol correcta.
- Este archivo se actualiza al cerrar cada módulo (mover su fila a "✅ Completado" y anotar la fecha).
