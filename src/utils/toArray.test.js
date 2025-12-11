import { toArray } from './toArray.js';

describe('toArray', () => {
  it('devuelve null cuando el valor es null o undefined', () => {
    expect(toArray(null)).toBeNull();
    expect(toArray(undefined)).toBeNull();
  });

  it('devuelve el mismo array si el valor ya es un array', () => {
    const arr = [1, 2, 3];
    const result = toArray(arr);
    // misma referencia, no clona
    expect(result).toBe(arr);
  });

  it('convierte un string sin comas en un array con el string trimmeado', () => {
    expect(toArray('abc')).toEqual(['abc']);
    expect(toArray('  abc  ')).toEqual(['abc']);
  });

  it('devuelve null para un string vacío o solo con espacios', () => {
    expect(toArray('')).toBeNull();
    expect(toArray('   ')).toBeNull();
  });

  it('divide un string por comas, trimea y filtra elementos vacíos', () => {
    const value = ' a, b ,  c ,, , d  ';
    const result = toArray(value);
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('envuelve otros tipos (no string, no array, no null/undefined) en un array', () => {
    expect(toArray(42)).toEqual([42]);
    const obj = { foo: 'bar' };
    expect(toArray(obj)).toEqual([obj]);
    expect(toArray(true)).toEqual([true]);
  });
});
