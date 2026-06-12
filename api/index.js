// Vercel serverless entry point — thin wrapper around the compiled Express app.
const app = require('../dist/server').default;
module.exports = app;
