import { isSafeId } from './idValidator.js';

describe('isSafeId', () => {
  it('devuelve true para IDs válidos simples', () => {
    expect(isSafeId('a')).toBe(true);
    expect(isSafeId('Z')).toBe(true);
    expect(isSafeId('0')).toBe(true);
  });

  it('permite letras, números, guion y guion bajo', () => {
    expect(isSafeId('user_123')).toBe(true);
    expect(isSafeId('room-abc')).toBe(true);
    expect(isSafeId('USER_room-123_ABC')).toBe(true);
  });

  it('devuelve false para valores no string', () => {
    expect(isSafeId(null)).toBe(false);
    expect(isSafeId(undefined)).toBe(false);
    expect(isSafeId(123)).toBe(false);
    expect(isSafeId({})).toBe(false);
    expect(isSafeId([])).toBe(false);
  });

  it('devuelve false para string vacío o sólo espacios', () => {
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('   ')).toBe(false);
  });

  it('devuelve false si contiene caracteres no permitidos', () => {
    expect(isSafeId('abc!')).toBe(false);
    expect(isSafeId('id con espacios')).toBe(false);
    expect(isSafeId('id/slash')).toBe(false);
    expect(isSafeId('id@correo')).toBe(false);
    expect(isSafeId('id.punto')).toBe(false);
  });

  it('devuelve false si la longitud es mayor a 64 caracteres', () => {
    const valid64 = 'a'.repeat(64);
    const invalid65 = 'a'.repeat(65);

    expect(isSafeId(valid64)).toBe(true);
    expect(isSafeId(invalid65)).toBe(false);
  });
});
