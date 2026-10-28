// Pruebas de la regla que ajusta solo el consumo de un cliente (consumo.js).
// Se corren con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcularAjuste, semanalDerivado, consumoValido } = require('../consumo');

const SEMANAL = { bidones: 1, dias: 7 };
const MENSUAL = { bidones: 1, dias: 30 };

// Suma días a una fecha 'AAAA-MM-DD' (en UTC, para no depender de la zona horaria)
const sumarDias = (fecha, dias) => {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia + dias)).toISOString().slice(0, 10);
};

// Una entrega en `inicio` y otra después de cada intervalo de días
const visitasCada = (intervalos, bidones = 1, inicio = '2026-07-01') => {
  const entregas = [{ fecha: inicio, bidones }];
  for (const dias of intervalos) {
    entregas.push({ fecha: sumarDias(entregas[entregas.length - 1].fecha, dias), bidones });
  }
  return entregas;
};

test('un cliente semanal que pide cada 7 días no se ajusta', () => {
  assert.equal(calcularAjuste(visitasCada([7, 7, 7, 7]), SEMANAL, null), null);
});

test('verano: pedidos a los 4, 3 y 4 días ajustan a 2 por semana', () => {
  assert.deepEqual(calcularAjuste(visitasCada([4, 3, 4]), SEMANAL, null), { bidones: 2, dias: 7, fecha: '2026-07-12' });
});

test('verano: 3, 3 y 4 días (10 días) todavía no llegan a una semana y media', () => {
  assert.equal(calcularAjuste(visitasCada([3, 3, 4]), SEMANAL, null), null);
});

test('verano: con otro pedido a los 4 días ya se ajusta', () => {
  assert.deepEqual(calcularAjuste(visitasCada([3, 3, 4, 4]), SEMANAL, null), { bidones: 2, dias: 7, fecha: '2026-07-15' });
});

test('una semana de fiesta no cambia el consumo', () => {
  assert.equal(calcularAjuste(visitasCada([2, 2, 3]), SEMANAL, null), null);
  assert.equal(calcularAjuste(visitasCada([2, 2, 3, 7]), SEMANAL, null), null);
});

test('un pedido normal en el medio corta la racha', () => {
  assert.equal(calcularAjuste(visitasCada([3, 3, 7, 4]), SEMANAL, null), null);
});

test('un cliente semanal que pasa a pedir cada 30 días queda en 1 por mes', () => {
  assert.deepEqual(calcularAjuste(visitasCada([30, 30, 30]), SEMANAL, null), { bidones: 1, dias: 30, fecha: '2026-09-29' });
});

test('un cliente mensual que pide cada 28 días no se ajusta', () => {
  assert.equal(calcularAjuste(visitasCada([28, 28, 28]), MENSUAL, null), null);
});

test('dejarle 2 bidones por semana a un cliente de 1 lo ajusta a 2 por semana', () => {
  assert.deepEqual(calcularAjuste(visitasCada([7, 7, 7], 2), SEMANAL, null), { bidones: 2, dias: 7, fecha: '2026-07-22' });
});

test('las entregas del mismo día se suman como una sola visita', () => {
  const entregas = [{ fecha: '2026-07-01', bidones: 1 }];
  for (const fecha of ['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']) {
    entregas.push({ fecha, bidones: 1 }, { fecha, bidones: 1 });
  }
  entregas.reverse(); // de la más nueva a la más vieja, como salen de la base
  assert.deepEqual(calcularAjuste(entregas, SEMANAL, null), { bidones: 2, dias: 7, fecha: '2026-07-29' });
});

test('las entregas de 0 bidones no cuentan', () => {
  const entregas = [...visitasCada([4, 3, 4]), { fecha: '2026-07-03', bidones: 0 }];
  assert.deepEqual(calcularAjuste(entregas, SEMANAL, null), { bidones: 2, dias: 7, fecha: '2026-07-12' });
});

test('solo cuentan las comparaciones que terminan después de "desde"', () => {
  const entregas = visitasCada([4, 3, 4]);
  assert.equal(calcularAjuste(entregas, SEMANAL, '2026-07-05'), null);
  assert.deepEqual(calcularAjuste(entregas, SEMANAL, '2026-07-01'), { bidones: 2, dias: 7, fecha: '2026-07-12' });
});

test('si lo más parecido es el consumo actual, no se cambia', () => {
  assert.equal(calcularAjuste(visitasCada([50, 50, 50]), MENSUAL, null), null);
});

test('un consumo inválido lanza un error', () => {
  assert.throws(() => calcularAjuste(visitasCada([7, 7, 7]), { bidones: 1, dias: 0 }, null));
});

test('semanalDerivado redondea a bidones por semana, con mínimo 1', () => {
  assert.equal(semanalDerivado({ bidones: 1, dias: 30 }), 1);
  assert.equal(semanalDerivado({ bidones: 3, dias: 7 }), 3);
  assert.equal(semanalDerivado({ bidones: 5, dias: 14 }), 3);
});

test('consumoValido tiene un tope de 1000 bidones (un número enorme no entra en la base)', () => {
  assert.equal(consumoValido(1000, 7), true);
  assert.equal(consumoValido(1001, 7), false);
  assert.equal(consumoValido(2215551234, 7), false);
});

test('consumoValido acepta bidones enteros desde 1 y solo los períodos de la app', () => {
  assert.equal(consumoValido(1, 7), true);
  assert.equal(consumoValido(2, 30), true);
  assert.equal(consumoValido(0, 7), false);
  assert.equal(consumoValido(1.5, 7), false);
  assert.equal(consumoValido(1, 10), false);
});
