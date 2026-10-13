# Reglas de negocio — Poker Manager

Reglas confirmadas al momento de construir el Módulo 00. Son la fuente de verdad para los módulos de negocio que se construirán después — ningún módulo debe contradecirlas sin que el cambio se discuta y documente explícitamente aquí.

## Caja y mesas

- Existe **una única caja central**. Todo el dinero se administra desde ahí — no hay cajas por mesa.
- Hay **dos mesas** configuradas inicialmente: 25/25 y 10/10.
- Ambas mesas pueden operar **simultáneamente**.
- Inventario físico de fichas **compartido** entre mesas (no hay un inventario independiente por mesa).
- Los movimientos pertenecen a una sesión y, cuando corresponde, a una mesa — nunca se duplican entre mesas.

## Apertura y cierre de sesión

- Toda apertura de sesión requiere **conteo obligatorio** de fichas y efectivo.
- El cajero realiza y confirma los arqueos **sin** necesitar autorización de un supervisor.
- El cierre de sesión requiere un arqueo final.
- Una sesión cerrada **no admite edición directa** — cualquier corrección pasa por un mecanismo de auditoría explícito (a definir en el módulo de sesiones), nunca mutando el histórico ya cerrado.

## Compras y crédito

- Hay compras iniciales y recompras de fichas.
- Una compra puede estar **pagada, parcialmente pagada o a crédito**.
- El cajero puede otorgar crédito **sin autorización externa**.
- El crédito **no representa dinero recibido** — es una deuda del jugador contra la caja.
- Cada compra pertenece a una sesión, una mesa y un jugador.

## Entregas y deudas

- Las entregas de fichas requieren **firma del jugador** en el celular del cajero.
- Se mantiene control de deudas y abonos por jugador.
- Las liquidaciones compensan deudas automáticamente, empezando por las **más antiguas (FIFO)**.
- Al liquidar: devolución de fichas + pago del importe neto (después de compensar deuda).

## Notificaciones

- Las compras y recompras **a crédito** generan una notificación automática por WhatsApp Business Cloud API.
- El mensaje se envía **después** de confirmar la compra (no antes, no en paralelo sin confirmación).
- El mensaje debe informar: hora, importe de la operación actual, acumulado comprado (en la sesión) y deuda pendiente del jugador.

## Usuarios y roles

| Rol          | Alcance                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `SUPERADMIN` | Control total del sistema.                                             |
| `PARTNER`    | Dos cuentas de socios — principalmente consulta.                       |
| `CASHIER`    | Operador de caja: compras, entregas, créditos, arqueos, liquidaciones. |

- Inicialmente 4 cuentas: 1 `SUPERADMIN`, 2 `PARTNER`, 1 `CASHIER`.
- No hay registro público — los usuarios se crean vía bootstrap (`npm run db:seed`, solo el primer SUPERADMIN) o por un `SUPERADMIN` autenticado (Módulo 01).
- Un usuario desactivado (`isActive = false`) no puede operar.

## Dinero y fichas

- Montos monetarios: siempre `Decimal` de Prisma — nunca `Float`/`number` de JS en cálculos financieros.
- Cantidades de fichas: siempre enteros no negativos.
- Toda operación que mueve dinero o fichas corre dentro de una transacción de base de datos.
- Moneda: MXN. Formato: `es-MX` (ver `src/lib/format.ts#formatCurrencyMXN`).

## Fechas y zona horaria

- Zona horaria del negocio: `America/Monterrey`.
- Los timestamps se **almacenan** siempre como instantes UTC (comportamiento por defecto de `DateTime` en Prisma/PostgreSQL).
- Se **muestran** al usuario siempre convertidos a `America/Monterrey` (`src/lib/format.ts`) — nunca formatear una fecha "a mano" en otro lugar del código.
- Una sesión no necesariamente termina el mismo día calendario en que empezó (p. ej. empieza 23:30, termina 01:00). El concepto de **fecha operativa** (`businessDate`, `src/lib/format.ts#businessDateOf`) resuelve a qué día calendario de Monterrey pertenece un instante — el módulo de sesiones decidirá, con ese dato, a qué sesión/día de negocio pertenece cada movimiento. Los cierres financieros nunca deben basarse únicamente en la fecha calendario del servidor.

## Explícitamente fuera de alcance del Módulo 00

No implementado todavía (se construye en módulos posteriores — ver `docs/MODULES.md`): compras, créditos, inventario operativo de fichas, liquidaciones, cierre de sesiones, envío real de WhatsApp.
