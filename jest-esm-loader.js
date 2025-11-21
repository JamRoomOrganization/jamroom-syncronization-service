export async function resolve(specifier, context, defaultResolve) {
    if (specifier.startsWith('node:')) {
        return defaultResolve(specifier, context, defaultResolve);
    }

    const resolved = await defaultResolve(specifier, context, defaultResolve);
    return resolved;
}

export async function load(url, context, defaultLoad) {
    const isNodeModule = url.includes('/node_modules/');

    if (!isNodeModule && url.endsWith('.js')) {
        return defaultLoad(url, { ...context, format: 'module' }, defaultLoad);
    }

    return defaultLoad(url, context, defaultLoad);
}
