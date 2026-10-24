# Reglas de negocio — Poker Manager

Reglas confirmadas al momento de construir el Módulo 00. Son la fuente de verdad para los módulos de negocio que se construirán después — ningún módulo debe contradecirlas sin que el cambio se discuta y documente explícitamente aquí.

## Caja y mesas

- Existe **una única caja central**. Todo el dinero se administra desde ahí — no hay cajas por mesa.
- Hay **dos mesas** configuradas inicialmente: 25/25 y 10/10.
- Ambas mesas pueden operar **simultáneamente**.
- Inventario físico de fichas **compartido** entre mesas (no hay un inventario independiente por mesa).
- Los movimientos pertenecen a una sesión y, cuando corresponde, a una mesa — nunca se duplican entre mesas.

### Configuración (Módulo 02) — ver `docs/MODULE_02_CONFIGURATION.md`

- La caja central es **única** (`CashBox` código `MAIN`); la base impide una segunda. No tiene campo de saldo: el saldo se deriva de los movimientos.
- **Un inventario físico de fichas compartido** (`CHIPSET_MAIN`): las mesas 25/25 y 10/10 usan las mismas fichas, con denominaciones y existencias comunes. La decisión anterior (un juego físico por mesa: `CHIPSET_25_25`, `CHIPSET_10_10`) **quedó cancelada**; esos juegos se conservan inactivos solo como historial.
- Solo puede haber un inventario de fichas activo (la base lo impide). Todas las mesas activas apuntan a él; no existen inventarios ni contenedores por mesa.
- Las denominaciones pertenecen a un juego, son `Decimal` > 0 y no se repiten dentro del mismo juego. No se capturan cantidades en la configuración. No se inventan: se registran cuando se conocen las fichas reales.
- Las sesiones deberán guardar una fotografía de ciegas y juego usados: cambiar la configuración no altera el histórico.
- Métodos de pago: `CASH` y `BANK_TRANSFER`, contabilizados por separado. El pago mixto es una operación con componentes; el crédito no es un método de pago.
- Una sola cuenta bancaria receptora activa y principal para ambas mesas, con datos cifrados y mostrados enmascarados. Cambiarla conserva la anterior en el historial.
- Folios únicos por tipo, emitidos atómicamente, nunca reutilizados. Su formato solo se edita antes del primer folio.
- Catálogos sin borrado físico: se activan o desactivan.

## Apertura y cierre de sesión

- **Desde el Módulo 05** cada sesión inicia con **$0.00 de efectivo** (`ZERO_OPENING_BALANCE`): no existe fondo inicial, ni obligatorio ni automático, y no se arrastra efectivo de la sesión anterior. Esta regla **reemplaza** a la anterior `NEW_FUND_PER_SESSION` (fondo nuevo de importe variable), convertida por migración sin borrar históricos.
- Toda apertura de sesión requiere **conteo obligatorio** de fichas (un arqueo general vigente del inventario compartido, no uno por mesa) y de efectivo (debe ser $0.00). Si aparece dinero, se retira físicamente y se vuelve a contar: nunca se convierte en fondo.
- El cajero realiza y confirma los arqueos **sin** necesitar autorización de un supervisor.
- El cierre de sesión (Módulo 12) requiere el arqueo final ÚNICO y global de fichas, el arqueo de efectivo y el **retiro total** del efectivo (`FULL_WITHDRAWAL`): se registran el contado, el retirado, el operador y el receptor (que no firma ni inicia sesión), y la caja queda en $0.00. Las diferencias se registran con explicación y bloquean hasta resolverse. El retiro no es gasto ni utilidad. Banco y cuentas por cobrar continúan entre sesiones y las deudas no se borran.
- Una sesión cerrada **no admite edición directa** ni se reabre: antes de cerrar, el regreso auditado `CLOSING → OPEN` (con motivo) permite registrar operaciones reales olvidadas; después del cierre, los movimientos se registran fuera de la sesión (custodia, banco) ligados a sus obligaciones, y su caja no admite partidas (trigger).

## Caja central (Módulo 05) — ver `docs/MODULE_05_CASH_BOX.md`

- Una sola caja financiera para las dos mesas, con un libro de partida doble. El efectivo se lleva **por sesión** y el banco es **global** (conserva su historial entre sesiones).
- **Saldo de efectivo nunca negativo**: una salida mayor al disponible se rechaza indicando el faltante (p. ej. $1,000 disponibles y $1,500 solicitados → faltan $500).
- **Sin gastos operativos**: la caja no registra comida, bebidas, insumos, servicios, transporte ni ningún gasto, ni bajo una categoría genérica. Solo hay aportaciones, retiros con destino cerrado, traslados, cobros, pagos de liquidación, reversos y ajustes de arqueo.
- **Aportaciones**: dinero real entregado a la caja por una persona identificada; no es compra, ingreso, ganancia ni deuda. **Retiros**: nunca mayores al disponible; no son gasto ni ganancia.
- **Transferencias bancarias**: verificación **manual** por SUPERADMIN, PARTNER o CASHIER, sin aprobación adicional. Pendiente ≠ cobrada. Se registra quién confirmó y cuándo; confirmar dos veces no contabiliza dos veces; rechazar no genera entrada. Misma referencia + cuenta + importe que otra confirmada exige reconocer el posible duplicado (la referencia sola no se asume única).
- **Pagos mixtos**: efectivo (entra al momento) + transferencia (pendiente) + crédito (deuda, no dinero). Los componentes suman exactamente el importe.
- **Traslado efectivo → banco**: el efectivo sale a «en tránsito» y pasa al banco al verificarse; si se rechaza, regresa a la caja. Nunca se suma dos veces.
- **Movimientos inmutables**: se corrigen con un reverso con motivo (uno solo por movimiento) que conserva el original.
- **Arqueo de efectivo** (apertura, control, cierre): contar no cambia saldos; una diferencia exige explicación y, si procede, un ajuste explícito, único y auditado (no en la apertura).
- **Liquidaciones**: la compensación de deuda (opcional) no mueve efectivo; solo sale dinero realmente entregado al jugador (efectivo o transferencia ejecutada), nunca más del disponible.

## Sesiones (Módulo 06) — ver `docs/MODULE_06_SESSIONS.md`

- Una sesión es un periodo de operación que puede cruzar medianoche; el cambio de día no crea otra sesión. Folio, creador y fechas reales los asigna el servidor.
- **Una sola sesión vigente** (borrador, preparación, abierta o en cierre) a la vez.
- **Única forma de abrir:** crear → preparar → contar el inventario físico compartido (un solo arqueo general, no uno por mesa) → conciliar diferencias → confirmar efectivo físico en $0.00 → confirmar apertura. Nadie, ni SUPERADMIN, omite estos controles.
- **Regla del creador:** solo quien creó la sesión, o SUPERADMIN, prepara y confirma su apertura. Otro cajero o socio puede consultarla pero no modificarla.
- Se puede abrir **sin mesas**. Las mesas se abren después sin repetir el arqueo.
- No se abre con fichas en circulación ni reservas de sesiones anteriores sin resolver, ni con un arqueo obsoleto.
- Cancelar (borrador o preparación) exige motivo y conserva todo: folio, arqueos y ajustes reales. Una sesión abierta no se cancela: se cierra (Módulo 12).

## Mesas y participación (Módulo 07) — ver `docs/MODULE_07_TABLES.md`

- **UN INVENTARIO FÍSICO COMPARTIDO + DOS MESAS OPERATIVAS + UNA CAJA FINANCIERA CENTRAL.** Las mesas tienen estado, ciclos y participantes propios, pero nunca caja ni inventario propios.
- Una mesa solo se abre con la sesión abierta. Cerrarla no cierra la sesión y puede **reabrirse**, creando un ciclo nuevo; los ciclos anteriores se conservan.
- **Un jugador solo puede estar activo en una mesa a la vez** en la sesión.
- **Cambiar de mesa** no requiere liquidar ni contar fichas, no genera compra, cobro, pago ni movimiento de inventario, y el jugador conserva sus fichas. Las compras anteriores conservan su mesa; las nuevas se asocian a la nueva.
- **Salida definitiva solo con liquidación** (Módulo 11): SETTLING al recibir las fichas si falta pagar (sin silla), SETTLED al pagar por completo. No se cierra una mesa con jugadores ACTIVE (sí con participaciones SETTLING).
- Las deudas del jugador no impiden entrar o cambiar de mesa, y la transferencia no las mueve.
- Historial inmutable: ciclos, ingresos y transferencias no se borran.

## Compras y crédito

Reglas definitivas del Módulo 08 (reemplazan las anteriores) — ver `docs/MODULE_08_PURCHASES.md`:

- Hay compra inicial y recompras: la primera compra **confirmada** del jugador en la sesión es la inicial; las siguientes son Recompra 1, 2, 3… por (sesión, jugador), sin reiniciar al cambiar de mesa. Los borradores cancelados no consumen números.
- **Compra por importe**: el cajero captura solo el importe; nunca denominaciones, cantidades ni combinaciones. Se valida y descuenta el valor nominal del inventario compartido.
- Una compra puede estar **pagada, parcialmente pagada o totalmente a crédito**, sin límite. Métodos: efectivo, transferencia, tarjeta de débito por terminal, tarjeta de crédito por terminal, y combinaciones. El crédito **no es un método de pago** ni dinero recibido: es `importe − pagos confirmados`.
- Solo cuentan los pagos **confirmados**: efectivo recibido, transferencias verificadas manualmente y cobros de terminal **aprobados**. Una transferencia pendiente es parte del saldo por cobrar (no otra deuda) y no aumenta el banco. Un cobro de terminal aprobado no aumenta el efectivo: queda «por liquidar» hasta el depósito, que no reconoce la venta otra vez.
- **Todo crédito identifica al socio (PARTNER activo) que lo autorizó**, verbalmente o por mensaje. El cajero registra la autorización comunicada; no hay aprobación en línea ni se envía nada al socio. Ya no existe el crédito otorgado sin registrar al socio autorizador.
- Cada compra pertenece a una sesión, una mesa (la de su participación al registrarse, que conserva aunque el jugador se cambie) y un jugador.
- Una compra confirmada es inmutable; el reverso es un procedimiento justificado (hoy solo solicitud, ejecución en Módulos 10/11).

## Entregas y deudas

- La **firma del jugador** en el celular del cajero es obligatoria **solo cuando la compra genera crédito** (cualquier saldo por cobrar, aunque sea parcial), es **independiente para cada compra o recompra con crédito** y acepta un resumen exacto e inmutable de esa compra; un cambio material antes de entregar la invalida (se conserva como evidencia) y exige firmar de nuevo. Las compras totalmente pagadas no requieren firma. El jugador no necesita cuenta. Ver `docs/MODULE_09_SIGNATURES_RECEIPTS.md`.
- **La firma no es la entrega**: no descuenta inventario, no crea deuda ni mueve dinero. **El cajero confirma la entrega después**; solo entonces se aplican inventario, pagos y crédito (Módulo 08).
- Toda compra confirmada tiene un **comprobante digital** (no PDF) con su snapshot inmutable, descargable en **PNG** y compartible **manualmente**; los pagos posteriores no lo modifican. No se envía nada automáticamente desde este flujo.
- Se mantiene control de deudas y abonos por jugador.
- Al liquidar (Módulo 11): devolución de fichas por valor nominal + firma obligatoria + decisión EXPLÍCITA de compensar (no, parcial o máximo) + pago del neto (completo, parcial o pendiente). **Ya no se compensa automáticamente** por existir deuda; si se compensa, la distribución es FIFO automático (más antigua primero) y no se elige a mano.

## Créditos y abonos (Módulo 10) — decisiones permanentes

Ver `docs/MODULE_10_CREDITS.md`.

- **DEC-01/02:** abonos durante una sesión OPEN y abonos ADMINISTRATIVOS sin sesión abierta. **DEC-03:** un abono administrativo nunca modifica la caja de una sesión cerrada (su efectivo queda en custodia administrativa).
- **DEC-04/05:** los abonos generales se aplican automáticamente por FIFO (la deuda más antigua primero). **DEC-06:** se permiten abonos parciales. **DEC-07/08:** no se aceptan abonos mayores al saldo ni se crean saldos a favor.
- **DEC-09…12:** cada abono confirmado genera un comprobante digital, descargable en PNG y compartible manualmente; no hay PDF.
- **DEC-13:** las transferencias pendientes no reducen deuda. **DEC-14:** un cobro de terminal APROBADO es pago confirmado aunque el depósito esté pendiente. **DEC-15:** el depósito de la terminal no es otra venta ni otro abono.
- **DEC-16/17/18:** las deudas conservan compra, sesión y mesa originales; cambiar de mesa o cerrar la sesión no las modifica ni elimina. **DEC-19:** sin límite de crédito.
- **DEC-20/21/22:** nadie edita saldos; lo confirmado no se borra; las correcciones son reversos auditados.
- **DEC-23:** las compensaciones con fichas del Módulo 11 usan el mismo motor de aplicaciones, sin crear ingresos monetarios, y solo cuando el cajero decide compensar.
- La custodia administrativa no es una caja de juego: no pertenece a una mesa, no se suma a la apertura de la sesión (que sigue en $0) y se deposita al banco como traslado. Si está donde se hace el arqueo de apertura, se segrega antes de contar.
- Dinero real recibido que excede la deuda (p. ej. transferencia verificada después de que la deuda se pagó por otro medio) se registra como fondos no aplicados pendientes de devolución; nunca se oculta ni se usa como saldo a favor.

## Liquidaciones (Módulo 11) — ver `docs/MODULE_11_SETTLEMENTS.md`

- **LIQ-DEC-01/02:** TODAS las liquidaciones requieren firma individual del jugador, incluso con $0 devueltos.
- **LIQ-DEC-03:** se puede confirmar la recepción física y dejar pendiente el pago total o parcial (obligación por pagar al jugador).
- **LIQ-DEC-04/05/06:** pago en efectivo, por transferencia bancaria o mixto.
- **LIQ-DEC-07/08:** la compensación es OPCIONAL y la decide el cajero: no compensar, parcial o máximo posible. **LIQ-DEC-09/10:** si compensa, FIFO automático; no se eligen deudas manualmente. **LIQ-DEC-11:** la compensación no es ingreso de efectivo ni de banco.
- **LIQ-DEC-12/13:** las fichas devueltas regresan al inventario compartido una sola vez, por valor nominal, sin denominaciones.
- **LIQ-DEC-14:** una transferencia saliente solo cuenta como pagada al confirmarse su ejecución real. **LIQ-DEC-15:** la caja nunca queda negativa. **LIQ-DEC-16:** no se paga más que lo pendiente.
- **LIQ-DEC-17/18/19:** comprobante digital, descargable en PNG y compartible manualmente; sin PDF.
- **LIQ-DEC-20:** los pagos pendientes se administran después del cierre de mesa o sesión sin reabrir cajas cerradas (custodia administrativa fondeada con aportaciones documentadas, o banco).
- Reingreso: un jugador con liquidación pendiente de pago en la sesión no vuelve a jugar en esa sesión hasta que se le pague.

## Cierre de mesas y sesiones (Módulo 12) — ver `docs/MODULE_12_CLOSURE.md`

- **DEC-01/02:** un único arqueo físico global de fichas al terminar todas las mesas; ninguno al cerrar cada mesa. Cada mesa cierra su ciclo por separado (con SETTLING permitido).
- **DEC-03:** una diferencia física bloquea el cierre hasta un recuento, un regreso a Abierta o un ajuste excepcional autorizado (solo PARTNER/SUPERADMIN, nunca el cajero) que no oculta la diferencia original.
- **DEC-04/05:** solo PARTNER o SUPERADMIN confirman el cierre definitivo; CASHIER prepara, cuenta, documenta el retiro y consulta.
- **DEC-06/07:** el retiro final registra importe, operador, receptor y fecha; el receptor no confirma ni firma.
- **DEC-08/09:** se puede cerrar una sesión que nunca abrió mesas, con motivo obligatorio (no se usa CANCELLED).
- **DEC-10/11/12:** se puede regresar de CLOSING a OPEN con motivo y auditoría; una sesión CLOSED nunca se reabre.
- **DEC-13:** la caja física inicia y termina en $0.00.
- **DEC-14/15/16/17:** deudas, pagos pendientes a jugadores y cobros bancarios o de terminal pendientes sobreviven con su estado real; el cierre no inventa pagos ni compensa.
- **DEC-18/19:** comprobante de cierre digital, PNG y compartición manual; sin PDF.
- **DEC-20/21/22/23 (regla permanente):** «Las fichas que no regresan al cierre se muestran como valor nominal pendiente de retorno o en circulación. No constituyen automáticamente un faltante físico de arqueo ni utilidad definitiva y no se pagan sin una presentación y validación física posterior.» La circulación es global y continua entre sesiones (no bloquea la siguiente apertura); su atribución por jugador es solo informativa. Nunca se paga dos veces el mismo valor ni se registra dos veces una devolución.

## Reportes y estadísticas (Módulo 14) — ver `docs/MODULE_14_REPORTS.md`

- **Toda deuda debe poder consultarse de forma global por jugador, desglosada por sesión de origen y finalmente por cada compra o recompra. Los pagos posteriores se aplican a las obligaciones originales y no trasladan la deuda a la fecha o sesión del pago.**
- Cada sesión muestra crédito original, abonos aplicados, compensaciones, reversos y saldo pendiente actual. Los abonos generales se reflejan por FIFO (Módulo 10) sobre las obligaciones más antiguas; los pagos vinculados a una compra conservan esa compra.
- Se distinguen la **deuda al cierre** (histórica, comprobante inmutable) y la **deuda actual originada** en esa sesión (movimientos vigentes); la diferencia se explica por abonos, pagos vinculados, compensaciones y reversos posteriores.
- Las cifras nominales, monetarias, por cobrar y por pagar se muestran separadas y nunca se suman. No se declara utilidad neta hasta contar con una fórmula contable validada; no se atribuyen ganancias exactas por mesa.
- Los reportes son de solo lectura: ningún rol edita saldos, compras, movimientos ni arqueos desde ellos. SUPERADMIN, PARTNER y CASHIER consultan todos los reportes y exportan.
- Exportación exclusivamente en Excel XLSX (sin CSV ni PDF), con los mismos cálculos de pantalla.

## Auditoría, correcciones, integridad y respaldos (Módulo 15) — ver `docs/MODULE_15_AUDIT_ADMIN_BACKUP.md`

- Toda operación crítica deja evidencia en la auditoría inmutable; nadie edita ni borra eventos. SUPERADMIN, PARTNER y CASHIER consultan la auditoría operativa y financiera.
- Los movimientos confirmados nunca se modifican: se corrigen con una solicitud de corrección excepcional que CASHIER puede pedir y solo PARTNER o SUPERADMIN autorizan. Una autorización no reemplaza el procedimiento financiero legítimo de su módulo y no genera movimientos.
- La integridad se valida sin crear saldos ficticios. Las fichas legítimamente en circulación no son faltantes de arqueo y las deudas pendientes no son errores.
- Los respaldos cubren la base de datos y las evidencias privadas, deben ejecutarse automáticamente cada día y registrar resultados verificables; las restauraciones de prueba se hacen periódicamente en entornos aislados. Solo SUPERADMIN autoriza una recuperación de producción, que nunca es una restauración destructiva sin controles.

## Notificaciones

- Las compras y recompras **a crédito** generan una notificación automática por WhatsApp Business Cloud API. **El número exclusivo de Poker Manager está pendiente de recepción**: la integración está en `PENDING_CONFIGURATION` y se construirá en el Módulo 13. Su ausencia no bloquea ningún otro módulo.
- El mensaje se envía **después** de confirmar la compra (no antes, no en paralelo sin confirmación). Desde el Módulo 08, una compra confirmada con crédito registra un evento persistente (`notification_outbox`, deduplicado); las compras pagadas no generan evento. Un fallo de notificación nunca revierte la compra.
- El mensaje debe informar: hora, importe de la operación actual, acumulado comprado (en la sesión) y deuda pendiente del jugador.

## Jugadores (Módulo 03) — ver `docs/MODULE_03_PLAYERS.md`

- Un jugador **no es un usuario**: sin correo, contraseña ni rol.
- Teléfono **obligatorio**, normalizado a **E.164** y **único** (México +52 por defecto; internacionales válidos). El formato válido no prueba la titularidad.
- Nombre obligatorio; apodo opcional. Nombre y apodo pueden repetirse y nunca se fusionan jugadores por nombre.
- **Crédito sin límite** (ni por jugador ni global), registrado por los tres roles sin aprobación en el sistema pero identificando al socio que lo autorizó (Módulo 08). Cada compra a crédito queda ligada a un jugador, al socio autorizador y con firma, y la deuda persiste entre sesiones y se compensa por FIFO. Crédito ilimitado no significa sin auditoría.
- Las deudas **nunca** son campos del jugador: se derivarán de operaciones confirmadas y no se editan a mano.
- Sin borrado físico. Desactivar conserva historial y deudas, impide seleccionarlo para nuevas compras o sesiones y se puede revertir.
- El teléfono obligatorio **no** implica consentimiento de WhatsApp. El consentimiento es explícito (checkbox desmarcado), del jugador y no del operador, con versión del aviso, revocable y con historial. Al cambiar de número deja de estar vigente. Sin consentimiento vigente no se envían mensajes por WhatsApp.
- Las notas internas nunca se envían al jugador ni sustituyen datos de deudas o pagos.

## Inventario de fichas (Módulo 04) — ver `docs/MODULE_04_CHIP_INVENTORY.md`

- **Compras y recompras solo por importe nominal** (regla permanente): no se exige ni almacena desglose por denominación en cada entrega. El inventario operativo usa un **saldo nominal compartido**: bajo custodia, reservado y en circulación. Las cantidades físicas por denominación se verifican en los arqueos.

- **Un solo inventario** para ambas mesas, en una sola ubicación física (`INVENTARIO-GENERAL`): las existencias se llevan por denominación y son comunes. Las compras de ambas mesas consumen el mismo stock; las devoluciones regresan al mismo stock; las reservas son globales. Los movimientos conservan su mesa, sesión y jugador solo como trazabilidad. Un jugador que cambia de mesa conserva sus fichas: no hay conversión entre mesas.
- El inventario **no es la caja**: las fichas no son efectivo y su valor nominal nunca se suma al saldo de caja. Ningún movimiento de fichas genera ingresos ni egresos.
- Disponible = bajo custodia − reservadas. Inventario activo = bajo custodia + en circulación. Las reservadas ya están dentro de la custodia.
- Inventario inicial: una sola vez para el inventario común, contando todas las denominaciones activas; las correcciones posteriores son ajustes.
- Entradas, bajas y **ajustes** los registran SUPERADMIN, PARTNER o CASHIER **sin aprobación adicional**, con **motivo obligatorio** y auditoría, siempre sobre el inventario común. Las bajas solo usan fichas disponibles.
- Los movimientos confirmados son **inmutables**: se corrigen con ajustes nuevos.
- Arqueos: un arqueo general del inventario común (incluidas las reservadas, no las fichas en circulación). Confirmar no ajusta. Conciliar es explícito, con motivo, y una sola vez. Un arqueo con existencias cambiadas desde que se calculó el esperado no se confirma.
- Las compras y liquidaciones futuras usarán reservas, entregas y devoluciones del inventario, sin duplicar movimientos.

## Usuarios y roles

Detalle completo y matriz de permisos: [`docs/ROLES_AND_PERMISSIONS.md`](ROLES_AND_PERMISSIONS.md).

| Rol          | Alcance                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPERADMIN` | Propietario. Control total: operación, finanzas, auditoría completa, **y en exclusiva** administración de usuarios, roles, seguridad y configuración crítica.                                                                 |
| `PARTNER`    | Socio. **Prácticamente las mismas capacidades de operación y visibilidad financiera que SUPERADMIN**, sin administración de usuarios, roles, seguridad ni configuración crítica.                                              |
| `CASHIER`    | Cajero. Opera sesiones y caja central (arqueos, compras, crédito, firmas, abonos, liquidaciones (compensación opcional con FIFO), cierre) **sin aprobación de socios**. Sin reportes de ganancias globales ni administración. |

- Configuración inicial: 1 `SUPERADMIN`, 2 `PARTNER`, 1 `CASHIER` — son cuentas iniciales, no límites.
- No hay registro público — los usuarios se crean vía bootstrap (`npm run db:seed`, solo el primer SUPERADMIN) o por un `SUPERADMIN` autenticado.
- Un usuario desactivado (`isActive = false`) no puede iniciar sesión y sus sesiones abiertas dejan de valer de inmediato.
- **Nunca se borran usuarios físicamente**: se desactivan, conservando todo su historial (operaciones, auditoría).
- El sistema **siempre** conserva al menos un SUPERADMIN activo.
- Nadie puede cambiar su propio rol ni desactivarse a sí mismo.
- Asignar roles (incluido SUPERADMIN) solo es posible desde rutas exclusivas de SUPERADMIN.
- Las credenciales iniciales y los restablecimientos generan una contraseña temporal que el usuario debe cambiar en su primer acceso; no se envían por correo.
- Todo cambio administrativo y todo evento de seguridad relevante queda en `audit_logs`, que es inmutable (ni PARTNER ni nadie puede alterarla o borrarla).
- Un permiso de rol no exime de las reglas de negocio ni de los estados de cada operación (p. ej. sesión cerrada → no editable).

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

## Explícitamente fuera de alcance de los Módulos 00 a 15

No implementado todavía (se construye en módulos posteriores — ver `docs/MODULES.md`): reversos completos de compras, canje posterior de fichas no retornadas (solo contrato en el Módulo 12), envío real de WhatsApp (Módulo 13), conciliación de comisiones de terminal y devolución de fondos recibidos no aplicados.

## Operaciones financieras especiales (Módulo 16) — ver `docs/MODULE_16_SPECIAL_OPERATIONS.md`

- Lo original no se modifica: toda corrección es un movimiento nuevo (fichas, aplicaciones, obligaciones o asientos) con folio propio y auditoría.
- Autorizar no es ejecutar: PARTNER/SUPERADMIN autorizan; CASHIER solicita y ejecuta lo autorizado. Una solicitud solo queda EXECUTED cuando los efectos reales se registraron.
- Canje posterior: solo se acepta lo validado por un socio, dentro de la circulación global, y solo se paga lo recibido físicamente; la sesión de origen es informativa y no cambia.
- Reverso de compra: exige devolución física del valor completo; la deuda restante se extingue sin dinero y solo se reembolsa lo realmente pagado. Si la participación ya se liquidó, se corrige la liquidación.
- Corrección de liquidación: con firma del jugador; revertir la compensación restablece las deudas y crea lo que se le debe pagar, sin mover efectivo.
- Fondos no aplicados: se devuelven por exactamente lo recibido; nunca son saldo a favor.
- Nada cuenta como pagado sin un pago real ejecutado; las transferencias en trámite no pagan; no hay efectivo negativo ni pagos desde cajas cerradas.

## Mesa interactiva — ver `docs/POKER_TABLE_UX_REDESIGN.md`

- Nueve asientos fijos por mesa; el dealer es una persona (no usuario ni asiento) que se muestra dentro de la mesa entre los asientos 7 y 6. No hay botón «D» ni rotación.
- Sentar a un jugador no es una compra: queda pendiente de compra y no recibe fichas, crédito ni firma hasta su primera compra confirmada.
- La primera compra confirmada del jugador en la sesión es la inicial; las siguientes son recompras, aunque cambie de asiento o de mesa.
- Cambiar de asiento o de mesa no mueve dinero ni fichas; el jugador conserva compras, deuda y numeración.
- Quien nunca recibió fichas puede retirarse sin compra (con motivo); quien recibió fichas sale con liquidación (firma obligatoria, compensación opcional FIFO, recepción física por separado). Al confirmar la recepción se libera su asiento; si falta pagarle, la obligación sigue en Liquidaciones.
- El color del paño es solo visual y por mesa.

## Folios de sesión y sesiones históricas — ver `docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md`

- Cada sesión tiene un folio `S-0001-AAAAMMDD`: un consecutivo único que nunca se reinicia ni se reutiliza, más la fecha operativa (el día en que comenzó la jornada, aunque termine después de medianoche). El folio no cambia nunca.
- La fecha operativa es distinta de la fecha real en que se registró, abrió o cerró la sesión y de las fechas de sus movimientos. Los reportes por jornada usan la fecha operativa; los pagos posteriores conservan su fecha real.
- Solo SUPERADMIN puede registrar una sesión de una fecha anterior. Esa sesión histórica no tiene caja, inventario ni operación, no afecta a la sesión vigente y solo puede cancelarse. Las operaciones financieras de fechas pasadas no se capturan todavía.

## Jugadores bancados por la casa (Módulo 17)

- Información PRIVADA: nunca visible en la mesa ni en vistas compartidas; solo en la sección de bancaje con `banking:read`.
- Ciclos de exactamente cuatro jugadas (sesiones distintas); cambiar de mesa no crea otra; sin fichas trasladadas entre sesiones (devolución física o retorno cero confirmado).
- Las compras financiadas son operaciones nominales reales, sin cobro, crédito ni deuda ordinaria; el financiamiento de la casa no usa el FIFO de deudas.
- Resultado = devuelto − financiado. Compensación: ganancias del ciclo → reserva → arrastre; solo la ganancia neta se reparte por porcentaje. Sin doble aplicación de pérdidas, reservas ni anticipos.
- Cambios de porcentaje, cortes, distribución de pérdidas entre tramos y retiros de reserva: aprobación digital de PARTNER o SUPERADMIN. Anticipos: autorización verbal o por mensaje registrada por el cajero, dentro del límite conservador. Anticipos excedidos: caso por caso.
- Ver `docs/MODULE_17_BANKED_PLAYERS.md`.

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
