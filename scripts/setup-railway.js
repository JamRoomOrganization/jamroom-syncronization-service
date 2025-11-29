#!/usr/bin/env node

/**
 * Script para configurar variables de entorno en Railway
 *
 * Uso:
 *   node scripts/setup-railway.js
 *
 * Prerequisitos:
 *   - Railway CLI instalado: https://docs.railway.app/develop/cli
 *   - Autenticado con: railway login
 *   - Proyecto seleccionado con: railway link
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('Railway Configuration Setup\n');

// Verificar si Railway CLI está instalado
try {
    execFileSync('railway', ['--version'], { stdio: 'ignore' });
} catch (error) {
    console.error('Railway CLI no está instalado.');
    console.error('   Instálalo con: npm i -g @railway/cli');
    console.error('   Más info: https://docs.railway.app/develop/cli');
    process.exit(1);
}

// Verificar si el proyecto está vinculado
try {
    execFileSync('railway', ['status'], { stdio: 'ignore' });
} catch (error) {
    console.error('El proyecto no está vinculado a Railway.');
    console.error('   Vincúlalo con: railway link');
    process.exit(1);
}

console.log('Railway CLI instalado y proyecto vinculado\n');

// Leer archivo .env
const envPath = join(__dirname, '..', '.env');
let envContent;

try {
    envContent = readFileSync(envPath, 'utf-8');
} catch (error) {
    console.error('No se pudo leer el archivo .env');
    console.error('   Asegúrate de que existe en:', envPath);
    process.exit(1);
}

// Analizar variables de entorno
const envVars = {};
envContent.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=');
        envVars[key.trim()] = value.trim();
    }
});

console.log('Variables encontradas en .env:\n');
Object.keys(envVars).forEach(key => {
    const value = envVars[key];
    const display = key.includes('PASSWORD') || key.includes('URL')
        ? value.substring(0, 20) + '...'
        : value;
    console.log(`   ${key}=${display}`);
});

console.log('\nConfigurando variables en Railway...\n');

// Configurar variables en Railway
let successCount = 0;
let errorCount = 0;

Object.entries(envVars).forEach(([key, value]) => {
    // Validación básica del nombre de la variable
    if (!/^[A-Z0-9_]+$/i.test(key)) {
        console.error(`Nombre de variable inválido: ${key}`);
        errorCount++;
        return;
    }

    try {
        console.log(`   Configurando ${key}...`);
        execFileSync('railway', ['variables', 'set', `${key}=${value}`], {
            stdio: 'ignore',
            encoding: 'utf-8'
        });
        successCount++;
        console.log(`   ${key} configurado`);
    } catch (error) {
        errorCount++;
        console.error(`   Error configurando ${key}`);
    }
});

console.log('\nResumen:');
console.log(`   ${successCount} variables configuradas`);
if (errorCount > 0) {
    console.log(`   ${errorCount} errores`);
}

console.log('\nConfiguración completada.');
console.log('\nPróximos pasos:');
console.log('   1. Verifica las variables: railway variables');
console.log('   2. Despliega: git push origin main');
console.log('   3. Revisa los logs: railway logs');
