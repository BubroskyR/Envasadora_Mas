# Consumo con período y ajuste automático del consumo

- **Fecha:** 2026-10-27
- **Estado:** diseño aprobado por partes en el chat; falta la revisión de este documento.
- **Repos:** `envasadora-backend` (servidor y base) y `envasadora-frontend` (app).

## Objetivo

Hoy cada cliente tiene un número entero de **bidones por semana** (`consumo_semanal_estimado`). Con ese número
y los bidones de la última entrega, la app calcula cuántos días le dura el agua; eso ordena la Ruta, arma el
filtro de urgentes, da los colores del mapa y propone la cantidad al registrar una entrega. Hay dos problemas:

1. No se puede cargar menos de 1 bidón por semana. Un cliente que toma 1 por mes aparece sin agua a los pocos días.
2. El consumo real cambia (por ejemplo, en verano) y hoy hay que corregirlo a mano cliente por cliente.

**Se considera logrado cuando:**

- Se puede cargar "1 por mes", "1 cada 2 semanas", "3 por semana", etc., y la urgencia, el orden de la Ruta y
  el mapa lo tienen en cuenta.
- Cuando un cliente cambia de ritmo de forma sostenida, la app ajusta su consumo sola; un evento aislado (una
  semana con muchos pedidos) no cambia nada.
- El ajuste se ve en el perfil del cliente y se puede deshacer con un toque.

## Decisiones tomadas en el chat

| # | Tema | Decisión |
|---|------|----------|
| 1 | Cómo se carga el consumo | Bidones + período: por semana, cada 2 semanas, cada 3 semanas o por mes. |
| 2 | Confirmación del ajuste | Automático, sin confirmación; se avisa en el perfil y se puede deshacer. |
| 3 | Repeticiones | 3 veces seguidas, repartidas en más de 1,5 períodos del cliente. |
| 4 | Dónde se avisa | Solo en el perfil del cliente (no en la Ruta). |
| 5 | Dónde se calcula | En el servidor, al registrar cada entrega. |

---

## Parte 1: lo que se ve en la app

### 1.1 Cargar y ver el consumo

- En el alta y la edición del cliente, el campo "Bidones/Sem" pasa a ser **Consumo**: un número de bidones y
  un período (*por semana*, *cada 2 semanas*, *cada 3 semanas*, *por mes*). Por defecto: 1 por semana.
- Los clientes existentes quedan como "N por semana" con su número actual.
- La urgencia usa el consumo por día. Ejemplo: María, 1 por mes, recibió 1 bidón hace 20 días → le quedan
  unos 10 días y no está urgente (hoy, cargada como 1 por semana, figura sin agua desde hace 13 días).
- Al registrar una entrega, la cantidad propuesta son los bidones del consumo (María: 1; un cliente de
  3 por semana: 3).
- Perfil: "Consumo: 1 bidón por mes". Ruta (columna de consumo, visible en pantallas grandes): "1/mes",
  "3/sem", "1 c/2 sem", "1 c/3 sem".
- El alta de clientes sin conexión guarda también el período.

### 1.2 El ajuste automático

**Comparación en cada entrega.** Cuando llega una entrega, se mira cuántos días le duraron al cliente los
bidones de la entrega anterior y se compara con lo que le tendrían que haber durado según su consumo:

- **Pidió antes:** le duraron 2/3 de lo esperado o menos (pidió cuando le quedaba un tercio del agua o más).
- **Pidió después:** le duraron 1,5 veces lo esperado o más.
- **Normal:** cualquier otro caso. Un pedido normal corta la racha.

Ejemplo con Juan (1 por semana, lo esperado son 7 días por bidón): pedir a los 4 días o antes es "antes";
a los 11 días o más es "después"; de 5 a 10 días es normal. La cantidad también cuenta: si a Juan se le dejan
2 bidones por semana, es "antes", porque esos 2 le tendrían que durar 14 días.

**Cuándo se ajusta.** Cuando las últimas comparaciones forman una racha del mismo tipo ("antes" o "después")
que cumple las dos condiciones:

1. tiene al menos **3 comparaciones**;
2. sus días suman **al menos 1,5 períodos** del consumo actual (más de 10 días para un cliente semanal,
   al menos 45 días para uno mensual).

La segunda condición evita que una sola semana con muchos pedidos (una fiesta, visitas) cambie el consumo.
Si Juan pasa a pedir cada 3 o 4 días, se ajusta entre los 10 y los 14 días.

**A qué valor ajusta.** Ritmo de la racha = bidones dejados al inicio de cada comparación de la racha ÷ días
de la racha. Se elige el consumo más parecido (en proporción) entre: *N por semana* (N ≥ 1),
*1 cada 2 semanas*, *1 cada 3 semanas* y *1 por mes*. Ejemplo: Juan pidió a los 4, 3 y 4 días con 1 bidón
cada vez → 3 bidones en 11 días ≈ 1,9 por semana → **2 por semana**. Si el más parecido es el consumo actual,
no se cambia nada.

**Aviso y deshacer.** En el perfil: "Ajustado por la app el 12 dic (antes: 1 bidón por semana)" y el botón
**Volver a 1 bidón por semana** (los consumos se escriben como en el resto del perfil). La fecha es la de la entrega que disparó el ajuste. El aviso queda hasta que el
consumo se cambie a mano; si hay un ajuste nuevo, el aviso pasa a mostrar ese y "Volver a…" deshace solo el
último. El botón necesita conexión, como editar, y no aparece en clientes creados sin conexión que todavía no
se enviaron.

**Cuándo vuelve a empezar la cuenta.** Después de cada ajuste y cada vez que se cambia el consumo a mano
(incluido "Volver a…"). Si el cliente sigue con el ritmo nuevo después de volver atrás, se ajusta otra vez
cuando se cumpla de nuevo la regla.

**Otros detalles.**

- Varias entregas del mismo día cuentan como una sola visita (se suman los bidones).
- Las entregas de 0 bidones se ignoran.
- Las entregas cargadas sin conexión cuentan con su fecha real cuando llegan al servidor; si su fecha es
  anterior al último cambio de consumo, no cuentan.
- Las entregas ya registradas antes de esta versión también cuentan.
- Un cliente necesita al menos 4 visitas (3 comparaciones) para que se lo pueda ajustar.

### 1.3 Fuera de alcance

- Aviso de ajustes en la Ruta (decisión 4).
- Desactivar el ajuste para un cliente puntual.
- Períodos más largos que un mes.
- Historial de todos los ajustes: solo se guarda el último.
- Pedidos que no terminaron en una entrega registrada.

---

## Parte 2: diseño técnico

### 2.1 Base de datos (`prepararBaseDeDatos`, idempotente)

Columnas nuevas en `clientes`:

| Columna | Tipo | Uso |
|---------|------|-----|
| `consumo_bidones` | INTEGER NOT NULL DEFAULT 1 | Bidones por período. |
| `consumo_dias` | INTEGER NOT NULL DEFAULT 7 | Período en días: 7, 14, 21 o 30. |
| `consumo_desde` | DATE | Solo cuentan las comparaciones que terminan en una visita posterior a esta fecha. NULL = todas. |
| `consumo_ajustado_en` | DATE | Fecha del último ajuste automático (NULL si no hubo o se cambió a mano después). |
| `consumo_anterior_bidones` | INTEGER | Consumo previo al último ajuste, para "Volver a…". |
| `consumo_anterior_dias` | INTEGER | Ídem. |

Migración (se repite sin efectos en cada arranque):

```sql
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_bidones INTEGER;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_dias INTEGER;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_desde DATE;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_ajustado_en DATE;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_anterior_bidones INTEGER;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consumo_anterior_dias INTEGER;
UPDATE clientes
   SET consumo_bidones = COALESCE(consumo_bidones, GREATEST(COALESCE(consumo_semanal_estimado, 1), 1)),
       consumo_dias = COALESCE(consumo_dias, 7)
 WHERE consumo_bidones IS NULL OR consumo_dias IS NULL;
ALTER TABLE clientes ALTER COLUMN consumo_bidones SET DEFAULT 1;
ALTER TABLE clientes ALTER COLUMN consumo_bidones SET NOT NULL;
ALTER TABLE clientes ALTER COLUMN consumo_dias SET DEFAULT 7;
ALTER TABLE clientes ALTER COLUMN consumo_dias SET NOT NULL;
```

`consumo_semanal_estimado` se mantiene como valor derivado,
`GREATEST(1, ROUND(consumo_bidones * 7.0 / consumo_dias))`, y se actualiza en cada escritura del consumo
(alta, edición y ajuste). Lo siguen usando las cargas que hayan quedado en la cola del teléfono con la
versión anterior de la app.

No hace falta un índice nuevo: `idx_entregas_cliente_fecha (cliente_id, fecha DESC)` ya cubre la consulta
de las últimas visitas de un cliente.

### 2.2 Regla del ajuste: `envasadora-backend/consumo.js`

Módulo CommonJS con funciones puras (sin base de datos), para probarlo por separado.

```js
// entregas: [{ fecha: 'AAAA-MM-DD', bidones }] en cualquier orden, como salen de la base
// consumo: { bidones, dias }    desde: 'AAAA-MM-DD' | null
// Devuelve null (sin cambios) o { bidones, dias, fecha } (fecha = la de la última visita)
// Lanza un Error si el consumo no es válido (el servidor lo atrapa y guarda la entrega igual)
calcularAjuste(entregas, consumo, desde)
```

Constantes: `PERIODOS_DIAS = [7, 14, 21, 30]`, `COMPARACIONES_MINIMAS = 3`, `UMBRAL_ANTES = 2/3`,
`UMBRAL_DESPUES = 1.5`, `PERIODOS_MINIMOS = 1.5`.

Algoritmo:

0. Visitas: agrupar las entregas por fecha sumando los bidones, descartar las de 0 bidones y ordenar por
   fecha ascendente.
1. Comparaciones: para cada par consecutivo `(a, b)` de visitas con `b.fecha > desde` (o todas si `desde`
   es null): `dias = b.fecha − a.fecha` (en días, calculado en UTC); `esperado = a.bidones × consumo.dias /
   consumo.bidones`; `razon = dias / esperado`; tipo `antes` si `razon ≤ 2/3`, `despues` si `razon ≥ 1,5`,
   si no `normal`.
2. Racha: desde la comparación más reciente hacia atrás, las consecutivas del mismo tipo que la última. Si la
   última es `normal`, no hay racha y el resultado es null.
3. Condiciones: racha de al menos 3 comparaciones y `Σ dias ≥ 1,5 × consumo.dias`. Si no se cumplen: null.
4. Ritmo: `Σ a.bidones / Σ dias` (bidones por día) sobre la racha.
5. Candidatos: `{1, 30}`, `{1, 21}`, `{1, 14}` y `{n, 7}` para n = 1 … ⌈ritmo × 7⌉ + 1. Se elige el de menor
   `|ln(ritmo_candidato) − ln(ritmo)|`.
6. Si el candidato es igual al consumo actual: null. Si no: `{ bidones, dias, fecha: última visita }`.

También exporta `semanalDerivado({ bidones, dias })` y `consumoValido(bidones, dias)`.

### 2.3 Servidor (`index.js`)

**`POST /api/clientes`**

- Acepta `consumo_bidones` (se redondea a entero; vacío o 0 → 1, como hoy) y `consumo_dias` (7, 14, 21 o 30;
  si no viene → 7; si viene otro valor → 400).
- Si no viene ninguno de los dos y sí viene `consumo_semanal_estimado` (versión anterior): bidones =
  ese número redondeado (mínimo 1), días = 7.
- Guarda `consumo_semanal_estimado` derivado. `consumo_desde` queda en NULL.

**`PUT /api/clientes/:id`**

- Si el cuerpo trae algún campo de consumo, la ruta usa una transacción y lee el cliente con
  `SELECT … FOR UPDATE`, para comparar el consumo pedido con el actual. Si no trae ninguno, sigue igual que
  hoy, con una sola consulta.
- `consumo_bidones` y/o `consumo_dias`: validados como en el alta (inválido → 400). Si viene solo uno de los
  dos, el otro se toma del consumo actual.
- Solo `consumo_semanal_estimado` (versión anterior): si es igual al guardado, se ignora (la app vieja manda
  el formulario completo sin haber tocado el consumo); si es distinto, se toma como N por semana.
- Si el consumo resultante es **distinto** del actual: se guarda, `consumo_desde = CURRENT_DATE`,
  `consumo_ajustado_en`, `consumo_anterior_bidones` y `consumo_anterior_dias` pasan a NULL, y se actualiza
  `consumo_semanal_estimado`. Si es **igual**, no se toca ninguna columna de consumo (corregir el teléfono no
  reinicia la cuenta).
- "Volver a…" es este mismo PUT con el consumo anterior; no hace falta una ruta nueva.

**`POST /api/entregas`** (solo cuando la entrega es nueva; los reintentos responden antes, como ahora)

Después de actualizar la deuda y antes del `COMMIT`, con el cliente ya bloqueado por el `FOR UPDATE`:

```
SAVEPOINT ajuste_consumo
  leer consumo_bidones, consumo_dias, consumo_desde del cliente
  leer las últimas 60 entregas del cliente: to_char(fecha, 'YYYY-MM-DD') y cantidad_bidones
  ajuste = calcularAjuste(entregas, consumo, desde)
  si hay ajuste: UPDATE clientes SET
      consumo_anterior_bidones = consumo_bidones, consumo_anterior_dias = consumo_dias,
      consumo_bidones = ajuste.bidones, consumo_dias = ajuste.dias,
      consumo_semanal_estimado = derivado,
      consumo_ajustado_en = ajuste.fecha, consumo_desde = ajuste.fecha
RELEASE SAVEPOINT ajuste_consumo
```

Si algo de ese bloque falla: `ROLLBACK TO SAVEPOINT ajuste_consumo`, se registra el error en el log y la
entrega se confirma igual. **El ajuste nunca puede hacer fallar una entrega**: si fallara, la entrega quedaría
trabada en la cola del teléfono reintentando para siempre.

Las rutas `GET` devuelven `SELECT *`, así que traen las columnas nuevas sin cambios.

### 2.4 App (`envasadora-frontend`)

- **`lib/clientes.ts`**
  - `Cliente` suma `consumo_bidones?`, `consumo_dias?`, `consumo_ajustado_en?`, `consumo_anterior_bidones?` y
    `consumo_anterior_dias?`. Son opcionales porque las copias guardadas en el teléfono con la versión
    anterior no los tienen.
  - `PERIODOS`: 7 → "por semana" / "/sem"; 14 → "cada 2 semanas" / " c/2 sem"; 21 → "cada 3 semanas" /
    " c/3 sem"; 30 → "por mes" / "/mes".
  - `consumoDe(cliente)` → `{ bidones, dias }`; si faltan los campos nuevos usa
    `{ consumo_semanal_estimado || 1, 7 }`.
  - `textoConsumo(consumo, 'largo' | 'corto')`: "1 bidón por mes", "3 bidones por semana" / "1/mes", "3/sem".
  - `calcularEstado`: duración = bidones de la última entrega ÷ (bidones ÷ días del consumo). Si no se sabe
    cuántos bidones se dejaron, se asumen los del consumo.
- **`components/CampoConsumo.tsx`** (nuevo): `CampoNumero` + selector de período. Lo usan el alta y la edición.
- **`app/page.tsx`**: el formulario de alta usa `CampoConsumo` y manda `consumo_bidones` y `consumo_dias`; la
  columna de consumo usa `textoConsumo(…, 'corto')`; `EntregaSheet` propone `max(1, consumo.bidones)`.
- **`app/cliente/page.tsx`**: el perfil muestra `textoConsumo(…, 'largo')`. Si hay `consumo_ajustado_en`,
  muestra el aviso y el botón "Volver a…", que hace un PUT con el consumo anterior y vuelve a cargar el perfil.
  Sin conexión muestra el mismo mensaje que editar. La edición usa `CampoConsumo`.
- **`lib/pendientes.ts`**: `ClienteNuevo` suma `consumo_bidones` y `consumo_dias`; `aplicarPendientes` arma el
  cliente local con esos campos y con `consumo_semanal_estimado` derivado.
- **`app/rutas/page.tsx` y `components/MapComponent.tsx`**: usan `calcularEstado`; solo cambian tipos si
  hace falta.
- Después de sincronizar, la app ya vuelve a pedir los datos (`datos-actualizados`), así que un ajuste hecho
  por el servidor aparece solo.

### 2.5 Errores y casos borde

| Caso | Comportamiento |
|------|----------------|
| Falla la cuenta del ajuste | Se descarta solo el ajuste (savepoint); la entrega se guarda. |
| `consumo_dias` inválido en alta o edición | 400 con mensaje claro. |
| Bidones vacíos o 0 en el alta | 1, como hoy. En la edición: 400, como hoy con el consumo semanal. |
| Cliente con menos de 4 visitas | Sin ajuste. |
| Entrega sin conexión con fecha anterior a `consumo_desde` | No cuenta. |
| Dos entregas simultáneas del mismo cliente | El `FOR UPDATE` existente las hace de a una. |
| Cola del teléfono con un cliente nuevo de la versión anterior | Se acepta como N por semana. |
| App vieja que edita otro dato del cliente | No pisa el período (regla del PUT). |

### 2.6 Pruebas

1. **`consumo.js`** (con `node:test`, sin base de datos):
   - Juan 1/sem con visitas cada 7 días → nunca ajusta.
   - Juan en verano: días 4, 3, 4 → 2/sem en la 3.ª comparación; días 3, 3, 4 (10 días) → todavía no, ajusta
     en la 4.ª.
   - Semana de fiesta (lun, mié, vie, lun y después semanal) → no ajusta.
   - Racha cortada por un pedido normal → no ajusta.
   - 1/sem que pasa a pedir cada 30 días → 1/mes en la 3.ª comparación.
   - 1/mes que pide cada 28 días → nunca ajusta.
   - 1/sem que recibe 2 bidones cada 7 días → 2/sem en la 3.ª.
   - Entregas del mismo día → una sola visita.
   - `desde`: las comparaciones que terminan en esa fecha o antes no cuentan.
   - Candidato igual al consumo actual → null.
2. **Rutas** (script con copia temporal de la base local, como los anteriores):
   - Migración: un cliente con `consumo_semanal_estimado = 2` queda en 2 cada 7 días.
   - Alta con período; alta solo con el campo viejo; `consumo_dias` inválido → 400.
   - Edición que cambia el consumo: `consumo_desde` = hoy y se limpia el aviso. Edición que solo cambia el
     teléfono: no toca el consumo. Edición de la app vieja con el mismo semanal: no pisa el período.
   - Ajuste disparado por entregas con fechas pasadas (dentro de los 90 días que acepta el servidor).
   - Reintento de una entrega (mismo `id_local`): no ajusta.
   - "Volver a…" (PUT con el consumo anterior): vuelve al valor y limpia el aviso.
   - Las pruebas existentes del modo sin conexión siguen pasando.
3. **App:** compilación, ESLint y la prueba completa en Chrome simulando un celular:
   - alta con "1 por mes" y urgencia correcta;
   - perfil con el aviso de ajuste y "Volver a…";
   - alta sin conexión con período y su envío posterior;
   - la prueba existente del modo sin conexión (29 controles) sigue pasando.

### 2.7 Publicación

1. Servidor primero: crea las columnas y acepta las dos formas de cargar el consumo. Verificar
   `GET /api/salud` con `base: 'lista'`.
2. Después la app.
3. Recomendación para el usuario al publicar: corregir a mano los clientes que ya se sabe que toman menos de
   1 por semana. Si no, la app los ajustaría sola recién después de varias entregas.
