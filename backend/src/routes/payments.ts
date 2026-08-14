import { Hono } from "hono";
import {
  checkTonhubPaymentInvoice,
  createTonhubPaymentInvoice,
  getTonhubPaymentInvoice
} from "../payments";
import { parseFiatCurrency, resolveAllowedNetworks, resolveDefaultNetwork } from "../config";
import { fetchTonFiatRate } from "../rates";
import { gramAsset } from "../ton/direct-payments";
import { listPaymentAssets, paymentAssets } from "../../../shared/payment-assets";
import { resolveCheckoutAssetPolicy } from "../checkout-assets";
import { resolveCheckoutOrderPolicy } from "../checkout-order-policy";

export function createTonhubPaymentRoutes() {
  const app = new Hono();

  app.get("/api/tonhub-payments/health", (context) =>
    context.json({
      ok: true
    })
  );

  app.get("/api/tonhub-payments/config", (context) => {
    const checkout = resolveCheckoutAssetPolicy();
    const defaultNetwork = resolveDefaultNetwork();
    return context.json({
      ok: true,
      config: {
        defaultNetwork,
        allowedNetworks: resolveAllowedNetworks(),
        currencies: ["EUR", "USD"],
        defaultAsset: checkout.defaultAssetByNetwork[defaultNetwork],
        checkoutAssets: checkout.checkoutAssetsByNetwork[defaultNetwork],
        defaultAssetByNetwork: checkout.defaultAssetByNetwork,
        checkoutAssetsByNetwork: checkout.checkoutAssetsByNetwork,
        assets: listPaymentAssets().map((asset) => ({
          symbol: asset.symbol,
          label: asset.label,
          network: asset.network,
          kind: asset.kind,
          decimals: asset.decimals,
          checkoutFractionDigits: asset.checkoutFractionDigits,
          pricingStrategy: asset.pricingStrategy
        })),
        orderPolicyByCurrency: {
          USD: resolveCheckoutOrderPolicy("USD"),
          EUR: resolveCheckoutOrderPolicy("EUR"),
        },
        invoiceTtlMinutes: Number.parseInt(process.env.TON_INVOICE_TTL_MINUTES || "60", 10),
        partialPaymentTtlHours: Number.parseInt(process.env.TON_PARTIAL_PAYMENT_TTL_HOURS || "24", 10)
      }
    });
  });

  app.get("/api/tonhub-payments/rates/:currency", async (context) => {
    try {
      const currency = parseFiatCurrency(context.req.param("currency"));
      const rate = await fetchTonFiatRate(currency);
      return context.json({
        ok: true,
        rate: {
          source: rate.source,
          currency: rate.currency,
          fiatPerGram: rate.fiatPerTon,
          fiatPerTon: rate.fiatPerTon,
          asset: paymentAssets.GRAM.symbol,
          assetDecimals: paymentAssets.GRAM.decimals,
          fiatPerAsset: rate.fiatPerTon,
          updatedAt: rate.updatedAt?.toISOString() ?? null,
          fetchedAt: rate.fetchedAt.toISOString()
        }
      });
    } catch (error) {
      return context.json(
        {
          errorCode: "TON_RATE_UNAVAILABLE",
          error: error instanceof Error ? error.message : `Unable to fetch ${gramAsset.label} rate.`
        },
        503
      );
    }
  });

  app.post("/api/tonhub-payments/invoices", async (context) => {
    const body = await context.req.json().catch(() => null);
    const response = await createTonhubPaymentInvoice(body);
    return context.json(response.body, response.status);
  });

  app.get("/api/tonhub-payments/invoices/:id", async (context) => {
    const response = await getTonhubPaymentInvoice(context.req.param("id"));
    return context.json(response.body, response.status);
  });

  app.post("/api/tonhub-payments/invoices/:id/check", async (context) => {
    const response = await checkTonhubPaymentInvoice(context.req.param("id"));
    return context.json(response.body, response.status);
  });

  return app;
}

