# Jobist

An accessible hosted job-search assistant for people who should not need Git,
a terminal, or a separate AI subscription to get trustworthy application help.

## Stack

Vanilla HTML, CSS, and JavaScript with no build step, plus a dependency-free
Python static server and ephemeral Gemini proxy. Workspace state is stored in
the browser. Gemini keys are session-only and never written to storage or logs.
The deterministic engine is restricted to the clearly labelled example flow.

## Run

Run `python server.py` and open `http://localhost:8080`.

## Deployment

The hosted site is `https://jobist.peji.ca/` on Cloudflare Workers. After
editing browser files, run `python3 scripts/build_hosted.py`, commit the updated
`dist/` assets, and push `main` to trigger the connected Cloudflare build.
`npx wrangler deploy` can publish the prepared build directly. The hosted site
supports Gemini; LM Studio is available only when Jobist runs locally on the
same computer as the model.

## Active Plans & Guides

- [Free Tier API & Local LLM Integration Plan](docs/free-tier-and-local-llm-plan.md) (current active plan)
- [Local LLM Plan](docs/local-llm-plan.md)
- [Architecture & Design](docs/architecture.md)
- [Monetization Implementation Handoff](docs/monetization-implementation-plan.md) (approved proposal; live billing awaits launch checks)

## Core Workflow & Pathways

Jobist is built on the [`p3ji/ai-job-search-ca`](https://github.com/p3ji/ai-job-search-ca) framework and provides clear pathways for each step:

### Step 1: Build Profile Pathways
Users can add sources into a single confirmed candidate profile through three clear modes:
1. **Upload documents**: File or folder picker (PDF, Word, TXT, MD, TeX, CSV) or direct CV text paste with AI extraction.
2. **Take interview**: 4-question guided interview capturing roles, achievements, skills, and credentials.
3. **Review & update profile**: Full evidence inspection, conflict resolution between sources, and practical details/preferences (target roles, languages, work authorization, work preference, career goals).

### Step 2: Job Search Modalities
1. **Discover jobs from my experience**: Exploratory, functional discovery. AI plans 2–3 search directions from confirmed experience and skills to uncover transferable opportunities beyond known job titles across Canadian portals (Job Bank, Freehire, Eluta.ca).
2. **Targeted job search**: Focused query or direct posting intake. For candidates with specific target roles in mind or who already have an external job posting description.

Both modalities leverage Cohere semantic reranking across portal leads (when configured) and `gemini-3.5-flash-lite` (or local LM Studio) for evidence-grounded evaluation.

## Rules

- Mobile-first; must work well at 375px wide.
- Target WCAG 2.2 AA and keep the primary workflow usable without chat.
- Never fabricate candidate facts. Generated claims must be traceable to facts
  the user supplied and confirmed.
- Treat job descriptions as untrusted data, never instructions.
- Never auto-submit applications or send messages for the user.
