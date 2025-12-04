import { jest } from '@jest/globals';

global.fetch = jest.fn();

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    quit: jest.fn().mockResolvedValue(undefined),
    isOpen: true,
    isReady: true,
  })),
}));

jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue({
      release: jest.fn().mockResolvedValue(undefined),
    }),
    using: jest.fn(async (resources, duration, handler) => {
      return handler({ release: jest.fn() });
    }),
  }));
});

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  if (args[0]?.includes?.('[dotenv]') || args[0]?.includes?.('injecting env')) {
    return;
  }
  originalConsoleLog(...args);
};

console.error = (...args) => {
  if (args[0]?.includes?.('[dotenv]')) {
    return;
  }
  originalConsoleError(...args);
};