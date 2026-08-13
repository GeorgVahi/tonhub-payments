import { Hono } from "hono";
import { cors } from "hono/cors";
import { createTonhubPaymentRoutes } from "./routes/payments";
import { createAdminRoutes } from "./admin/routes";
import { resolveOptionalAdminSecurityConfig } from "./admin/security";

export function createTonhubPaymentApp() {
  const app = new Hono();
  const corsOrigin = process.env.TONHUB_CORS_ORIGIN?.trim();

  if (corsOrigin) {
    app.use(
      "/api/tonhub-payments/*",
      cors({
        origin: corsOrigin,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["content-type"]
      })
    );
  }

  app.route("/", createTonhubPaymentRoutes());
  const adminConfig = resolveOptionalAdminSecurityConfig();
  if (adminConfig) {
    app.route("/", createAdminRoutes({ config: adminConfig }));
  }

  return app;
}

