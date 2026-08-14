# Production rollout gate

Этот runbook относится только к сети TON. Публичные активы — официальный USD₮
в TON mainnet и нативный GRAM. TRON/TRC20-сеть, TRON-адреса и TronLink в scope
не входят.

## Автоматический gate

Перед каждым canary и перед публичным включением выполнить последовательно:

```bash
npm ci
npm run rollout:validate
npm audit --audit-level=low
npm run db:migrate:rehearse
```

`rollout:validate` запускает полный unit/characterization suite, typecheck,
production build и `prisma validate`. Rehearsal отдельно поднимает чистую и
legacy PostgreSQL базы, применяет всю migration history через
`prisma migrate deploy` и запускает real-repository verifiers.

## Обязательная матрица доказательств

| Контракт | Автоматическое доказательство |
| --- | --- |
| Старый GRAM full/partial, duplicate, overpayment, 24h partial | `tonhub-payments.test.ts`, `gram-flow-characterization.test.ts` |
| USD и EUR; выбранный USD₮ и выбранный GRAM | `public-checkout.test.ts`, `payment-assets.test.ts`, `rate-snapshots.test.ts` |
| GRAM в USD₮ attempt; USD₮ в GRAM attempt; mixed settlement | `gram-ledger-cutover.test.ts`, `movement-ledger.test.ts` |
| Несколько partial movements и exact cumulative credit | `gram-flow-characterization.test.ts`, `movement-ledger.test.ts` |
| Under-minimum → held → threshold | `movement-ledger.test.ts` |
| Under-minimum → expiry без нового movement и без браузера | `mixed-settlement.test.ts` |
| Out-of-order ingestion и платёж до TTL, найденный после TTL | `movement-ledger.test.ts` |
| Отсутствующий/stale rate snapshot | `public-checkout.test.ts`, `movement-ledger.test.ts` |
| Switch до movement; запрет switch после movement | `order-attempts.test.ts`, `payment-assets.test.ts` |
| Late payment на terminal/cancelled address | `movement-ledger.test.ts`, scanner terminal-cadence tests |
| Scanner restart и duplicate replay | `gram-shadow-scanner.test.ts`, `gram-ledger-cutover.test.ts` |
| Два scanner workers и lease fencing | `verify-gram-shadow-scanner.ts`, `verify-movement-ledger.ts` |
| Aborted transfer, fake master, wrong wallet, malformed notification | `internal-testnet-jetton.test.ts`, `mainnet-usdt.test.ts` |
| USD₮ wallet first-deployment evidence | shared verified-jetton adapter test in `internal-testnet-jetton.test.ts` |
| Недостаток gas, повтор top-up, reserve repair | `mainnet-usdt-sweep.test.ts` |
| Повтор sweep, crash windows, exact treasury receipt | `mainnet-usdt-sweep.test.ts`, `gram-flow-characterization.test.ts` |
| Mixed USD₮/GRAM sweep ordering и общий signing lease | `gram-flow-characterization.test.ts`, `mainnet-usdt-sweep.test.ts` |
| Webhook HMAC, retry, dedup, immutable outbox | `webhooks.test.ts`, `verify-webhook-outbox.ts` |
| Admin auth, HTTPS, session, CSRF, rate limit, audit | `admin-security.test.ts`, `verify-admin-repository.ts` |
| Старые production rows и additive migration | clean + legacy `db:migrate:rehearse` |
| Закрытый браузер во время оплаты | autonomous scanner/settlement tests; live confirmation below |
| Тысячи активных attempts | 1,000-attempt background batch and 10,000-due scheduler tests |

Матрица считается зелёной только если команды завершились с exit code 0. Timeout,
skipped verifier или невозможность поднять legacy rehearsal — это незавершённый
gate, а не PASS.

## Порядок production deploy

1. Сделать backup и read-only сверку реальной schema, `_prisma_migrations`,
   counts/totals и связей invoice → order → attempt → deposit.
2. Сначала устранить любой migration-history drift. Не baseline-ить неизвестную
   production schema и не редактировать уже применённые migration files.
3. Выполнить только `prisma migrate deploy`. Первый rollout additive: старые поля
   остаются deprecated, таблицы/columns не удаляются.
4. Задеплоить API/frontend с dual-read/dual-write совместимостью.
5. Запустить rate worker, GRAM shadow scanner для mainnet, official USD₮ observer,
   mixed settlement, native и USD₮ sweep workers, затем webhook worker.
6. Выполнить `npm run canary:usdt-mainnet:status`. Любой blocker останавливает
   issuance; signing и sweep workers при этом не выключать.
7. Разрешить один exact merchant `externalId`, создать небольшой mainnet order и
   выполнить live-wallet canary ниже.
8. После сверки ledger, sweep, treasury receipt, admin и webhook постепенно
   расширять allowlist. Публичный флаг и USD₮ default включать последними.

## Live-wallet canary

Эти пункты нельзя честно заменить mock/provider test. Для каждого результата
сохранить order ID, movement hash/LT, времена observer/credit/sweep, treasury
receipt и webhook event ID — без seed phrases или private keys.

- Tonhub: USD₮ через TON Connect, затем GRAM через QR/manual fallback.
- Tonkeeper: USD₮ и GRAM; проверить exact network/master/amount перед подписью.
- Trust Wallet: поддерживаемый TON payment request либо сохранённый fallback.
- Wallet in Telegram: USD₮ и GRAM; проверить возврат в checkout после подписи.
- На одном canary закрыть вкладку сразу после отправки. Scanner, settlement,
  sweep и webhook должны завершить цепочку без `/check` из браузера.
- Отдельно проверить первый входящий USD₮ на ранее неразвёрнутый jetton-wallet,
  недостаток TON gas, повтор top-up без двойной отправки и exact treasury receipt.
- Сделать mixed GRAM + USD₮ partial и убедиться, что общий fiat order закрывается,
  а оба актива sweep-ятся строго своими workers через общий signing lease.

Если кошелёк не объявляет нужную TON Connect capability, это не ошибка платежа:
checkout обязан сохранить QR/deeplink/manual instruction. Нельзя отмечать wallet
как проверенный, пока реальная подпись и on-chain receipt не завершены.

## Safe stop

При инциденте выключить только новую выдачу USD₮/public default и очистить canary
allowlist. Уже выданные attempts остаются sticky. Rate, оба scanner, settlement,
sweep и webhook workers продолжают работать до terminal/recovery состояния.
Нельзя удалять movement/allocation/outbox rows или повторно подписывать uncertain
SENT jobs; такие случаи разбираются через admin recovery.

## Принятые остаточные риски

- Merchant несёт GRAM rate risk в 24-часовом partial window.
- Политика 1 USD₮ = 1 USD игнорирует depeg.
- CoinGecko и TON Center пока single providers; snapshot — ближайшая
  предшествующая цена с шагом worker, не биржевой tick.
- Один deposit secret контролирует производные deposit wallets и gas address.
- Один admin account не предоставляет RBAC.
- Unsupported jetton spam остаётся в recovery до ручной обработки.
- Terminal addresses сканируются редко, поэтому late payment может появиться в
  admin с задержкой до суток.
- Главные rollout-риски — gas-funded sweep и additive миграция живой ledger DB;
  именно поэтому live canary и clean+legacy rehearsal обязательны.
