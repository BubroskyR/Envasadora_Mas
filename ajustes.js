// Ajustes de la app (pantalla Ajustes): precio del bidón, barrios de reparto y código de área.
// Se guardan en la base para que sean los mismos en todos los teléfonos.

// Topes: un número enorme (por ejemplo, un teléfono pegado en el campo del precio) se rechaza
// en vez de terminar en el monto de cada entrega
const PRECIO_MAXIMO = 10000000;
const BARRIOS_MAXIMOS = 200;
// Igual que la columna barrio de los clientes (VARCHAR(100))
const LARGO_MAXIMO_BARRIO = 100;

// Devuelve { ajustes } con los datos limpios, o { error } con el motivo para mostrar en la app
const normalizarAjustes = ({ precio_bidon, barrios, codigo_area } = {}) => {
  const precio = typeof precio_bidon === 'number' || typeof precio_bidon === 'string' ? Number(precio_bidon) : NaN;
  if (!Number.isFinite(precio) || precio <= 0 || precio > PRECIO_MAXIMO) {
    return { error: 'El precio del bidón no es válido' };
  }

  if (!Array.isArray(barrios) || !barrios.every(b => typeof b === 'string')) {
    return { error: 'Los barrios no son válidos' };
  }
  // Sin espacios de más, sin vacíos y sin repetidos, en el orden en que se cargaron
  const barriosLimpios = [...new Set(barrios.map(b => b.trim()).filter(Boolean))];
  if (barriosLimpios.length > BARRIOS_MAXIMOS) {
    return { error: `No se pueden cargar más de ${BARRIOS_MAXIMOS} barrios` };
  }
  if (barriosLimpios.some(b => b.length > LARGO_MAXIMO_BARRIO)) {
    return { error: `El nombre de un barrio no puede tener más de ${LARGO_MAXIMO_BARRIO} letras` };
  }

  // Los códigos de área argentinos tienen de 2 a 4 dígitos (sin el 0)
  const codigo = typeof codigo_area === 'number' || typeof codigo_area === 'string' ? String(codigo_area) : '';
  if (!/^[1-9]\d{1,3}$/.test(codigo)) {
    return { error: 'El código de área no es válido (de 2 a 4 números, sin el 0)' };
  }

  return { ajustes: { precio_bidon: precio, barrios: barriosLimpios, codigo_area: codigo } };
};

module.exports = { PRECIO_MAXIMO, BARRIOS_MAXIMOS, normalizarAjustes };
