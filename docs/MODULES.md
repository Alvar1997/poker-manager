# Checklist de módulos — Poker Manager

Roadmap propuesto de 16 módulos (00–15). Cada módulo crea su propio directorio bajo `src/modules/<dominio>/` cuando se implementa (no se crean vacíos de antemano). El orden respeta las dependencias de negocio descritas en `docs/BUSINESS_RULES.md`.

| #   | Módulo                      | Responsabilidad                                                                                                                       | Depende de     | Estado        |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------- |
| 00  | Infraestructura             | Next.js, TS estricto, Tailwind, shadcn, Prisma+Neon, auth básica, errores, logging, health checks, PWA base, lint/test/CI local, docs | —              | ✅ Completado |
| 01  | Usuarios, roles y seguridad | CRUD de usuarios (`SUPERADMIN`), gestión de roles/activación, matriz de permisos detallada por acción                                 | 00             | Pendiente     |
| 02  | Mesas y sesiones            | Apertura de sesión (conteo obligatorio), mesas simultáneas (25/25, 10/10), arqueo inicial, `businessDate` aplicado                    | 00, 01         | Pendiente     |
| 03  | Jugadores                   | Alta/edición de jugadores, historial por jugador                                                                                      | 00, 01         | Pendiente     |
| 04  | Inventario de fichas        | Stock físico compartido de fichas, movimientos de inventario, conciliación contra arqueos                                             | 02             | Pendiente     |
| 05  | Caja central                | Movimientos de dinero de la caja única, saldo en tiempo real, vínculo con sesión/mesa                                                 | 02             | Pendiente     |
| 06  | Compras y recompras         | Compra inicial/recompra, pago total/parcial/crédito, otorgar crédito sin autorización externa                                         | 02, 03, 04, 05 | Pendiente     |
| 07  | Entregas y firma            | Entrega de fichas al jugador con firma en el celular del cajero                                                                       | 04, 06         | Pendiente     |
| 08  | Deudas y abonos             | Registro de deuda por jugador, abonos parciales, saldo pendiente                                                                      | 06             | Pendiente     |
| 09  | Liquidaciones               | Compensación de deuda FIFO (más antigua primero), devolución de fichas, pago del importe neto                                         | 04, 08         | Pendiente     |
| 10  | Cierre de sesión            | Arqueo final, bloqueo de edición directa post-cierre, mecanismo de corrección auditado                                                | 02, 04, 05, 09 | Pendiente     |
| 11  | Notificaciones WhatsApp     | Integración real con WhatsApp Business Cloud API, mensajes de compra/recompra a crédito (hora, importe, acumulado, deuda)             | 06             | Pendiente     |
| 12  | Reportes y auditoría        | Historial de movimientos, reportes operativos/financieros, explotación de `AuditLog`                                                  | 02–10          | Pendiente     |
| 13  | PWA y UX móvil avanzada     | Instalación pulida, offline-first donde aplique (sin datos financieros sensibles en caché pública), accesibilidad                     | 00–12          | Pendiente     |
| 14  | Hardening                   | Rate limiting, revisión de seguridad end-to-end, revocación de sesión inmediata, rendimiento                                          | 00–13          | Pendiente     |
| 15  | Despliegue y operación      | Pipeline de deploy, monitoreo, backups, runbook de incidentes                                                                         | 00–14          | Pendiente     |

## Notas

- `src/modules/*` del árbol de referencia (`auth`, `users`, `sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) se reparten entre estos módulos numerados — `sessions`+`tables` corresponden al Módulo 02, `reports`+`audit` al Módulo 12, etc.
- Ningún módulo de negocio (02 en adelante) debe implementarse antes que el Módulo 01 (seguridad/roles) esté terminado — todos dependen de autorización por rol correcta.
- Este archivo se actualiza al cerrar cada módulo (mover su fila a "✅ Completado" y anotar la fecha).
