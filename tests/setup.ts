/**
 * Jest test setup
 * Runs before all tests
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.BACKEND_URL = 'http://localhost:5000';

// Suppress console logs during tests (optional)
if (process.env.DEBUG !== 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn()
  };
}

// Default test timeout
jest.setTimeout(10000);
