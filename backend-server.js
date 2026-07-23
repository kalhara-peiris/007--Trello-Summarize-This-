const http = require("node:http");
const config = require("./backend-config");
const { createBackendApp } = require("./backend-app");

function startBackendServer(options = {}) {
  const readiness = config.backendReadiness();
  if (!readiness.ok && !options.allowMissingEnv) {
    const error = new Error(`Backend startup blocked. Missing required environment variables: ${readiness.missing.join(", ")}`);
    error.code = "BACKEND_ENV_MISSING";
    throw error;
  }

  const app = createBackendApp(options);
  const server = http.createServer((req, res) => app.handle(req, res));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const port = Object.prototype.hasOwnProperty.call(options, "port") ? options.port : config.PORT;
    const host = Object.prototype.hasOwnProperty.call(options, "host") ? options.host : config.HOST;
    server.listen(port, host, () => {
      resolve({ server, app });
    });
  });
}

if (require.main === module) {
  startBackendServer().then(({ server }) => {
    const address = server.address();
    console.log(`Summarize This backend listening on http://${address.address}:${address.port}/api/health`);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  startBackendServer
};
