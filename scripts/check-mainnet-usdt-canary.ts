import { prisma } from "../backend/src/db";
import { loadLocalEnv } from "../backend/src/load-env";
import { inspectMainnetUsdtCanary } from "../backend/src/mainnet-usdt-canary";

loadLocalEnv();

void inspectMainnetUsdtCanary({ db: prisma as any })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

