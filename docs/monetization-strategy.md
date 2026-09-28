# Jobist monetization strategy

Research date: 2026-09-28. Prices can change; verify them before launch. All provider prices below are USD unless marked CAD.

## Recommendation

Offer a useful trial, then one simple **CA$15, 30-day Jobist Pass**. The pass is a one-time purchase that does not renew automatically. It includes **30 job discovery scans** and **20 application packets** during its 30 days. No card is needed for the trial. Keep profile editing, saved results, the tracker, exports of already-created work, and account/data deletion available after a pass ends.

The allowance/paywall applies only when **Jobist pays for the AI**. People may bring their own supported API key or run a local model, including Qwen3.8-27B, without paying Jobist or using Jobist AI allowances. Their API provider may charge them; a locally run model uses their own computer. Hosted portal discovery still has fair-use limits to protect source sites and Jobist infrastructure. Never quietly fall back from a personal model to Jobist-funded Gemini or spend a credit without the user's choice.

The free trial includes **five discovery scans and five application packets, once per account**. A scan means one completed click on “Discover jobs from my experience” or “Targeted job search,” including its portal queries, optional rerank, and up to 15 quick AI matches. An application packet begins with one chosen posting's full fit report and includes a tailored résumé, cover letter, and evidence review for that posting. The packet is used when the fit report succeeds, even if the user decides not to draft. A pasted external posting can use a packet without consuming a scan. “Apply” must mean *prepare an application for the user's review*, never submit it on their behalf. Show the remaining balance and consumption rule before a charged action.

Reserve an allowance when work starts and settle it when usable results are delivered. Failed provider requests, blocked output, and retries do not consume another user allowance. Editing, downloading, re-opening, and saving an existing packet are free. Refreshing AI matches for the same scan should be included once; subsequent refreshes need a clear limit to prevent unbounded spend. A plan should never silently switch a user to a more expensive model.

This is a price hypothesis, not a proven willingness-to-pay result. Test it with 10–20 invited users and actual metered workflows before enabling payment. Do not promise unlimited AI at launch.

## Cost research

| Cost | Current public price | Implication |
| --- | --- | --- |
| Cloudflare Workers | Free: 100,000 Worker requests/day. Paid: US$5/month minimum including 10 million requests and 30 million CPU ms/month; extra requests US$0.30/million and CPU US$0.02/million ms. Static asset requests are free. [Source](https://developers.cloudflare.com/workers/platform/pricing/) | Hosting is a small fixed cost at early volume; upstream AI and abuse exposure matter more. |
| Cloudflare D1, if accounts/usage ledger are added | Free: 5 million rows read and 100,000 rows written/day. Paid Workers include 25 billion rows read and 50 million rows written/month, then US$0.001/million reads and US$1/million writes. [Source](https://developers.cloudflare.com/workers/platform/pricing/) | A small ledger should fit included usage; it still requires proper schema, backup, and deletion design. |
| Gemini 2.5 Flash, the current hosted default | Paid API: US$0.30/million input tokens and US$2.50/million output tokens (including thinking tokens). [Source](https://ai.google.dev/gemini-api/docs/pricing) | Budget using paid rates even if development happens on a free quota. |
| Gemini 3.5 Flash-Lite, the active plan's proposed default | Paid API: US$0.30/million input tokens and US$2.50/million output tokens. [Source](https://ai.google.dev/gemini-api/docs/pricing) | Same list price as current 2.5 Flash; quality and latency must be tested before switching. |
| Gemini 3.5 Flash, possible higher-quality drafting model | Paid API: US$1.50/million input tokens and US$9/million output tokens. [Source](https://ai.google.dev/gemini-api/docs/pricing) | Reserve it for stages where evaluations demonstrate a material quality gain. |
| Cohere Rerank | Production use requires a production key; trial keys are not permitted for commercial production. A search unit is one query over up to 100 documents, with long documents split into more units. The current public page does not give a clear pay-as-you-go price for `rerank-v3.5`; get a production quote or disable it. [Pricing](https://cohere.com/pricing), [rate limits](https://docs.cohere.com/v2/docs/rate-limits) | Treat rerank as an unpriced variable until confirmed; keyword fallback already exists. |
| Stripe Canada, if used for the pass | Domestic online card: 2.9% + CA$0.30 per successful payment. One-off Stripe Checkout is included in payment pricing. [Payments](https://stripe.com/en-ca/pricing), [Checkout](https://stripe.com/en-ca/payments/checkout) | CA$15 yields **CA$14.27 after card processing** (before tax, refunds, FX, and operating costs). A recurring subscription would also need its own Billing pricing review. |
| Resend, if used for email sign-in | Free plan currently includes 3,000 emails/month and 100/day; Pro starts at US$20/month for 50,000 emails. [Source](https://resend.com/pricing) | Passwordless accounts add an email dependency. Rate limit code requests and monitor delivery before scaling. |

Domain registration, support, tax, refunds, fraud, analytics, and any paid job-data license are not in that infrastructure estimate. Cloudflare and provider charges may be billed in USD while the proposed customer price is CAD.

### Illustrative unit economics, not measured usage

The current code can make one AI planning call for an exploratory scan, up to four quick-match calls for 15 jobs (batches of four), one full fit call, and two drafting/review calls. It can also make one Cohere rerank call and multiple portal/detail requests. Profile extraction is extra and can be amortized over many packets. See `app.js` and `cloudflare/worker.mjs`.

At an **assumed** 30,000 input and 8,000 output tokens for one complete search-and-packet journey, Gemini 2.5 Flash or 3.5 Flash-Lite costs **US$0.029**: 30,000/1,000,000 × $0.30 + 8,000/1,000,000 × $2.50. If 10,000 input and 4,000 output tokens of that journey instead use Gemini 3.5 Flash for drafting/review, the total becomes about **US$0.067**. These are scenario calculations, not observed bills; actual output reasoning tokens, retries, PDF input, and prompt sizes can change them substantially. They exclude Cohere and payment fees.

For a rough pass-level check, assume *each* scan and packet uses half that journey's tokens (15,000 input and 4,000 output). All 30 scans and 20 packets would then cost about **US$0.73 in Gemini usage** at Flash-Lite rates. That is a sensitivity example, not a forecast; measure the two actions separately before relying on it. Support, payment fees, and acquisition will likely matter more than nominal AI tokens at this scale.

Before pricing is final, record provider-reported input/output tokens and model per stage for at least 100 successful journeys, plus failures and retries. Calculate median, p95, and maximum provider cost for scans, direct-posting fit, extraction, and completed packets separately. Set an account-level and monthly provider spend cap. Keep a cost ceiling per action and refuse unexpectedly large document or posting inputs with a helpful message.

## Competitor anchor

| Product | Advertised price, USD | Free offer / paid scope |
| --- | --- | --- |
| [Teal](https://www.tealhq.com/pricing) | $29 per 30 days, also $13 per 7 days | Free tracking and limited AI credits; Teal+ advertises unlimited generation and more analysis. |
| [Rezi](https://www.rezi.ai/pricing) | $29/month | Free plan includes one résumé and limited downloads; Pro advertises unlimited AI and résumés. |
| [Huntr](https://api.huntr.co/pricing) | $40/month | Free plan includes two tailored résumés and two application packets; Pro advertises unlimited AI credits. |

Jobist's CA$15 pass would sit below those **USD** monthly list prices, with clearer usage limits and no automatic renewal. The differentiated promise is evidence-grounded help from discovery through an editable application, including a way to paste a posting. Do not claim better interview outcomes without data.

## Implementation gates

The executable handoff, including API contracts, D1 schema, accounting rules, purchase lifecycle, and acceptance tests, is in [Monetization implementation handoff](monetization-implementation-plan.md).

1. **Measure first.** Add stage-level provider usage and cost telemetry without logging résumés, posting text, API keys, or generated drafts. Remove `envKeys` from the public `/api/ai/config` response. Use a production Google billing account; Google's pricing table says free-tier content may be used to improve its products, while paid-tier content is not. Explain provider processing plainly to users. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
2. **Enforce allowances on the server.** Today `app.js` stores workspace state in the browser and the hosted Worker accepts AI calls through public endpoints using the server key. A browser counter or hidden button is not a paywall. Add low-friction account identity, server-side entitlements, an atomic usage ledger, rate limits, bot/abuse protection, idempotency keys, and a model allowlist before selling passes. Check authorization for `/api/ai`, `/api/jobs/scan`, `/api/jobs/detail`, and `/api/jobs/rerank`; direct API calls must not bypass quotas. Keep personal Gemini keys and local LM Studio usage separate from Jobist-paid allowances.
3. **Define purchase behavior.** Use hosted Checkout, verify payment by webhook, then issue the pass to the account. State start/end dates, balances, tax at checkout, refund policy, and that the pass does not renew. Keep purchased work accessible after expiry. Make a failed or abandoned workflow resumable without charging twice.
4. **Validate source and provider terms.** Confirm that each portal permits this style of automated querying and commercial reuse; obtain a production Cohere price and key before including rerank in paid cost projections. The product can fall back to keyword ranking if Cohere is unavailable.
5. **Pilot and adjust.** Invite 10–20 users. Track free users who complete a packet, trial-to-pass conversion, median/p95 cost per delivered packet, provider failure rate, pass usage, refunds, and support time. Revisit the CA$15 price and 30/20 limits after real usage. If few users exhaust the free trial, improve workflow value and clarity before moving the paywall earlier.
