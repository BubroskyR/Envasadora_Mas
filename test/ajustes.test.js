// Pruebas de la validación de los ajustes de la app (ajustes.js).
// Se corren con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizarAjustes, PRECIO_MAXIMO, BARRIOS_MAXIMOS } = require('../ajustes');

const VALIDOS = { precio_bidon: 2500, barrios: ['Centro', 'Las Flores'], codigo_area: '3725' };

test('acepta ajustes válidos', () => {
  assert.deepEqual(normalizarAjustes(VALIDOS), { ajustes: VALIDOS });
});

test('acepta el precio y el código de área escritos como número o como texto', () => {
  const { ajustes } = normalizarAjustes({ ...VALIDOS, precio_bidon: '3000', codigo_area: 362 });
  assert.equal(ajustes.precio_bidon, 3000);
  assert.equal(ajustes.codigo_area, '362');
});

test('el precio vacío, cero, negativo, con letras o enorme no es válido', () => {
  for (const precio_bidon of [undefined, null, '', 0, -100, 'abc', PRECIO_MAXIMO + 1]) {
    assert.ok(normalizarAjustes({ ...VALIDOS, precio_bidon }).error, `precio ${precio_bidon}`);
  }
});

test('limpia los espacios y saca los barrios vacíos o repetidos, sin cambiar el orden', () => {
  const { ajustes } = normalizarAjustes({ ...VALIDOS, barrios: [' Centro ', 'San José', '', '   ', 'Centro', 'San José'] });
  assert.deepEqual(ajustes.barrios, ['Centro', 'San José']);
});

test('se puede guardar sin ningún barrio', () => {
  assert.deepEqual(normalizarAjustes({ ...VALIDOS, barrios: [] }).ajustes.barrios, []);
});

test('los barrios tienen que ser una lista de textos', () => {
  for (const barrios of [undefined, null, 'Centro', { 0: 'Centro' }, ['Centro', 5], ['Centro', null]]) {
    assert.ok(normalizarAjustes({ ...VALIDOS, barrios }).error, `barrios ${JSON.stringify(barrios)}`);
  }
});

test('un barrio de más de 100 letras no entra en la columna de los clientes', () => {
  assert.ok(normalizarAjustes({ ...VALIDOS, barrios: ['a'.repeat(101)] }).error);
  assert.ok(normalizarAjustes({ ...VALIDOS, barrios: ['a'.repeat(100)] }).ajustes);
});

test(`no se aceptan más de ${BARRIOS_MAXIMOS} barrios`, () => {
  const barrios = Array.from({ length: BARRIOS_MAXIMOS + 1 }, (_, i) => `Barrio ${i}`);
  assert.ok(normalizarAjustes({ ...VALIDOS, barrios }).error);
  assert.ok(normalizarAjustes({ ...VALIDOS, barrios: barrios.slice(1) }).ajustes);
});

test('el código de área tiene de 2 a 4 dígitos y no empieza con 0', () => {
  for (const codigo_area of ['37', '362', '3725']) {
    assert.equal(normalizarAjustes({ ...VALIDOS, codigo_area }).ajustes?.codigo_area, codigo_area);
  }
  for (const codigo_area of [undefined, null, '', '3', '37255', '03725', '37a5', ' 3725']) {
    assert.ok(normalizarAjustes({ ...VALIDOS, codigo_area }).error, `código ${codigo_area}`);
  }
});
