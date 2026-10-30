# Asistente de apertura en 4 pasos (Session Opening Wizard)

Código: `src/modules/sessions/opening-wizard.math.ts` (puro), `opening-wizard.service.ts`, `components/opening-wizard.tsx`; piezas visuales comunes con el cierre en `src/components/wizard/wizard-ui.tsx`. Página `/dashboard/sesiones/:id/apertura` (`/preparacion` redirige aquí). Migración `20261106120000_opening_wizard` (solo agrega).

## 1. Qué cambió

Antes la apertura eran tres pantallas: preparación con un checklist de 10 controles, arqueo de fichas y apertura. Ahora es un **asistente guiado** con la misma apariencia que el cierre. **No es una apertura paralela**: traduce el checklist real (`computeOpeningChecklist`) a tareas con su ruta para RESOLVER, y la apertura sigue siendo `openSession`, que vuelve a validar todo en una transacción. La pantalla del arqueo de fichas (`/arqueo-fichas`, motor del Módulo 04) se conserva y se abre desde RESOLVER.

## 2. Pasos

| #   | Paso                      | Completo cuando (datos reales)                                                                 | Tareas típicas                                                                                                                                                                   |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Crear jornada             | Sesión en preparación (folio, responsable y fechas los fija el servidor; observación opcional) | `PREPARATION_NOT_STARTED` (botón GUARDAR Y CONTINUAR), `SESSION_CANCELLED`                                                                                                       |
| 2   | Contar fichas             | Arqueo OPENING del inventario compartido capturado, confirmado, conciliado y vigente           | `CHIP_COUNT_MISSING` (CONTAR FICHAS), `CHIP_COUNT_INCOMPLETE`, `CHIP_COUNT_UNCONFIRMED` (CONFIRMAR CONTEO), `CHIP_DIFFERENCE_PENDING`, `CHIP_COUNT_STALE`, `INVENTORY_NOT_READY` |
| 3   | Preparar mesas (opcional) | Al menos una mesa preparada o «Continuar sin mesas»                                            | `TABLE_CONFIG_INCOMPLETE` (CONFIGURAR MESA o quitarla), `NO_TABLES` (informativo)                                                                                                |
| 4   | Confirmar apertura        | Solo cuando la sesión queda ABIERTA                                                            | `CASH_ZERO_MISSING` / `CASH_NOT_ZERO` / `CASH_ZERO_STALE` (caja física en $0.00), `OPENING_NOT_AUTHORIZED`                                                                       |

Estados: `COMPLETED`, `WARNING` (completo con advertencias), `BLOCKED` (requisito obligatorio sin cumplir: impide abrir) y `PENDING` (falta una operación que no bloquea). El progreso cuenta `COMPLETED` y `WARNING`; como el paso 4 solo se completa al abrir, **nunca llega a 100% antes de abrir**.

**Cero mesas es válido**: «No has agregado mesas. Puedes abrir la jornada y agregarlas después.» es información, no un bloqueo.

## 3. Reglas

- **Conteo obligatorio**: lo hace y confirma el creador de la sesión (también un CASHIER), sin autorización de un socio. Si el conteo difiere del inventario esperado, se concilia con el ajuste auditable del Módulo 04 (motivo obligatorio); nunca se inventan movimientos para igualar.
- **Caja $0.00**: no hay fondo inicial ni arrastre. El paso 4 pide confirmar que la caja física está vacía (arqueo de efectivo OPENING, sin movimientos de dinero). Si se cuenta efectivo, bloquea hasta retirarlo y volver a contar. El valor nominal de las fichas no es dinero.
- **Mesas preparadas** (`session_opening_tables`): son un PLAN, no mesas abiertas (sin ciclo, inventario, caja, jugadores ni rake). Al ABRIR JORNADA se abren en la misma transacción con el servicio del Módulo 07 (`openSessionTableInTx`). Quitar una mesa la marca con quién y cuándo (nunca se borra). Una mesa desactivada en el catálogo o sin ciegas válidas impide abrir (control `TABLES_READY` del checklist) hasta corregirla o quitarla. Con la sesión abierta, las mesas se agregan desde Mesas, como siempre.
- **Regla del creador**: solo quien creó la sesión, o SUPERADMIN (intervención auditada), modifica la preparación; los demás la consultan en modo lectura (403 por la API).
- **ABRIR JORNADA**: `POST /api/sessions/:id/open` con `idempotencyKey` y la huella del resumen revisado (`previewHash`). Bloquea la sesión, el inventario compartido y la caja; recalcula el checklist y el plan de mesas; responde 409 si algo cambió después de revisar (conteo, caja o mesas); registra la hora del servidor, la evidencia `SessionOpening` (conteo y caja usados) y la auditoría. Doble clic o solicitudes simultáneas → una sola apertura.

## 4. Persistencia

`session_opening_progress` (una fila por sesión) guarda solo lo que el creador declara: paso actual y «continuar sin mesas». La observación se guarda en la sesión (`notes`). El conteo en borrador y el plan de mesas viven en sus propias tablas. Nada de esto marca pasos como completos: al volver, todo se recalcula. Una sesión que ya no está en preparación no admite cambios (triggers).

## 5. RESOLVER y volver

Cada tarea accionable trae su ruta REAL (arqueo de fichas, inventario, catálogo de mesas). Al pulsar RESOLVER aparece el botón fijo «Volver a la apertura» (el mismo aviso del cierre) y al volver se recalcula todo.

## 6. Endpoints

| Método | Ruta                                                        | Permiso                                |
| ------ | ----------------------------------------------------------- | -------------------------------------- |
| GET    | `/api/sessions/:id/opening/wizard`                          | `sessions:read`                        |
| PATCH  | `/api/sessions/:id/opening/wizard`                          | `sessions:manage` + creador/SUPERADMIN |
| POST   | `/api/sessions/:id/opening/tables` (`tableId`)              | `sessions:manage` + creador/SUPERADMIN |
| POST   | `/api/sessions/:id/opening/tables/:tableId/remove`          | `sessions:manage` + creador/SUPERADMIN |
| POST   | `/api/sessions/:id/open` (`idempotencyKey`, `previewHash?`) | `sessions:manage` + creador/SUPERADMIN |

Auditoría: `SESSION_OPENING_PROGRESS_SAVED` (observación o «sin mesas»), `SESSION_OPENING_TABLE_PLANNED`, `SESSION_OPENING_TABLE_UNPLANNED`, más los eventos existentes `SESSION_PREPARATION_STARTED`, `SESSION_OPENING_COUNT_STARTED`, `CHIP_COUNT_*`, `SESSION_OPENING_CASH_CONFIRMED` y `SESSION_OPENED` (con las mesas abiertas).

## 7. Integración con el cierre

Ambos asistentes usan las mismas piezas visuales (`wizard-ui.tsx`), el mismo formato de tareas (`src/lib/wizard.ts`) y el mismo aviso para volver. Las mesas abiertas al iniciar se cierran en el paso 2 del cierre como cualquier otra.

## 8. Pruebas

- Unitarias: `src/modules/sessions/opening-wizard.test.ts` (estados, progreso, paso sugerido).
- Integración: `tests/integration/opening-wizard.int.test.ts` — casos A (normal con 10/10 y 25/25), B (sin mesas), C (sin conteo, RESOLVER), D (guardar y regresar sin duplicar), E (PARTNER ajeno rechazado; SUPERADMIN retoma), F (caja $0 sin arrastre), G (confirmaciones simultáneas), estado obsoleto y mesa incompleta, H (mesa agregada después) e I (sin movimientos de fichas ni caja).
- E2E: `tests/e2e/sessions.spec.ts` (Chrome + iPhone): crear, modo lectura, paso 1, RESOLVER → arqueo → «Volver a la apertura», mesas y persistencia al recargar, caja $0 y ABRIR JORNADA.
