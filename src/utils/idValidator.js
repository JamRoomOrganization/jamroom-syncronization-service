// Aceptamos sólo IDs cortos alfanuméricos con _ y -
// Esto evita claves raras en Redis y logs
export function isSafeId(id) {
    return (
        typeof id === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(id)
    );
}
