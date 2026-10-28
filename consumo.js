// Regla que ajusta solo el consumo de un cliente cuando cambia de ritmo de forma sostenida
// (ver docs/superpowers/specs/2026-10-27-consumo-flexible-design.md, sección 1.2).
//
// En cada entrega se mira cuántos días le duraron al cliente los bidones de la vez anterior:
// - "antes": le duraron 2/3 de lo esperado o menos (pidió cuando todavía le quedaba un tercio o más).
// - "después": le duraron 1,5 veces lo esperado o más.
// - normal: cualquier otro caso; corta la racha.
// Se ajusta con 3 seguidas del mismo tipo que además abarquen al menos 1,5 períodos del cliente,
// así una sola semana con muchos pedidos (una fiesta, visitas) no cambia nada.

// Períodos que se pueden elegir en la app: por semana, cada 2 semanas, cada 3 semanas y por mes
const PERIODOS_DIAS = [7, 14, 21, 30];

const UMBRAL_ANTES = 2 / 3;
const UMBRAL_DESPUES = 1.5;
const COMPARACIONES_MINIMAS = 3;
const PERIODOS_MINIMOS = 1.5;

// Tope de bidones por período: un número enorme (por ejemplo, un teléfono pegado en el campo) no entra en la
// columna de la base y daría un error 500, que la cola del teléfono reintentaría para siempre
const BIDONES_MAXIMOS = 1000;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

const consumoValido = (bidones, dias) =>
  Number.isInteger(bidones) && bidones >= 1 && bidones <= BIDONES_MAXIMOS && PERIODOS_DIAS.includes(dias);

// La columna vieja consumo_semanal_estimado se sigue llenando para la versión anterior de la app
const semanalDerivado = ({ bidones, dias }) => Math.max(1, Math.round((bidones * 7) / dias));

// Número de día de una fecha 'AAAA-MM-DD' (en UTC, para no depender de la zona horaria)
const numeroDeDia = (fecha) => {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  return Date.UTC(anio, mes - 1, dia) / MS_POR_DIA;
};

// Varias entregas el mismo día son una sola visita; las de 0 bidones no cuentan
const agruparVisitas = (entregas) => {
  const porFecha = new Map();
  for (const { fecha, bidones } of entregas) {
    const cantidad = Number(bidones) || 0;
    if (cantidad > 0) porFecha.set(fecha, (porFecha.get(fecha) ?? 0) + cantidad);
  }
  return [...porFecha]
    .map(([fecha, bidones]) => ({ fecha, bidones }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
};

// El consumo de la app más parecido (en proporción) a un ritmo en bidones por día:
// 1 por mes, 1 cada 3 semanas, 1 cada 2 semanas o N por semana
const consumoMasParecido = (ritmo) => {
  const candidatos = [{ bidones: 1, dias: 30 }, { bidones: 1, dias: 21 }, { bidones: 1, dias: 14 }];
  for (let n = 1; n <= Math.ceil(ritmo * 7) + 1; n++) candidatos.push({ bidones: n, dias: 7 });
  const distancia = (c) => Math.abs(Math.log(c.bidones / c.dias) - Math.log(ritmo));
  return candidatos.reduce((mejor, c) => (distancia(c) < distancia(mejor) ? c : mejor));
};

// Devuelve el consumo nuevo ({ bidones, dias, fecha }) o null si no corresponde ajustar.
// `entregas` puede venir en cualquier orden; `desde` ('AAAA-MM-DD' o null) es el último cambio de consumo:
// solo cuentan las comparaciones que terminan después. `fecha` es la de la última visita, desde donde
// vuelve a empezar la cuenta.
const calcularAjuste = (entregas, consumo, desde) => {
  if (!consumoValido(consumo.bidones, consumo.dias)) {
    throw new Error(`Consumo inválido: ${consumo.bidones} cada ${consumo.dias} días`);
  }
  const visitas = agruparVisitas(entregas);

  // Una comparación por cada par de visitas seguidas
  const comparaciones = [];
  for (let i = 1; i < visitas.length; i++) {
    const anterior = visitas[i - 1];
    const actual = visitas[i];
    if (desde && actual.fecha <= desde) continue;
    const dias = numeroDeDia(actual.fecha) - numeroDeDia(anterior.fecha);
    const esperado = (anterior.bidones * consumo.dias) / consumo.bidones;
    const razon = dias / esperado;
    const tipo = razon <= UMBRAL_ANTES ? 'antes' : razon >= UMBRAL_DESPUES ? 'despues' : 'normal';
    comparaciones.push({ tipo, dias, bidones: anterior.bidones });
  }

  // La racha son las últimas comparaciones seguidas del mismo tipo
  const ultima = comparaciones[comparaciones.length - 1];
  if (!ultima || ultima.tipo === 'normal') return null;
  let inicio = comparaciones.length - 1;
  while (inicio > 0 && comparaciones[inicio - 1].tipo === ultima.tipo) inicio--;
  const racha = comparaciones.slice(inicio);

  const diasRacha = racha.reduce((total, c) => total + c.dias, 0);
  if (racha.length < COMPARACIONES_MINIMAS || diasRacha < PERIODOS_MINIMOS * consumo.dias) return null;

  // Ritmo de la racha: los bidones que se dejaron al empezar cada comparación ÷ los días que duraron
  const bidonesRacha = racha.reduce((total, c) => total + c.bidones, 0);
  const nuevo = consumoMasParecido(bidonesRacha / diasRacha);
  if (nuevo.bidones === consumo.bidones && nuevo.dias === consumo.dias) return null;
  return { bidones: nuevo.bidones, dias: nuevo.dias, fecha: visitas[visitas.length - 1].fecha };
};

module.exports = { PERIODOS_DIAS, BIDONES_MAXIMOS, consumoValido, semanalDerivado, calcularAjuste };
