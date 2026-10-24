# Asistente de cierre en 6 pasos (Closure Wizard)

Código: `src/modules/closure/closure-wizard.math.ts` (puro), `closure-wizard.service.ts`, `components/closure-wizard.tsx`, `components/closure-return-banner.tsx`; página `/dashboard/sesiones/:id/cierre`. Migración `20261105120000_closure_wizard` (solo agrega).

## 1. Qué cambió

Antes, `/cierre` era un panel con toda la información financiera a la vez y ocho pantallas sin orden claro. Ahora es un **asistente guiado**. No es un cierre paralelo: lee los mismos datos y reglas del Módulo 12/18 (`buildClosurePreview`, rake, propinas) y traduce cada pendiente a una tarea con su ruta real. El cierre definitivo sigue siendo `confirmClosure`, que revalida todo en una transacción. Las pantallas detalladas (inventario, caja, retiro, diferencias, prevalidación…) siguen existiendo y se abren desde los botones RESOLVER.

## 2. Pasos

| #   | Paso                       | Completo cuando (datos reales)                                                                                          | Tareas típicas                                                                                                                                           |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Finalizar jugadores        | Sin participaciones ACTIVE, liquidaciones sin firma/recepción ni compras sin entregar                                   | `PLAYER_SETTLEMENT_MISSING` → mesa; `PLAYER_SIGNATURE_MISSING` / `PLAYER_RECEPTION_MISSING` → firma de la liquidación; `PURCHASE_NOT_DELIVERED` → compra |
| 2   | Cerrar mesas y rake        | Mesas cerradas; ciclos en conteo final contados (también $0)                                                            | `TABLE_OPEN` → mesa; `RAKE_COUNT_MISSING` → rake de la mesa; `RAKE_DIFFERENCE` (advertencia)                                                             |
| 3   | Contar propinas            | Todos los empleados con conteo confirmado + confirmación explícita «el conteo del staff está completo» (también con $0) | `STAFF_TIP_UNCONFIRMED`, `STAFF_TIPS_REVIEW_MISSING` (dentro del paso)                                                                                   |
| 4   | Arqueo de fichas           | Sesión en cierre y arqueo global confirmado y vigente                                                                   | `CLOSING_NOT_STARTED` (botón Iniciar cierre), `CHIP_COUNT_MISSING` / `CHIP_COUNT_STALE` → arqueo; `CHIP_PHYSICAL_DIFFERENCE` (advertencia)               |
| 5   | Conciliación y diferencias | Diferencia nominal y física en $0, o con motivo guardado                                                                | `NOMINAL_REASON_MISSING`, `PHYSICAL_REASON_MISSING` (dentro del paso)                                                                                    |
| 6   | Confirmar cierre           | Arqueo de efectivo vigente, diferencia de efectivo resuelta, retiro final y ningún otro bloqueo                         | `CASH_COUNT_MISSING` / `CASH_COUNT_STALE` → caja; `CASH_DIFFERENCE_OPEN` → diferencias; `CASH_WITHDRAWAL_MISSING` → retiro                               |

Estados: `COMPLETED`, `WARNING` (completo con advertencias que permiten continuar), `ERROR` (tiene tareas obligatorias) y `PENDING` (aún no disponible; p. ej. el arqueo antes de iniciar el cierre). Un paso nunca se marca completo por visitarlo ni por casillas: el estado se deriva de sus tareas (`stepStatus`). El progreso cuenta los pasos `COMPLETED` y `WARNING`.

Las **diferencias de fichas** (nominal y física) son advertencias que NO bloquean: exigen motivo (paso 5) y se cierran sin ajustes. Las deudas de jugadores y los pagos pendientes se muestran como información y sobreviven al cierre.

## 3. RESOLVER y volver al cierre

Cada tarea accionable trae su ruta REAL (`href`). Al pulsar RESOLVER se guarda a dónde regresar y en cualquier pantalla del panel aparece el botón fijo «Volver al cierre» (`ClosureReturnBanner`; solo `sessionStorage` como comodidad). Al volver, y al enfocar de nuevo la pestaña, el asistente recalcula todo en el servidor.

## 4. Persistencia

`session_closure_progress` (una fila por sesión) guarda únicamente lo que el cajero declara: el paso actual, los borradores de los motivos y la revisión del conteo del staff con la **huella** del estado revisado (si cambian las propinas, la revisión deja de valer). El estado de los pasos nunca se guarda: siempre se recalcula. Una sesión cerrada no admite cambios (trigger).

## 5. Reglas en el servidor

- En CIERRE, la prevalidación BLOQUEA la confirmación si faltan conteos obligatorios: `RAKE_COUNT_PENDING`, `STAFF_TIPS_UNCONFIRMED` y `STAFF_TIPS_NOT_REVIEWED` (en sesiones con mesas o staff). Antes del cierre son advertencias.
- `confirmClosure` acepta `nominalReason` y `physicalReason` (o usa los borradores guardados) y exige el de cada diferencia ≠ 0; los guarda en `session_chip_differences` (`reason`, `physicalReason`) y en el comprobante.
- La confirmación exige la huella del resumen revisado (409 si hubo movimientos después) y es idempotente.
- Permisos: consultar `sessions:read`; preparar y guardar progreso `sessions:manage`; revisar propinas `tips:operate`; confirmar `sessions:close-confirm` (CASHIER, PARTNER, SUPERADMIN).

## 6. Casos especiales

- **Sin mesas**: los pasos 1–3 quedan completos sin tareas (salvo staff agregado), el arqueo usa el de apertura y el paso 6 pide el motivo del cierre sin actividad.
- **Mesa reabierta**: cada ciclo conserva su rake; el paso 2 pide contar solo los ciclos sin conteo.
- **Transferencias**: no generan movimientos ni tareas.
- **Bancaje**: el asistente no muestra ninguna señal de bancaje.
- **Regresar a Abierta**: queda como acción excepcional al pie del asistente; para recontar fichas basta el paso 4.

## 7. Pruebas

- Unitarias: `src/modules/staff-tips/module18.test.ts` (estados, progreso, paso sugerido y textos de diferencia).
- Integración: `tests/integration/rake-tips.int.test.ts` (dos jugadores pendientes con RESOLVER, rake pendiente y cierre perfecto con 6/6, revisión de propinas invalidada por cambios, persistencia y motivo por borrador, resumen obsoleto rechazado) y `closure.int.test.ts` (sin actividad).
- E2E: `tests/e2e/rake-tips.spec.ts` (RESOLVER → contar rake → «Volver al cierre», revisión del staff, motivo, persistencia al recargar y confirmación final; Chrome + iPhone) y `closure.spec.ts`.
