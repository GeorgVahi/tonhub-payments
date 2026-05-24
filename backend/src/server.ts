import { createTonhubPaymentApp } from "./app";
import { loadLocalEnv } from "./load-env";

declare const Bun: {
  serve(input: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): {
    port: number;
  };
};

loadLocalEnv();

const app = createTonhubPaymentApp();
const port = Number.parseInt(process.env.TONHUB_PAYMENTS_PORT || "3008", 10);
const server = Bun.serve({
  port,
  fetch: app.fetch
});

console.log(`[tonhub-payments] API listening on http://localhost:${server.port}`);

