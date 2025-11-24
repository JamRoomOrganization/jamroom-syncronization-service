/**
 * Convierte un valor a un array.
 * - Si es un array, lo retorna tal cual
 * - Si es un string, lo divide por comas
 * - Si es null/undefined, retorna null
 * - Para otros tipos, lo envuelve en un array
 *
 * @param {*} value - El valor a convertir
 * @returns {Array|null} El array resultante o null
 */
export function toArray(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === 'string') {
        // Si el string contiene comas, lo dividimos
        if (value.includes(',')) {
            return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
        }
        // Si no tiene comas, retornamos un array con el string
        return value.trim() ? [value.trim()] : null;
    }

    // Para otros tipos, los envolvemos en un array
    return [value];
}

