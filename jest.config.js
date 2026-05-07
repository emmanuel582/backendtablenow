module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/server.ts'
  ],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000,
  globals: {
    'ts-jest': {
      tsconfig: {
        skipLibCheck: true
      }
    }
  }
};
