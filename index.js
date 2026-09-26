const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json()); // Permite recibir datos en formato JSON

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Probar la conexión a la base de datos
pool.connect()
  .then(() => console.log('✅ Conectado exitosamente a PostgreSQL'))
  .catch(err => console.error('❌ Error de conexión a la base de datos', err.stack));



  // Ruta de prueba: Obtener todos los clientes (la consulta que vimos antes)
app.get('/api/clientes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes ORDER BY deuda_actual DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor');
  }
});




// Ruta POST: Crear un nuevo cliente
app.post('/api/clientes', async (req, res) => {
  try {
    // 1. Extraemos los datos que nos envía el frontend
    const { nombre, direccion, telefono, consumo_semanal_estimado } = req.body;

    // 2. Validación básica: asegurarnos de que al menos envíen el nombre
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
    }

    // 3. Consulta SQL parametrizada (Los $1, $2 evitan hackeos por inyección SQL)
    const query = `
      INSERT INTO clientes (nombre, direccion, telefono, consumo_semanal_estimado)
      VALUES ($1, $2, $3, $4)
      RETURNING *; 
      -- RETURNING * le dice a Postgres que nos devuelva toda la fila recién creada
    `;
    
    // Asignamos los valores, si no envían consumo estimado, por defecto será 1
    const values = [nombre, direccion, telefono, consumo_semanal_estimado || 1];

    // 4. Ejecutamos la consulta en la base de datos
    const result = await pool.query(query, values);

    // 5. Respondemos con el cliente creado y un código 201 (Created)
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor al crear el cliente');
  }
});

// Ruta POST: Registrar una entrega y actualizar el cliente
app.post('/api/entregas', async (req, res) => {
  // Pedimos un "cliente" temporal a la base de datos para manejar la transacción
  const client = await pool.connect(); 

  try {
    const { cliente_id, cantidad_bidones, monto_pagado, monto_total } = req.body;
    const monto_adeudado = monto_total - monto_pagado;

    if (!cliente_id || !cantidad_bidones) {
      return res.status(400).json({ error: 'Faltan datos obligatorios (cliente_id, cantidad_bidones)' });
    }

    // 1. Iniciamos la transacción
    await client.query('BEGIN');

    // 2. Insertamos la nueva entrega en el historial (usamos CURRENT_DATE para la fecha de hoy)
    const insertEntregaQuery = `
      INSERT INTO entregas (cliente_id, fecha, cantidad_bidones, monto_pagado, monto_adeudado)
      VALUES ($1, CURRENT_DATE, $2, $3, $4)
      RETURNING *;
    `;
    const valoresEntrega = [cliente_id, cantidad_bidones, monto_pagado || 0, monto_adeudado || 0];
    const resultadoEntrega = await client.query(insertEntregaQuery, valoresEntrega);

    // 3. Actualizamos al cliente: Sumamos la nueva deuda y actualizamos su última entrega
    const updateClienteQuery = `
      UPDATE clientes
      SET deuda_actual = deuda_actual + $1,
          fecha_ultima_entrega = CURRENT_DATE
      WHERE id = $2;
    `;
    await client.query(updateClienteQuery, [monto_adeudado || 0, cliente_id]);

    // 4. Confirmamos que todo salió bien y guardamos los cambios
    await client.query('COMMIT');

    // Devolvemos los datos de la entrega recién creada
    res.status(201).json({
      mensaje: 'Entrega registrada correctamente',
      entrega: resultadoEntrega.rows[0]
    });

  } catch (err) {
    // Si hay CUALQUIER error, deshacemos todos los cambios
    await client.query('ROLLBACK');
    console.error('Error en la transacción:', err.message);
    res.status(500).json({ error: 'Error al registrar la entrega' });
  } finally {
    // Siempre liberamos la conexión al terminar
    client.release();
  }
});

// Ruta POST: Registrar un nuevo gasto
app.post('/api/gastos', async (req, res) => {
  try {
    // 1. Extraemos los datos que envías desde la app
    const { categoria, monto, descripcion } = req.body;

    // 2. Validación: Asegurarnos de que envíen categoría y monto
    if (!categoria || !monto) {
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
    const result = await pool.query('SELECT * FROM gastos ORDER BY fecha DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener los gastos');
  }
});

// Ruta POST: Registrar un pago y guardar el historial (con Transacción)
app.post('/api/pagos', async (req, res) => {
  const client = await pool.connect();

  try {
    const { cliente_id, monto_pago, metodo_pago } = req.body;

    if (!cliente_id || !monto_pago) {
      return res.status(400).json({ error: 'Faltan datos obligatorios (cliente_id, monto_pago)' });
    }

    await client.query('BEGIN'); // Iniciamos la transacción

    // 1. Guardar el registro en el historial de pagos
    const insertPagoQuery = `
      INSERT INTO pagos (cliente_id, monto, metodo_pago)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const resultadoPago = await client.query(insertPagoQuery, [cliente_id, monto_pago, metodo_pago || 'Efectivo']);

    // 2. Descontar la deuda del perfil del cliente
    const updateClienteQuery = `
      UPDATE clientes
      SET deuda_actual = deuda_actual - $1
      WHERE id = $2
      RETURNING *;
    `;
    const resultadoCliente = await client.query(updateClienteQuery, [monto_pago, cliente_id]);

    await client.query('COMMIT'); // Confirmamos los cambios

    res.status(201).json({
      mensaje: 'Pago registrado exitosamente en el historial y deuda actualizada',
      pago_registrado: resultadoPago.rows[0],
      cliente_actualizado: resultadoCliente.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK'); // Deshacemos todo si hay error
    console.error('Error en la transacción de pago:', err.message);
    res.status(500).json({ error: 'Error al procesar el pago' });
  } finally {
    client.release();
  }
});
// Ruta GET: Obtener un cliente específico por su ID
app.get('/api/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    
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
  try {
    const { id } = req.params;
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

// Ruta PUT: Actualizar los datos de un cliente existente (VERSIÓN MEJORADA)
app.put('/api/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Extraemos todos los datos posibles, incluyendo los nuevos espaciales
    const { nombre, direccion, telefono, consumo_semanal_estimado, barrio, latitud, longitud } = req.body;

    // Usamos COALESCE para que si algún dato no se envía (es undefined o null), 
    // la base de datos mantenga su valor actual y no lo borre accidentalmente.
    const updateQuery = `
      UPDATE clientes 
      SET 
        nombre = COALESCE($1, nombre), 
        direccion = COALESCE($2, direccion), 
        telefono = COALESCE($3, telefono), 
        consumo_semanal_estimado = COALESCE($4, consumo_semanal_estimado),
        barrio = COALESCE($5, barrio),
        latitud = COALESCE($6, latitud),
        longitud = COALESCE($7, longitud)
      WHERE id = $8
      RETURNING *;
    `;
    
    const result = await pool.query(updateQuery, [
      nombre, 
      direccion, 
      telefono, 
      consumo_semanal_estimado, 
      barrio, 
      latitud, 
      longitud, 
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente actualizado', cliente: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al actualizar el cliente');
  }
});

// Ruta GET: Obtener todas las entregas generales (para calcular ingresos del gráfico)
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

// Ruta GET: Obtener todos los pagos (para sumarlos a los ingresos)
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

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});