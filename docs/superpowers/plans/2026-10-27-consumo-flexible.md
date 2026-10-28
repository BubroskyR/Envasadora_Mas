# Consumo con período y ajuste automático: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development (recomendado) o
> superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** cargar el consumo de cada cliente como bidones por período (semana, 2 semanas, 3 semanas, mes) y
que el servidor ajuste solo el consumo cuando el cliente cambia de ritmo de forma sostenida.

**Arquitectura:** la regla del ajuste es un módulo puro del backend (`consumo.js`). `POST /api/entregas` la
llama dentro de un savepoint de su transacción. La base guarda bidones y días por cliente, más el último
ajuste. `consumo_semanal_estimado` queda como valor derivado, por compatibilidad. La app calcula la urgencia
con el consumo por día y muestra el aviso del ajuste en el perfil.

**Tecnologías:** Express 5 + pg (CommonJS) y PostgreSQL (Neon); pruebas con `node:test` (Node 24).
Next.js 16, React 19, TypeScript y Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-10-27-consumo-flexible-design.md` (leerlo junto con este plan).

## Restricciones globales

- **Rutas:**
  - Backend: `C:\Users\Usuario\EnvasadoraProyecto\envasadora-backend`.
  - Frontend: `C:\Users\Usuario\EnvasadoraProyecto\envasadora-frontend`.
  - Scripts de prueba con base de datos o navegador (no van al repo):
    `C:\Users\Usuario\AppData\Local\Temp\claude\c--Users-Usuario-EnvasadoraProyecto-envasadora-backend\05067f0a-c885-40ff-a5f1-9faed1ae7c91\scratchpad`.
- **Idioma:** todo texto visible en la app va en español rioplatense. Los comentarios van en español, con la
  densidad del código existente.
- **Períodos:** exactamente 7, 14, 21 y 30 días.
  - Textos largos: "por semana", "cada 2 semanas", "cada 3 semanas", "por mes".
  - Textos cortos: "/sem", " c/2 sem", " c/3 sem", "/mes".
- **Regla del ajuste:**
  - "antes" si la razón es ≤ 2/3; "después" si la razón es ≥ 1,5;
  - hace falta una racha de al menos 3 comparaciones con Σ días ≥ 1,5 × `consumo_dias`.
- **Base y servidor:**
  - Las migraciones van solo en `prepararBaseDeDatos` y tienen que ser idempotentes.
  - El ajuste nunca hace fallar una entrega.
  - El servidor sigue aceptando `consumo_semanal_estimado` solo (versión anterior de la app y colas viejas del
    teléfono).
- **Sin commits:** no commitear ni pushear durante la implementación, porque los commits los pide el usuario.
  La Tarea 8 se hace solo cuando él lo pida.
- **Next.js:** antes de usar una API de Next que el proyecto todavía no usa, leer `node_modules/next/dist/docs/`
  (lo pide AGENTS.md).
- **Windows:** los archivos tienen CRLF, así que hay que editar con la herramienta Edit y no con reemplazos por
  `node -e`.

## Puntos a vigilar

1. **Copia vieja de `/clientes` en el teléfono, sin los campos nuevos:** la Ruta y el mapa tienen que seguir
   calculando la urgencia con el consumo semanal (prueba en la Tarea 4).
2. **Consumo inválido guardado (0 bidones o 0 días):** la app no puede mostrar NaN ni romperse; usa 1 por
   semana (prueba en la Tarea 4).
3. **Entrega cargada sin conexión con fecha anterior al último cambio de consumo:** no cuenta para el ajuste
   (pruebas en las Tareas 1 y 3).
4. **Teléfono con la app vieja que edita otro dato de un cliente mensual:** el cliente sigue mensual (prueba en
   la Tarea 2).
5. **"Volver a…" sin conexión:** avisa que hace falta conexión y el consumo no cambia (prueba en la Tarea 7).

---

### Tarea 1: regla del ajuste (`consumo.js`)

**Archivos:**
- Crear: `envasadora-backend/consumo.js`
- Crear: `envasadora-backend/test/consumo.test.js`
- Modificar: `envasadora-backend/package.json` (script `test`)

**Interfaces** (lo que produce, con `module.exports`):
- `PERIODOS_DIAS = [7, 14, 21, 30]`.
- `consumoValido(bidones: number, dias: number): boolean`: bidones entero ≥ 1 y `dias` en `PERIODOS_DIAS`.
- `semanalDerivado({ bidones, dias }): number`, que es `Math.max(1, Math.round(bidones * 7 / dias))`.
- `calcularAjuste(entregas: { fecha: 'AAAA-MM-DD', bidones: number }[], consumo: { bidones, dias }, desde: 'AAAA-MM-DD' | null): null | { bidones, dias, fecha }`:
  - lanza un `Error` si `!consumoValido(consumo.bidones, consumo.dias)`;
  - sigue el algoritmo de la sección 2.2 del spec (pasos 0 a 6).

- [ ] **Paso 1: escribir las pruebas** en `test/consumo.test.js` con `node:test` y `node:assert/strict`.
  - Helper: `visitasCada(intervalos, bidones = 1, inicio = '2026-07-01')`. Devuelve una entrega en `inicio`
    y otra después de cada intervalo de días.
  - Las pruebas usan el consumo `{ bidones: 1, dias: 7 }` y `desde = null`, salvo que se indique otra cosa.

  | Prueba | Entrada | Esperado |
  |---|---|---|
  | semanal estable | `visitasCada([7,7,7,7])` | `null` |
  | verano 4-3-4 | `visitasCada([4,3,4])` | `{ bidones: 2, dias: 7, fecha: '2026-07-12' }` |
  | verano 3-3-4: todavía no | `visitasCada([3,3,4])` | `null` (10 días < 10,5) |
  | verano 3-3-4-4 | `visitasCada([3,3,4,4])` | `{ 2, 7, '2026-07-15' }` |
  | semana de fiesta | `visitasCada([2,2,3])` y `visitasCada([2,2,3,7])` | `null` y `null` |
  | racha cortada | `visitasCada([3,3,7,4])` | `null` |
  | semanal que pasa a mensual | `visitasCada([30,30,30])` | `{ 1, 30, '2026-09-29' }` |
  | mensual cada 28 días | consumo `{1,30}`, `visitasCada([28,28,28])` | `null` |
  | 2 bidones por semana | `visitasCada([7,7,7], 2)` | `{ 2, 7, '2026-07-22' }` |
  | el mismo día se suma | 1 bidón el 07-01 y dos entregas de 1 bidón el 07-08, 07-15, 07-22 y 07-29, en desorden | `{ 2, 7, '2026-07-29' }` |
  | 0 bidones se ignoran | `visitasCada([4,3,4])` más `{ fecha: '2026-07-03', bidones: 0 }` | igual que "verano 4-3-4" |
  | desde | `visitasCada([4,3,4])` con `desde = '2026-07-05'` / `'2026-07-01'` | `null` / el ajuste a 2 por semana |
  | igual al actual | consumo `{1,30}`, `visitasCada([50,50,50])` | `null` |
  | consumo inválido | consumo `{ bidones: 1, dias: 0 }` | lanza un error |

  Además:
  - `semanalDerivado`: `{1,30}` → 1, `{3,7}` → 3 y `{5,14}` → 3.
  - `consumoValido`: `(1,7)` y `(2,30)` dan `true`; `(0,7)`, `(1.5,7)` y `(1,10)` dan `false`.
- [ ] **Paso 2:** en `package.json`, poner `"test": "node --test"`. Correr `npm test` en el backend. Tiene que
  fallar con "Cannot find module '../consumo'".
- [ ] **Paso 3:** implementar `consumo.js`.
  - Calcular los días entre fechas con `Date.UTC`.
  - Elegir el candidato con la menor diferencia de logaritmos, como dice el spec.
- [ ] **Paso 4:** correr `npm test`. Tienen que pasar todas las pruebas.

### Tarea 2: base de datos, y alta y edición con período (backend)

**Archivos:**
- Modificar `envasadora-backend/index.js`:
  - `prepararBaseDeDatos`: la migración va después del bloque de `id_local` (línea ~87).
  - `POST /api/clientes` (líneas ~270-320).
  - `PUT /api/clientes/:id` (líneas ~390-456).
- Crear en el scratchpad: `probar-consumo-backend.js`, con la misma estructura que
  `probar-sin-conexion-backend.js`:
  - copia temporal `envasadora_prueba_consumo_tmp`;
  - servidor en el puerto 3987;
  - borra la copia al final.

**Interfaces:**
- Consume `consumoValido` y `semanalDerivado` (Tarea 1).
- Produce:
  - las columnas de la sección 2.1 del spec;
  - `POST` y `PUT` de `/api/clientes` que aceptan `consumo_bidones` y `consumo_dias`.

- [ ] **Paso 1: escribir el script.** Antes de levantar el servidor, preparar la copia:
  - borrar las 6 columnas nuevas con `DROP COLUMN IF EXISTS`;
  - insertar un cliente con `consumo_semanal_estimado = 2`.

  Controles:
  - **Migración:** ese cliente queda en `{2, 7}` con `consumo_desde` en null.
  - **Altas:**
    - `POST { nombre, consumo_bidones: 1, consumo_dias: 30 }` → 201 y la fila queda en `{1, 30}` con semanal 1;
    - `POST { nombre, consumo_semanal_estimado: 3 }` → `{3, 7}`;
    - `POST { nombre }` → `{1, 7}`;
    - `POST { nombre, consumo_bidones: 0 }` → `{1, 7}`;
    - `POST { nombre, consumo_dias: 10 }` → 400.
  - **Edición que cambia el consumo:** cargar a mano en la base `consumo_ajustado_en` y los anteriores. Después,
    `PUT { consumo_bidones: 2, consumo_dias: 14 }` → `{2, 14}`, `consumo_desde` = hoy, `consumo_ajustado_en` y
    los anteriores en null, semanal 1.
  - **Ediciones parciales o sin cambio de consumo:**
    - `PUT { consumo_dias: 30 }` → `{2, 30}` (los bidones se toman del consumo actual);
    - `PUT { telefono: '123' }` → el consumo y `consumo_desde` no cambian;
    - con `consumo_desde` puesto a mano en hoy−5, `PUT { consumo_bidones: 2, consumo_dias: 30, telefono: '456' }`
      (mismo consumo) → `consumo_desde` sigue en hoy−5.
  - **App vieja:**
    - sobre un cliente `{1, 30}`, `PUT { nombre, telefono: '789', consumo_semanal_estimado: 1 }` → sigue en
      `{1, 30}`;
    - `PUT { consumo_semanal_estimado: 4 }` → `{4, 7}` y `consumo_desde` = hoy.
  - **Valores inválidos:** `PUT { consumo_bidones: 0 }` → 400; `PUT { consumo_dias: 5 }` → 400.
- [ ] **Paso 2:** correrlo con `node "<scratchpad>/probar-consumo-backend.js" "C:/Users/Usuario/EnvasadoraProyecto/envasadora-backend"`.
  Tiene que fallar, porque todavía no existen las columnas.
- [ ] **Paso 3:** agregar la migración, con el SQL tal cual figura en la sección 2.1 del spec.
- [ ] **Paso 4:** cambiar `POST /api/clientes` según la sección 2.3 del spec. El `INSERT` suma
  `consumo_bidones` y `consumo_dias`, y llena `consumo_semanal_estimado` con `semanalDerivado`.
- [ ] **Paso 5:** cambiar `PUT /api/clientes/:id` según la sección 2.3 del spec.
  - Si el cuerpo trae algún campo de consumo:
    - pedir una conexión con `pool.connect()` y abrir la transacción con `BEGIN`;
    - leer el cliente con `SELECT … FOR UPDATE … AND eliminado_en IS NULL`; si no existe, responder 404;
    - resolver el consumo en JS y sumar sus columnas al `sets` existente;
    - usar `rollbackSeguro` y liberar la conexión en el `finally`.
  - Si no trae ningún campo de consumo, queda la consulta única de hoy.
- [ ] **Paso 6:** correr `probar-consumo-backend.js` y `probar-sin-conexion-backend.js`. Tienen que terminar
  con TODO OK, y el segundo con 21 controles.

### Tarea 3: ajuste al registrar una entrega

**Archivos:**
- Modificar `envasadora-backend/index.js`, en `POST /api/entregas` (líneas ~487-571). El bloque nuevo va entre
  el `UPDATE` de la deuda (paso 4) y el `COMMIT` (paso 5).
- Modificar en el scratchpad: `probar-consumo-backend.js`, para sumar los controles del ajuste.

**Interfaces:**
- Consume `calcularAjuste` y `semanalDerivado` (Tarea 1) y las columnas (Tarea 2).

- [ ] **Paso 1: sumar controles al script.** Las fechas van en el campo `fecha` de cada entrega:
  - **Ajuste:**
    - cliente nuevo `{1, 7}` con entregas en hoy−12, hoy−8 y hoy−5 → sin cambios;
    - una cuarta entrega en hoy−1 → `{2, 7}`, `consumo_ajustado_en` = `consumo_desde` = hoy−1, anteriores
      `{1, 7}` y semanal 2.
  - **Reintento** de la cuarta entrega, con el mismo `id_local` → 200 con `repetida`, y los anteriores siguen
    en `{1, 7}`.
  - **"Volver a":** `PUT { consumo_bidones: 1, consumo_dias: 7 }` → `{1, 7}`, `consumo_ajustado_en` en null y
    `consumo_desde` = hoy.
  - **Entregas que llegan tarde:** tres entregas con fechas hoy−20, hoy−17 y hoy−14 → no hay ajuste, porque
    terminan antes de `consumo_desde`.
  - **Falla del ajuste:** poner `consumo_dias = 0` en la base y mandar un `POST /api/entregas` → 201; la
    entrega existe y la deuda se sumó.
- [ ] **Paso 2:** correr el script. Tienen que fallar los controles del ajuste.
- [ ] **Paso 3:** implementar el bloque de la sección 2.3 del spec.
  - Usar `SAVEPOINT ajuste_consumo`, `RELEASE` y `ROLLBACK TO SAVEPOINT` dentro de un try/catch propio.
  - Si algo falla, registrar `console.error('No se pudo calcular el ajuste del consumo:', err.message)`.
  - Leer las entregas con:
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, cantidad_bidones AS bidones FROM entregas WHERE cliente_id = $1 ORDER BY fecha DESC, id DESC LIMIT 60`.
- [ ] **Paso 4:** correr `probar-consumo-backend.js`, `probar-sin-conexion-backend.js` y `npm test`. Todo
  tiene que dar OK.

### Tarea 4: consumo con período en `lib/clientes.ts`

**Archivos:**
- Modificar `envasadora-frontend/lib/clientes.ts`: la interfaz `Cliente` (líneas 9-22) y `calcularEstado`
  (líneas 72-107).
- Crear en el scratchpad: `probar-consumo-lib.js`.

**Interfaces** (lo que produce):
- `Cliente` suma estos campos opcionales: `consumo_bidones?: number`, `consumo_dias?: number`,
  `consumo_ajustado_en?: string | null`, `consumo_anterior_bidones?: number | null` y
  `consumo_anterior_dias?: number | null`.
- `interface Consumo { bidones: number; dias: number }`.
- `PERIODOS: { dias: number; largo: string; corto: string }[]`, con los valores de las restricciones globales.
- `consumoDe(c: Pick<Cliente, 'consumo_semanal_estimado' | 'consumo_bidones' | 'consumo_dias'>): Consumo`:
  - usa los campos nuevos si los dos son > 0;
  - si no, devuelve `{ bidones: consumo_semanal_estimado > 0 ? consumo_semanal_estimado : 1, dias: 7 }`.
- `textoConsumo(consumo: Consumo, formato: 'largo' | 'corto'): string`:
  - "1 bidón por mes", "3 bidones por semana", "1/mes", "3/sem";
  - con un período que no está en `PERIODOS`: "2 bidones cada 10 días" / "2 c/10 d".
- `calcularEstado(cliente, bidonesUltimaEntrega?, ahora?)`: la misma salida que hoy, con
  `cliente: Pick<Cliente, 'fecha_ultima_entrega' | 'consumo_semanal_estimado' | 'consumo_bidones' | 'consumo_dias'>`.
  - La duración es igual a los bidones de la última entrega ÷ (bidones del consumo ÷ días del consumo).
  - Si no se sabe cuántos bidones se dejaron, se usan los del consumo.

- [ ] **Paso 1: escribir el script.**
  - Desde el frontend, compila con
    `npx tsc --module commonjs --target es2022 --skipLibCheck --outDir <scratchpad>/lib-compilado lib/clientes.ts lib/fechas.ts`.
  - Prueba con `node:assert/strict` y `ahora = new Date(2026, 9, 27)`.

  Controles:
  - **`consumoDe`:**
    - `{ consumo_semanal_estimado: 2 }` → `{2, 7}`;
    - con los campos nuevos en `{1, 30}` → `{1, 30}`;
    - con todos los campos en 0 → `{1, 7}`.
  - **`textoConsumo`:**
    - `{1,30}` largo → "1 bidón por mes";
    - `{3,7}` largo → "3 bidones por semana";
    - `{1,14}` corto → "1 c/2 sem";
    - `{3,7}` corto → "3/sem";
    - `{1,30}` corto → "1/mes";
    - `{2,10}` largo → "2 bidones cada 10 días".
  - **`calcularEstado`:**
    - María (`fecha_ultima_entrega: '2026-10-07'`, semanal 1, `{1, 30}`) con 1 bidón → `diasRestantes === 10`
      y `status !== 'urgent'`;
    - la misma María sin los campos nuevos → `diasRestantes === -13`;
    - con el consumo en 0 en todos los campos → `Number.isFinite(diasRestantes)`.
- [ ] **Paso 2:** correrlo. Tiene que fallar porque `consumoDe` no existe.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** correrlo. Tiene que dar OK.

### Tarea 5: campo de consumo en el alta y la edición, y la cola sin conexión

**Archivos:**
- Crear: `envasadora-frontend/components/CampoConsumo.tsx`.
- Modificar `app/page.tsx`:
  - `FORM_VACIO` (línea 28);
  - la columna de consumo de la fila (88-91);
  - `EntregaSheet` (111-112);
  - `handleCrearCliente` (302-317);
  - el formulario de alta (605-623).
- Modificar `app/cliente/page.tsx`:
  - el estado `editForm` (100-115);
  - la carga del formulario (176-182);
  - el guardado (212-213);
  - el campo del formulario (624-630).
- Modificar `lib/pendientes.ts`: `ClienteNuevo` (12-21) y `clienteDesdeAlta` (316-331).

**Interfaces:**
- Consume `PERIODOS`, `Consumo`, `consumoDe` y `textoConsumo` (Tarea 4).
- Produce:
  - `CampoConsumo({ value: { bidones: number | ''; dias: number }, onValueChange: (valor: { bidones: number | ''; dias: number }) => void, className?: string })`,
    que combina un `CampoNumero` con un `<select>` de `PERIODOS` en texto largo;
  - `ClienteNuevo` con `consumo_bidones?`, `consumo_dias?` y `consumo_semanal_estimado?`, todos opcionales
    porque la cola puede tener altas de la versión anterior.

- [ ] **Paso 1:** crear `CampoConsumo`.
- [ ] **Paso 2: alta.**
  - `FORM_VACIO` lleva `consumo_bidones: 1 as number | ''` y `consumo_dias: 7`, sin `consumo_semanal_estimado`.
  - La etiqueta es "Consumo" y el campo ocupa una fila entera, fuera de la grilla de dos columnas con
    Teléfono.
  - `handleCrearCliente` manda `consumo_bidones: addForm.consumo_bidones || 1` y `consumo_dias`.
- [ ] **Paso 3: Ruta.**
  - La columna de consumo muestra `textoConsumo(consumoDe(cliente), 'corto')`.
  - `EntregaSheet` usa `Math.max(1, consumoDe(cliente).bidones)` para la cantidad y para el monto.
- [ ] **Paso 4: edición.**
  - `editForm` lleva `consumo_bidones` y `consumo_dias`, que se cargan con `consumoDe(cliente)`.
  - El `PUT` manda `consumo_bidones: editForm.consumo_bidones || 1` y `consumo_dias`.
  - La etiqueta es "Consumo".
- [ ] **Paso 5: cola sin conexión.** `clienteDesdeAlta` arma el consumo con `consumoDe` (sirve también para las
  altas viejas) y llena `consumo_semanal_estimado` con el valor derivado.
- [ ] **Paso 6:** correr `npm run lint` y `npm run build` en el frontend. Tienen que terminar sin errores.

### Tarea 6: perfil con el consumo, el aviso del ajuste y "Volver a…"

**Archivos:**
- Modificar `app/cliente/page.tsx`:
  - el dato de consumo (línea 389);
  - un handler nuevo, junto a `handleGuardarEdicion` (~205-225).

**Interfaces:**
- Consume `consumoDe` y `textoConsumo` (Tarea 4), `fechaCorta` (`lib/fechas.ts`), `apiSend`,
  `MENSAJE_SIN_CONEXION` y `esLocal`.

- [ ] **Paso 1:** el dato del perfil pasa a tener la etiqueta "Consumo" y muestra
  `textoConsumo(consumoDe(cliente), 'largo')`.
- [ ] **Paso 2: aviso.** Se muestra debajo de los datos si `consumo_ajustado_en` tiene fecha, hay anteriores y
  el cliente no es local.
  - Texto: "Ajustado por la app el {fechaCorta(consumo_ajustado_en)} (antes: {textoConsumo(anterior, 'largo')})".
  - Botón: "Volver a {textoConsumo(anterior, 'largo')}".
- [ ] **Paso 3: el botón.**
  - Hace `apiSend(\`/clientes/${id}\`, 'PUT', { consumo_bidones, consumo_dias })` con el consumo anterior.
  - Si sale bien, actualiza el cliente igual que `handleGuardarEdicion`.
  - Si falla o no hay conexión, muestra `alert(MENSAJE_SIN_CONEXION)`.
- [ ] **Paso 4:** correr lint y build. Tienen que dar OK.

### Tarea 7: prueba completa en Chrome

**Archivos:** crear en el scratchpad `probar-consumo-e2e.js`, con la misma infraestructura que
`probar-sin-conexion-e2e.js`:
- backend en el puerto 3993, sobre una copia temporal de la base;
- Next en el 3456;
- Chrome con depuración en el 9334 y el perfil en una ruta corta (`%TEMP%\cpwNNNNN`), que se borra al final.

- [ ] **Paso 1:** compilar el frontend con `NEXT_PUBLIC_API_URL=http://localhost:3993/api npm run build`.
- [ ] **Paso 2: escribir y correr la prueba.** Controles:
  1. Alta de "María Test" desde el formulario con 1 "por mes" → en la base queda en `{1, 30}`.
  2. Entrega a María:
     - la cantidad que propone la app es 1;
     - pasar esa entrega a hace 20 días en la base (`entregas.fecha` y `clientes.fecha_ultima_entrega`);
     - recargar la Ruta → María no aparece en "Urgentes" y el `aria-label` de su barra contiene
       "Le quedan ~10 días".
  3. El perfil de María dice "1 bidón por mes".
  4. Ajuste de "Juan Test":
     - se crea con `{1, 7}` y se le cargan 4 entregas por la API (hoy−12, −8, −5 y −1);
     - su perfil muestra "Ajustado por la app", "(antes: 1 bidón por semana)" y "2 bidones por semana";
     - aparece el botón "Volver a 1 bidón por semana".
  5. Con el backend detenido, tocar "Volver a…" → aparece la alerta de conexión y en la base sigue `{2, 7}`.
  6. Con conexión, tocar "Volver a…" → el perfil muestra "1 bidón por semana" sin el aviso; en la base queda
     `{1, 7}` con `consumo_ajustado_en` en null.
  7. Alta sin conexión:
     - se carga "Ana Test" con 1 "cada 2 semanas";
     - aparece en la Ruta con la marca "Sin enviar";
     - al volver la conexión se envía y en la base queda en `{1, 14}`.
  8. Editar a María con el período "cada 3 semanas" → en la base queda en `{1, 21}` con `consumo_desde` = hoy.
- [ ] **Paso 3:** correr `probar-sin-conexion-e2e.js`. Tienen que dar OK los 29 controles.
- [ ] **Paso 4:** compilar normal (`npm run build` sin la variable) y confirmar que no quedaron perfiles de
  Chrome ni copias de la base.

### Tarea 8: publicación (solo cuando el usuario la pida)

- [ ] **Backend:**
  - agregar `consumo.js`, `test/consumo.test.js`, `package.json`, `index.js` y `docs/superpowers`, pero no
    `.vscode/`;
  - commit con un mensaje en español sin tildes que detalle los cambios, como los anteriores, terminado en
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - push.
- [ ] **Esperar al servidor:** `GET https://envasadora-mas.onrender.com/api/salud` tiene que responder
  `{"ok":true,"base":"lista"}`.
- [ ] **Frontend:** commit y push. Esperar a que GitHub marque `Vercel=success` en ese commit.
- [ ] **Avisar al usuario** que conviene corregir a mano los clientes que ya sabe que toman menos de 1 bidón
  por semana.
