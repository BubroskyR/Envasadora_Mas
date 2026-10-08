const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Render (y la mayoría de los hostings) ponen un proxy delante: esto hace que req.ip sea la IP real del usuario
app.set('trust proxy', 1);

// ---------- Configuración ----------

// Contraseña para entrar a la app. Se configura en las variables de entorno de Render, nunca en el código.
const APP_PASSWORD = process.env.APP_PASSWORD;
// Clave para firmar los tokens. Si no se define, se usa la contraseña (cambiarla cierra todas las sesiones).
const TOKEN_SECRET = process.env.TOKEN_SECRET || APP_PASSWORD;
const DURACION_TOKEN_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// Orígenes (sitios web) que pueden usar la API. Separados por coma.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://envasadora-frontend.vercel.app,http://localhost:3000')
  .split(',')
  .map(origen => origen.trim())
  .filter(Boolean);

// Zona horaria del negocio: define qué es "hoy" (CURRENT_DATE) y "este mes" en las consultas.
const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Argentina/Buenos_Aires';

if (!APP_PASSWORD) {
  console.warn('⚠️  Falta la variable APP_PASSWORD: la API va a rechazar todas las peticiones hasta que se configure.');
}

// Middlewares
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json()); // Permite recibir datos en formato JSON
// Si la petición no trae JSON, req.body queda undefined; lo normalizamos para no tener que chequearlo en cada ruta
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  // Cada conexión usa la hora de Argentina. Sin esto, en un servidor en UTC (como Render)
  // una entrega registrada después de las 21 hs quedaba guardada con la fecha del día siguiente.
  options: `-c TimeZone=${ZONA_HORARIA}`
});

// Si una conexión inactiva del pool falla (ej. la base se reinicia), lo registramos
// en lugar de dejar que el error tire abajo todo el servidor.
pool.on('error', (err) => {
  console.error('❌ Error inesperado en una conexión inactiva de PostgreSQL', err.message);
});

// Ajustes de la base que la app necesita. Todo es idempotente (IF NOT EXISTS),
// así que se puede ejecutar en cada arranque sin riesgo.
const prepararBaseDeDatos = async () => {
  await pool.query(`
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS barrio VARCHAR(100);
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS latitud NUMERIC;
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS longitud NUMERIC;
    -- Borrado lógico: al eliminar un cliente se marca la fecha en vez de borrar la fila,
    -- así sus entregas y pagos siguen contando en el historial de finanzas
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ;

    -- Índices para que las búsquedas por cliente y por fecha no recorran la tabla entera
    CREATE INDEX IF NOT EXISTS idx_entregas_cliente_fecha ON entregas (cliente_id, fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_entregas_fecha ON entregas (fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_pagos_cliente ON pagos (cliente_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos (fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos (fecha DESC);

    -- creado_en era "timestamp sin zona": guardaba la hora en la zona de cada conexión, así que los
    -- registros viejos (en UTC) y los nuevos (hora argentina) no se podían comparar y el historial
    -- de finanzas quedaba desordenado. Con timestamptz se guarda el instante exacto.
    -- Los valores existentes se toman como UTC, que es como los guardaba el servidor antes del ajuste de zona.
    DO $$
    DECLARE tabla TEXT;
    BEGIN
      FOREACH tabla IN ARRAY ARRAY['entregas', 'pagos', 'gastos'] LOOP
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = tabla AND column_name = 'creado_en' AND data_type = 'timestamp without time zone'
        ) THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN creado_en TYPE TIMESTAMPTZ USING creado_en AT TIME ZONE ''UTC'',
                            ALTER COLUMN creado_en SET DEFAULT now()', tabla);
        END IF;
      END LOOP;
    END $$;
  `);
};

prepararBaseDeDatos()
  .then(() => console.log('✅ Conectado exitosamente a PostgreSQL (estructura verificada)'))
  .catch(err => console.error('❌ Error al conectar o preparar la base de datos', err.stack));

// ---------- Helpers ----------

// Los formularios mandan "" cuando un campo queda vacío; para la base eso es NULL.
const vacioANull = (valor) => (valor === undefined || valor === null || valor === '' ? null : valor);

// Convierte a número; devuelve null si no es un número válido.
const aNumero = (valor) => {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
};

// Los IDs son enteros positivos. Validarlos evita que Postgres tire un error 500 con "/api/clientes/abc".
const esIdValido = (id) => /^\d+$/.test(String(id));

// Hace ROLLBACK sin que un fallo del propio ROLLBACK (ej. conexión caída) tape el error original.
const rollbackSeguro = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch (err) {
    console.error('Error al hacer ROLLBACK:', err.message);
  }
};

// ---------- Autenticación ----------

const base64url = (texto) => Buffer.from(texto).toString('base64url');
const firmar = (datos) => crypto.createHmac('sha256', TOKEN_SECRET).update(datos).digest('base64url');

// Compara dos textos en tiempo constante (evita adivinar la contraseña midiendo cuánto tarda la respuesta)
const sonIguales = (a, b) => {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

// Token = datos.firma. Solo el servidor conoce TOKEN_SECRET, así que nadie puede fabricar uno válido.
const crearToken = () => {
  const datos = base64url(JSON.stringify({ exp: Date.now() + DURACION_TOKEN_MS }));
  return `${datos}.${firmar(datos)}`;
};

const tokenEsValido = (token) => {
  const [datos, firma] = String(token).split('.');
  if (!datos || !firma || !sonIguales(firma, firmar(datos))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(datos, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
};

// Límite de intentos de login por IP, para que no se pueda probar contraseñas por fuerza bruta
const MAX_INTENTOS = 5;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const intentosPorIp = new Map();

const registrarIntentoFallido = (ip) => {
  const ahora = Date.now();
  const registro = intentosPorIp.get(ip);
  if (!registro || registro.reinicio < ahora) {
    intentosPorIp.set(ip, { cantidad: 1, reinicio: ahora + VENTANA_INTENTOS_MS });
  } else {
    registro.cantidad++;
  }
};

const estaBloqueada = (ip) => {
  const registro = intentosPorIp.get(ip);
  if (!registro) return false;
  if (registro.reinicio < Date.now()) {
    intentosPorIp.delete(ip);
    return false;
  }
  return registro.cantidad >= MAX_INTENTOS;
};

// Ruta POST: Iniciar sesión con la contraseña de la app y recibir un token
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) {
    return res.status(503).json({ error: 'El servidor no tiene configurada la contraseña (APP_PASSWORD)' });
  }
  if (estaBloqueada(req.ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  }

  const { password } = req.body;
  if (!password || !sonIguales(password, APP_PASSWORD)) {
    registrarIntentoFallido(req.ip);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  intentosPorIp.delete(req.ip);
  res.json({ token: crearToken(), expira_en_dias: DURACION_TOKEN_MS / (24 * 60 * 60 * 1000) });
});

// Todas las rutas /api definidas DESPUÉS de este middleware requieren un token válido
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) {
    return res.status(503).json({ error: 'El servidor no tiene configurada la contraseña (APP_PASSWORD)' });
  }
  const [tipo, token] = (req.get('Authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !token || !tokenEsValido(token)) {
    return res.status(401).json({ error: 'Sesión inválida o vencida. Volvé a iniciar sesión.' });
  }
  next();
});

// ---------- Clientes ----------

// Ruta GET: Obtener todos los clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes WHERE eliminado_en IS NULL ORDER BY deuda_actual DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor');
  }
});

// Ruta POST: Crear un nuevo cliente (incluye barrio y ubicación GPS)
app.post('/api/clientes', async (req, res) => {
  try {
    // 1. Extraemos los datos que nos envía el frontend
    const { nombre, direccion, telefono, consumo_semanal_estimado, barrio, latitud, longitud } = req.body;

    // 2. Validación básica: asegurarnos de que al menos envíen el nombre
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
    }

    // 3. Consulta SQL parametrizada (Los $1, $2 evitan hackeos por inyección SQL)
    // RETURNING * le dice a Postgres que nos devuelva toda la fila recién creada
    const query = `
      INSERT INTO clientes (nombre, direccion, telefono, consumo_semanal_estimado, barrio, latitud, longitud)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    // Si no envían consumo estimado, por defecto será 1 (la columna es entera)
    const consumo = aNumero(consumo_semanal_estimado);
    const values = [
      String(nombre).trim(),
      vacioANull(direccion),
      vacioANull(telefono),
      consumo && consumo > 0 ? Math.round(consumo) : 1,
      vacioANull(barrio),
      aNumero(latitud),
      aNumero(longitud)
    ];

    // 4. Ejecutamos la consulta en la base de datos
    const result = await pool.query(query, values);

    // 5. Respondemos con el cliente creado y un código 201 (Created)
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor al crear el cliente');
  }
});

// Ruta GET: Obtener un cliente específico por su ID
app.get('/api/clientes/:id', async (req, res) => {
  const { id } = req.params;
  if (!esIdValido(id)) {
    return res.status(404).json({ error: 'Cliente no encontrado' });
  }

  try {
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1 AND eliminado_en IS NULL', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el cliente');
  }
});

// Ruta GET: Obtener el historial de entregas de un cliente específico
app.get('/api/clientes/:id/entregas', async (req, res) => {
  const { id } = req.params;
  if (!esIdValido(id)) {
    return res.json([]);
  }

  try {
    // Buscamos las entregas y las ordenamos desde la más reciente a la más antigua
    const result = await pool.query(
      'SELECT * FROM entregas WHERE cliente_id = $1 ORDER BY fecha DESC, id DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de entregas');
  }
});

// Ruta GET: Obtener los pagos de deuda de un cliente (para mostrarlos en su historial junto a las entregas)
app.get('/api/clientes/:id/pagos', async (req, res) => {
  const { id } = req.params;
  if (!esIdValido(id)) {
    return res.json([]);
  }

  try {
    // Si algún pago viejo quedó sin fecha, se usa el día en que se registró
    const result = await pool.query(
      `SELECT id, cliente_id, COALESCE(fecha, creado_en::date) AS fecha, monto, metodo_pago, creado_en
       FROM pagos
       WHERE cliente_id = $1
       ORDER BY COALESCE(fecha, creado_en::date) DESC, creado_en DESC, id DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de pagos');
  }
});

// Ruta PUT: Actualizar los datos de un cliente existente.
// Solo se modifican los campos que vienen en el body: si un campo no se envía, conserva su valor;
// si se envía vacío (""), se borra. Así se puede, por ejemplo, quitarle el teléfono a un cliente.
app.put('/api/clientes/:id', async (req, res) => {
  const { id } = req.params;
  if (!esIdValido(id)) {
    return res.status(404).json({ error: 'Cliente no encontrado' });
  }

  const body = req.body;
  const sets = [];
  const values = [];
  const agregar = (columna, valor) => {
    values.push(valor);
    sets.push(`${columna} = $${values.length}`);
  };

  if ('nombre' in body) {
    const nombre = String(body.nombre ?? '').trim();
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre del cliente no puede quedar vacío' });
    }
    agregar('nombre', nombre);
  }

  for (const columna of ['direccion', 'telefono', 'barrio']) {
    if (columna in body) agregar(columna, vacioANull(body[columna]));
  }

  for (const columna of ['latitud', 'longitud']) {
    if (!(columna in body)) continue;
    const valor = vacioANull(body[columna]);
    const numero = aNumero(valor);
    if (valor !== null && numero === null) {
      return res.status(400).json({ error: `La ${columna} no es un número válido` });
    }
    agregar(columna, numero);
  }

  if ('consumo_semanal_estimado' in body) {
    const consumo = aNumero(body.consumo_semanal_estimado);
    if (!consumo || consumo <= 0) {
      return res.status(400).json({ error: 'El consumo semanal debe ser mayor a 0' });
    }
    agregar('consumo_semanal_estimado', Math.round(consumo));
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'No se enviaron datos para actualizar' });
  }

  try {
    // Los nombres de columna salen de la lista fija de arriba (nunca del usuario), y los valores van parametrizados
    values.push(id);
    const result = await pool.query(
      `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${values.length} AND eliminado_en IS NULL RETURNING *;`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente actualizado', cliente: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al actualizar el cliente');
  }
});

// Ruta DELETE: Eliminar un cliente.
// No se borra la fila: se marca eliminado_en y deja de aparecer en la app. Sus entregas y pagos se conservan
// porque son plata que realmente entró o se fió ese mes; si se borraran, cambiarían los totales de meses pasados.
app.delete('/api/clientes/:id', async (req, res) => {
  const { id } = req.params;
  if (!esIdValido(id)) {
    return res.status(404).json({ error: 'Cliente no encontrado' });
  }

  try {
    const result = await pool.query(
      'UPDATE clientes SET eliminado_en = now() WHERE id = $1 AND eliminado_en IS NULL RETURNING *;',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente eliminado correctamente', cliente: result.rows[0] });
  } catch (err) {
    console.error('Error al eliminar el cliente:', err.message);
    res.status(500).send('Error en el servidor al eliminar el cliente');
  }
});

// ---------- Entregas ----------

// Ruta POST: Registrar una entrega y actualizar el cliente
app.post('/api/entregas', async (req, res) => {
  const { cliente_id, cantidad_bidones } = req.body;
  const cantidad = aNumero(cantidad_bidones);
  const montoTotal = aNumero(req.body.monto_total) ?? 0;
  const montoPagado = aNumero(req.body.monto_pagado) ?? 0;

  // Validamos ANTES de pedir una conexión, así no ocupamos una del pool por nada
  if (!esIdValido(cliente_id) || !Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (cliente_id, cantidad_bidones)' });
  }
  if (montoTotal < 0 || montoPagado < 0) {
    return res.status(400).json({ error: 'Los montos no pueden ser negativos' });
  }

  // Lo que no se pagó queda como deuda. Si paga de más, la diferencia (negativa) reduce su deuda.
  const montoAdeudado = montoTotal - montoPagado;

  // Pedimos un "cliente" temporal a la base de datos para manejar la transacción
  const client = await pool.connect();

  try {
    // 1. Iniciamos la transacción
    await client.query('BEGIN');

    // 2. Actualizamos al cliente: Sumamos la nueva deuda y actualizamos su última entrega.
    // Lo hacemos primero para saber si el cliente existe antes de insertar nada.
    const updateClienteQuery = `
      UPDATE clientes
      SET deuda_actual = deuda_actual + $1,
          fecha_ultima_entrega = CURRENT_DATE
      WHERE id = $2 AND eliminado_en IS NULL;
    `;
    const resultadoCliente = await client.query(updateClienteQuery, [montoAdeudado, cliente_id]);

    if (resultadoCliente.rowCount === 0) {
      await rollbackSeguro(client);
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // 3. Insertamos la nueva entrega en el historial (usamos CURRENT_DATE para la fecha de hoy)
    const insertEntregaQuery = `
      INSERT INTO entregas (cliente_id, fecha, cantidad_bidones, monto_pagado, monto_adeudado)
      VALUES ($1, CURRENT_DATE, $2, $3, $4)
      RETURNING *;
    `;
    const resultadoEntrega = await client.query(insertEntregaQuery, [cliente_id, cantidad, montoPagado, montoAdeudado]);

    // 4. Confirmamos que todo salió bien y guardamos los cambios
    await client.query('COMMIT');

    // Devolvemos los datos de la entrega recién creada
    res.status(201).json({
      mensaje: 'Entrega registrada correctamente',
      entrega: resultadoEntrega.rows[0]
    });

  } catch (err) {
    // Si hay CUALQUIER error, deshacemos todos los cambios
    await rollbackSeguro(client);
    console.error('Error en la transacción:', err.message);
    res.status(500).json({ error: 'Error al registrar la entrega' });
  } finally {
    // Siempre liberamos la conexión al terminar
    client.release();
  }
});

// Ruta GET: Obtener todas las entregas generales
app.get('/api/entregas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, c.nombre as cliente_nombre
      FROM entregas e
      LEFT JOIN clientes c ON e.cliente_id = c.id
      ORDER BY e.fecha DESC, e.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener entregas');
  }
});

// Ruta GET: Última entrega de cada cliente (para calcular el nivel de agua en Ruta y Mapa).
// Devuelve una fila por cliente en lugar de todo el historial; si hubo varias entregas
// ese mismo día, se suman los bidones.
app.get('/api/entregas/ultimas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cliente_id, to_char(fecha, 'YYYY-MM-DD') AS fecha, SUM(cantidad_bidones)::int AS cantidad_bidones
      FROM (
        SELECT cliente_id, fecha, cantidad_bidones,
               MAX(fecha) OVER (PARTITION BY cliente_id) AS ultima_fecha
        FROM entregas
      ) t
      WHERE fecha = ultima_fecha
      GROUP BY cliente_id, fecha
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener las últimas entregas');
  }
});

// ---------- Pagos ----------

// Ruta POST: Registrar un pago y guardar el historial (con Transacción)
app.post('/api/pagos', async (req, res) => {
  const { cliente_id, metodo_pago } = req.body;
  const montoPago = aNumero(req.body.monto_pago);

  if (!esIdValido(cliente_id) || !montoPago || montoPago <= 0) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (cliente_id, monto_pago)' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Iniciamos la transacción

    // 1. Descontar la deuda del perfil del cliente (y de paso verificar que exista)
    const updateClienteQuery = `
      UPDATE clientes
      SET deuda_actual = deuda_actual - $1
      WHERE id = $2 AND eliminado_en IS NULL
      RETURNING *;
    `;
    const resultadoCliente = await client.query(updateClienteQuery, [montoPago, cliente_id]);

    if (resultadoCliente.rows.length === 0) {
      await rollbackSeguro(client);
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // 2. Guardar el registro en el historial de pagos
    const insertPagoQuery = `
      INSERT INTO pagos (cliente_id, monto, metodo_pago)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const resultadoPago = await client.query(insertPagoQuery, [cliente_id, montoPago, metodo_pago || 'Efectivo']);

    await client.query('COMMIT'); // Confirmamos los cambios

    res.status(201).json({
      mensaje: 'Pago registrado exitosamente en el historial y deuda actualizada',
      pago_registrado: resultadoPago.rows[0],
      cliente_actualizado: resultadoCliente.rows[0]
    });

  } catch (err) {
    await rollbackSeguro(client); // Deshacemos todo si hay error
    console.error('Error en la transacción de pago:', err.message);
    res.status(500).json({ error: 'Error al procesar el pago' });
  } finally {
    client.release();
  }
});

// Ruta GET: Obtener todos los pagos
app.get('/api/pagos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, c.nombre as cliente_nombre
      FROM pagos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ORDER BY p.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener pagos');
  }
});

// ---------- Gastos ----------

// Ruta POST: Registrar un nuevo gasto
app.post('/api/gastos', async (req, res) => {
  try {
    // 1. Extraemos los datos que envías desde la app
    const { categoria, descripcion } = req.body;
    const monto = aNumero(req.body.monto);

    // 2. Validación: Asegurarnos de que envíen categoría y un monto positivo
    if (!categoria || !monto || monto <= 0) {
      return res.status(400).json({ error: 'La categoría y el monto son obligatorios' });
    }

    // 3. Consulta SQL: Insertamos el gasto (usamos CURRENT_DATE para la fecha de hoy)
    const query = `
      INSERT INTO gastos (fecha, categoria, monto, descripcion)
      VALUES (CURRENT_DATE, $1, $2, $3)
      RETURNING *;
    `;

    // Si no hay descripción, mandamos un texto vacío
    const values = [categoria, monto, descripcion || ''];

    // 4. Ejecutamos la consulta
    const result = await pool.query(query, values);

    // 5. Respondemos con éxito
    res.status(201).json({
      mensaje: 'Gasto registrado correctamente',
      gasto: result.rows[0]
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor al registrar el gasto');
  }
});

// Ruta GET: Obtener todos los gastos
app.get('/api/gastos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gastos ORDER BY fecha DESC, id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener los gastos');
  }
});

// ---------- Finanzas ----------

// Ruta GET: Resumen financiero ya calculado por la base de datos.
// Antes el frontend descargaba TODOS los clientes, entregas, pagos y gastos para sumarlos;
// ahora recibe solo los totales, los 6 meses del gráfico y los últimos 10 movimientos.
app.get('/api/finanzas/resumen', async (req, res) => {
  try {
    const [metricas, grafico, movimientos] = await Promise.all([
      pool.query(`
        WITH mes AS (SELECT date_trunc('month', CURRENT_DATE)::date AS inicio)
        SELECT
          (SELECT COUNT(*)::int FROM clientes WHERE eliminado_en IS NULL) AS clientes_activos,
          (SELECT COUNT(*)::int FROM clientes WHERE eliminado_en IS NULL AND deuda_actual > 0) AS clientes_con_deuda,
          (SELECT COALESCE(SUM(deuda_actual), 0) FROM clientes WHERE eliminado_en IS NULL) AS dinero_en_la_calle,
          (SELECT COALESCE(SUM(monto), 0) FROM gastos, mes
            WHERE fecha >= mes.inicio AND fecha < mes.inicio + INTERVAL '1 month') AS gastos_del_mes
      `),
      // Ingresos (lo cobrado en entregas + pagos de deuda) de los últimos 6 meses, incluido el actual
      pool.query(`
        WITH meses AS (
          SELECT generate_series(
            date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
            date_trunc('month', CURRENT_DATE),
            INTERVAL '1 month'
          )::date AS mes
        ),
        ingresos AS (
          SELECT date_trunc('month', fecha)::date AS mes, monto_pagado AS monto
          FROM entregas
          WHERE fecha >= (SELECT MIN(mes) FROM meses)
          UNION ALL
          SELECT date_trunc('month', COALESCE(fecha, creado_en::date))::date, monto
          FROM pagos
          WHERE COALESCE(fecha, creado_en::date) >= (SELECT MIN(mes) FROM meses)
        )
        SELECT to_char(m.mes, 'YYYY-MM-DD') AS mes, COALESCE(SUM(i.monto), 0) AS ingresos
        FROM meses m
        LEFT JOIN ingresos i ON i.mes = m.mes
        GROUP BY m.mes
        ORDER BY m.mes
      `),
      // Cada parte se limita a 10 antes de unirlas, así no se recorre todo el historial
      pool.query(`
        SELECT * FROM (
          (SELECT 'g-' || id AS id, 'gasto' AS tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, creado_en,
                  monto, categoria, descripcion, NULL AS cliente_nombre
           FROM gastos
           ORDER BY fecha DESC, creado_en DESC LIMIT 10)
          UNION ALL
          (SELECT 'e-' || e.id, 'venta', to_char(e.fecha, 'YYYY-MM-DD'), e.creado_en,
                  e.monto_pagado, NULL, NULL, c.nombre
           FROM entregas e LEFT JOIN clientes c ON c.id = e.cliente_id
           WHERE e.monto_pagado > 0
           ORDER BY e.fecha DESC, e.creado_en DESC LIMIT 10)
          UNION ALL
          (SELECT 'p-' || p.id, 'cobro', to_char(COALESCE(p.fecha, p.creado_en::date), 'YYYY-MM-DD'), p.creado_en,
                  p.monto, NULL, NULL, c.nombre
           FROM pagos p LEFT JOIN clientes c ON c.id = p.cliente_id
           ORDER BY COALESCE(p.fecha, p.creado_en::date) DESC, p.creado_en DESC LIMIT 10)
        ) m
        ORDER BY fecha DESC, creado_en DESC NULLS LAST
        LIMIT 10
      `)
    ]);

    const filasGrafico = grafico.rows;
    res.json({
      ...metricas.rows[0],
      // El último mes del gráfico es el mes actual
      ingresos_del_mes: filasGrafico.length ? filasGrafico[filasGrafico.length - 1].ingresos : '0',
      grafico: filasGrafico,
      movimientos: movimientos.rows.map(({ creado_en, ...movimiento }) => movimiento)
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el resumen financiero');
  }
});

// ---------- Historial mensual de finanzas ----------
// Cada pantalla de detalle recibe ?mes=AAAA-MM (o nada, para el mes actual) y devuelve:
//   - meses: el resumen de todos los meses, desde el primero con datos hasta el actual
//   - el detalle completo del mes pedido
// Todo se calcula a partir de las entregas, pagos, gastos y clientes guardados, así que el historial
// existe desde el primer registro y no hace falta "cerrar" los meses a mano.

const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

// Primer día del mes pedido, o del mes actual según la zona horaria del negocio
const inicioDelMes = async (mes) => {
  if (typeof mes === 'string' && MES_VALIDO.test(mes)) return `${mes}-01`;
  const { rows } = await pool.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS inicio`);
  return rows[0].inicio;
};

// Todos los meses desde el primer dato cargado hasta el actual (incluye meses sin movimientos)
const SQL_MESES = `
  meses AS (
    SELECT generate_series(
      date_trunc('month', LEAST(
        (SELECT MIN(fecha) FROM entregas),
        (SELECT MIN(COALESCE(fecha, creado_en::date)) FROM pagos),
        (SELECT MIN(fecha) FROM gastos),
        (SELECT MIN(creado_en)::date FROM clientes),
        CURRENT_DATE
      )),
      date_trunc('month', CURRENT_DATE),
      INTERVAL '1 month'
    )::date AS mes
  )`;

// Movimientos que cambian la deuda de cada cliente: lo que quedó debiendo en cada entrega (+) y cada pago (-).
// "inicial" es la deuda que no se explica con esos movimientos (por ejemplo, cargada a mano al crear el cliente);
// se toma como existente desde el alta, así el saldo del mes actual coincide con deuda_actual.
const SQL_DEUDA = `
  mov AS (
    SELECT cliente_id, fecha, COALESCE(monto_adeudado, 0) AS delta FROM entregas
    UNION ALL
    SELECT cliente_id, COALESCE(fecha, creado_en::date), -monto FROM pagos
  ),
  base AS (
    SELECT c.id, c.nombre, c.creado_en, c.eliminado_en,
           COALESCE(c.deuda_actual, 0) - COALESCE((SELECT SUM(delta) FROM mov WHERE mov.cliente_id = c.id), 0) AS inicial
    FROM clientes c
  )`;

// Un cliente cuenta en un mes si ya estaba dado de alta y todavía no se había eliminado al cerrar ese mes
const activoAlCierre = (alias, fin) =>
  `(${alias}.creado_en IS NULL OR ${alias}.creado_en < ${fin}) AND (${alias}.eliminado_en IS NULL OR ${alias}.eliminado_en >= ${fin})`;

const sinCreadoEn = (filas) => filas.map(({ creado_en, ...fila }) => fila);

// Ruta GET: Ingresos por mes (ventas cobradas al entregar + cobros de deuda) y el detalle de un mes
app.get('/api/finanzas/ingresos', async (req, res) => {
  try {
    const inicio = await inicioDelMes(req.query.mes);
    const [meses, movimientos] = await Promise.all([
      pool.query(`
        WITH ${SQL_MESES},
        ingresos AS (
          SELECT date_trunc('month', fecha)::date AS mes, COALESCE(monto_pagado, 0) AS ventas, 0 AS cobros FROM entregas
          UNION ALL
          SELECT date_trunc('month', COALESCE(fecha, creado_en::date))::date, 0, monto FROM pagos
        )
        SELECT to_char(m.mes, 'YYYY-MM') AS mes,
               COALESCE(SUM(i.ventas), 0) AS ventas,
               COALESCE(SUM(i.cobros), 0) AS cobros,
               COALESCE(SUM(i.ventas + i.cobros), 0) AS total
        FROM meses m
        LEFT JOIN ingresos i ON i.mes = m.mes
        GROUP BY m.mes
        ORDER BY m.mes DESC
      `),
      pool.query(`
        SELECT * FROM (
          SELECT 'venta' AS tipo, e.id, to_char(e.fecha, 'YYYY-MM-DD') AS fecha, e.creado_en,
                 e.monto_pagado AS monto, e.cantidad_bidones, e.cliente_id,
                 c.nombre AS cliente_nombre, c.eliminado_en IS NOT NULL AS cliente_eliminado
          FROM entregas e LEFT JOIN clientes c ON c.id = e.cliente_id
          WHERE e.monto_pagado > 0 AND e.fecha >= $1::date AND e.fecha < $1::date + INTERVAL '1 month'
          UNION ALL
          SELECT 'cobro', p.id, to_char(COALESCE(p.fecha, p.creado_en::date), 'YYYY-MM-DD'), p.creado_en,
                 p.monto, NULL, p.cliente_id, c.nombre, c.eliminado_en IS NOT NULL
          FROM pagos p LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE COALESCE(p.fecha, p.creado_en::date) >= $1::date
            AND COALESCE(p.fecha, p.creado_en::date) < $1::date + INTERVAL '1 month'
        ) m
        ORDER BY fecha DESC, creado_en DESC NULLS LAST
      `, [inicio])
    ]);

    res.json({ mes: inicio.slice(0, 7), meses: meses.rows, movimientos: sinCreadoEn(movimientos.rows) });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de ingresos');
  }
});

// Ruta GET: Gastos por mes, por categoría y el detalle de un mes
app.get('/api/finanzas/gastos', async (req, res) => {
  try {
    const inicio = await inicioDelMes(req.query.mes);
    const delMes = `fecha >= $1::date AND fecha < $1::date + INTERVAL '1 month'`;
    const [meses, categorias, gastos] = await Promise.all([
      pool.query(`
        WITH ${SQL_MESES}
        SELECT to_char(m.mes, 'YYYY-MM') AS mes, COALESCE(SUM(g.monto), 0) AS total, COUNT(g.id)::int AS cantidad
        FROM meses m
        LEFT JOIN gastos g ON date_trunc('month', g.fecha)::date = m.mes
        GROUP BY m.mes
        ORDER BY m.mes DESC
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(categoria, ''), 'Varios') AS categoria, SUM(monto) AS total, COUNT(*)::int AS cantidad
        FROM gastos
        WHERE ${delMes}
        GROUP BY 1
        ORDER BY total DESC
      `, [inicio]),
      pool.query(`
        SELECT id, to_char(fecha, 'YYYY-MM-DD') AS fecha, categoria, descripcion, monto
        FROM gastos
        WHERE ${delMes}
        ORDER BY fecha DESC, creado_en DESC, id DESC
      `, [inicio])
    ]);

    res.json({ mes: inicio.slice(0, 7), meses: meses.rows, categorias: categorias.rows, gastos: gastos.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de gastos');
  }
});

// Ruta GET: Dinero en la calle por mes (saldo al cierre, lo fiado y lo cobrado) y el detalle de un mes
app.get('/api/finanzas/deuda', async (req, res) => {
  try {
    const inicio = await inicioDelMes(req.query.mes);
    const finMes = `$1::date + INTERVAL '1 month'`;
    const [meses, deudores, movimientos] = await Promise.all([
      pool.query(`
        WITH ${SQL_MESES}, ${SQL_DEUDA},
        entregas_mes AS (
          SELECT date_trunc('month', fecha)::date AS mes,
                 SUM(GREATEST(COALESCE(monto_adeudado, 0), 0)) AS fiado,
                 -- Si en una entrega pagó de más, ese excedente se descontó de su deuda: cuenta como cobro
                 SUM(GREATEST(-COALESCE(monto_adeudado, 0), 0)) AS cobrado_en_entregas
          FROM entregas GROUP BY 1
        ),
        pagos_mes AS (
          SELECT date_trunc('month', COALESCE(fecha, creado_en::date))::date AS mes, SUM(monto) AS cobrado
          FROM pagos GROUP BY 1
        ),
        -- Deuda que dejaron de contar los clientes eliminados ese mes (su deuda_actual queda congelada al eliminarlos).
        -- Explica por qué el saldo baja sin que se haya cobrado: saldo anterior + fiado - cobrado - esto = saldo al cierre
        bajas_mes AS (
          SELECT date_trunc('month', eliminado_en)::date AS mes, SUM(COALESCE(deuda_actual, 0)) AS deuda_eliminada
          FROM clientes WHERE eliminado_en IS NOT NULL GROUP BY 1
        )
        SELECT to_char(m.mes, 'YYYY-MM') AS mes,
               COALESCE(em.fiado, 0) AS fiado,
               COALESCE(pm.cobrado, 0) + COALESCE(em.cobrado_en_entregas, 0) AS cobrado,
               COALESCE(bm.deuda_eliminada, 0) AS deuda_eliminada,
               (SELECT COALESCE(SUM(b.inicial + COALESCE((
                         SELECT SUM(mv.delta) FROM mov mv
                         WHERE mv.cliente_id = b.id AND mv.fecha < m.mes + INTERVAL '1 month'), 0)), 0)
                FROM base b
                WHERE ${activoAlCierre('b', "m.mes + INTERVAL '1 month'")}) AS saldo_cierre
        FROM meses m
        LEFT JOIN entregas_mes em ON em.mes = m.mes
        LEFT JOIN pagos_mes pm ON pm.mes = m.mes
        LEFT JOIN bajas_mes bm ON bm.mes = m.mes
        ORDER BY m.mes DESC
      `),
      // Quiénes debían (y cuánto) al cerrar el mes pedido
      pool.query(`
        WITH ${SQL_DEUDA}
        SELECT * FROM (
          SELECT b.id, b.nombre, b.eliminado_en IS NOT NULL AS eliminado,
                 b.inicial + COALESCE((SELECT SUM(mv.delta) FROM mov mv
                                       WHERE mv.cliente_id = b.id AND mv.fecha < ${finMes}), 0) AS saldo
          FROM base b
          WHERE ${activoAlCierre('b', finMes)}
        ) d
        WHERE saldo > 0
        ORDER BY saldo DESC, nombre
      `, [inicio]),
      pool.query(`
        SELECT * FROM (
          SELECT CASE WHEN e.monto_adeudado > 0 THEN 'fiado' ELSE 'pago_de_mas' END AS tipo,
                 e.id, to_char(e.fecha, 'YYYY-MM-DD') AS fecha, e.creado_en,
                 ABS(e.monto_adeudado) AS monto, e.cantidad_bidones, e.cliente_id,
                 c.nombre AS cliente_nombre, c.eliminado_en IS NOT NULL AS cliente_eliminado
          FROM entregas e LEFT JOIN clientes c ON c.id = e.cliente_id
          WHERE e.monto_adeudado <> 0 AND e.fecha >= $1::date AND e.fecha < ${finMes}
          UNION ALL
          SELECT 'cobro', p.id, to_char(COALESCE(p.fecha, p.creado_en::date), 'YYYY-MM-DD'), p.creado_en,
                 p.monto, NULL, p.cliente_id, c.nombre, c.eliminado_en IS NOT NULL
          FROM pagos p LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE COALESCE(p.fecha, p.creado_en::date) >= $1::date
            AND COALESCE(p.fecha, p.creado_en::date) < ${finMes}
        ) m
        ORDER BY fecha DESC, creado_en DESC NULLS LAST
      `, [inicio])
    ]);

    res.json({
      mes: inicio.slice(0, 7),
      meses: meses.rows,
      deudores: deudores.rows,
      movimientos: sinCreadoEn(movimientos.rows)
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de deuda');
  }
});

// Ruta GET: Clientes por mes (activos, altas, bajas, atendidos, bidones) y el detalle de un mes
app.get('/api/finanzas/clientes', async (req, res) => {
  try {
    const inicio = await inicioDelMes(req.query.mes);
    const enElMes = (fecha) => `${fecha} >= m.mes AND ${fecha} < m.mes + INTERVAL '1 month'`;
    const [meses, atendidos, altas, bajas] = await Promise.all([
      pool.query(`
        WITH ${SQL_MESES}
        SELECT to_char(m.mes, 'YYYY-MM') AS mes,
               (SELECT COUNT(*)::int FROM clientes c WHERE ${activoAlCierre('c', "m.mes + INTERVAL '1 month'")}) AS activos,
               (SELECT COUNT(*)::int FROM clientes c WHERE ${enElMes('c.creado_en')}) AS nuevos,
               (SELECT COUNT(*)::int FROM clientes c WHERE ${enElMes('c.eliminado_en')}) AS bajas,
               (SELECT COUNT(DISTINCT e.cliente_id)::int FROM entregas e WHERE ${enElMes('e.fecha')}) AS atendidos,
               (SELECT COUNT(*)::int FROM entregas e WHERE ${enElMes('e.fecha')}) AS entregas,
               (SELECT COALESCE(SUM(e.cantidad_bidones), 0)::int FROM entregas e WHERE ${enElMes('e.fecha')}) AS bidones
        FROM meses m
        ORDER BY m.mes DESC
      `),
      pool.query(`
        SELECT e.cliente_id AS id, c.nombre, c.eliminado_en IS NOT NULL AS eliminado,
               COUNT(*)::int AS entregas, SUM(e.cantidad_bidones)::int AS bidones,
               COALESCE(SUM(e.monto_pagado), 0) AS pagado
        FROM entregas e LEFT JOIN clientes c ON c.id = e.cliente_id
        WHERE e.fecha >= $1::date AND e.fecha < $1::date + INTERVAL '1 month'
        GROUP BY e.cliente_id, c.nombre, c.eliminado_en
        ORDER BY bidones DESC, c.nombre
      `, [inicio]),
      pool.query(`
        SELECT id, nombre, to_char(creado_en, 'YYYY-MM-DD') AS fecha, eliminado_en IS NOT NULL AS eliminado
        FROM clientes
        WHERE creado_en >= $1::date AND creado_en < $1::date + INTERVAL '1 month'
        ORDER BY creado_en DESC
      `, [inicio]),
      pool.query(`
        SELECT id, nombre, to_char(eliminado_en, 'YYYY-MM-DD') AS fecha, true AS eliminado
        FROM clientes
        WHERE eliminado_en >= $1::date AND eliminado_en < $1::date + INTERVAL '1 month'
        ORDER BY eliminado_en DESC
      `, [inicio])
    ]);

    res.json({
      mes: inicio.slice(0, 7),
      meses: meses.rows,
      atendidos: atendidos.rows,
      altas: altas.rows,
      bajas: bajas.rows
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener el historial de clientes');
  }
});

// Manejador final de errores: cubre lo que no atrapa ningún try/catch
// (ej. JSON mal formado en el body, o que no se pueda obtener una conexión del pool).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la petición no es un JSON válido' });
  }
  console.error('Error no controlado:', err.message);
  res.status(500).json({ error: 'Error en el servidor' });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});
