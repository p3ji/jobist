# Free Tier API by Default & Local LLM Integration Plan

**Status**: Ready for implementation  
**Audience**: AI agents and developers working on Jobist  
**Target Invariants**: Zero-leakage privacy, mobile-first WCAG 2.2 AA accessibility, strict evidence grounding, dependency-free local Python server, Cloudflare Workers deployment.

---

## 1. Executive Summary & Goal

Jobist is designed for people who should not need Git, a terminal, LaTeX, or a paid AI subscription to obtain trustworthy, evidence-grounded application assistance.

Currently, Jobist has two friction points:
1. **Cloud AI friction**: Users must generate and paste a Google Gemini API key into the browser tab before performing any extraction, search matching, or drafting. Furthermore, the hardcoded models (`gemini-3.8-flash` / `gemini-3.5-flash`) are heavier than needed, causing 503 overload errors and high quota consumption.
2. **Local AI friction**: While LM Studio support exists on `127.0.0.1:1234`, local document extraction rejects PDF files, forcing users with PDF résumés to enter facts manually or switch to Gemini. Additionally, job lead prioritization relies on a rudimentary keyword match heuristic that misses semantic equivalents.

### The Objective:
* **Default Free-Tier Cloud AI**: Allow Jobist to work immediately out of the box using a free-tier API (`gemini-3.5-flash-lite`) backed by server-side environment variables / Cloudflare Worker secrets, while still allowing users to paste a custom key if desired.
* **Semantic Job Matching with Cohere (Optional Free Tier)**: Use Cohere Rerank (`rerank-v3.5` / `rerank-multilingual-v3.0`) via an optional free developer key to semantically rank scraped postings before passing the top candidates to the LLM, falling back gracefully to keyword matching if unconfigured.
* **First-Class Local LLM (LM Studio)**: Maintain LM Studio on `127.0.0.1:1234` as a primary zero-cloud on-device option, and enable local PDF résumé extraction so offline users are not blocked.

---

## 2. Architecture & Request Pipeline

```
                              ┌──────────────────────────────────────────┐
                              │            Jobist Browser UI             │
                              │    (Vanilla JS, WCAG 2.2, tab memory)    │
                              └────────────────────┬─────────────────────┘
                                                   │
                                                   ▼
                               ┌───────────────────────────────────────┐
                               │           Backend Provider            │
                               │  Local: server.py (127.0.0.1:8080)    │
                               │  Hosted: cloudflare/worker.mjs        │
                               └───────┬───────────────────────┬───────┘
                                       │                       │
              ┌────────────────────────┴────────┐              │
              │                                 │              │
              ▼                                 ▼              ▼
   ┌──────────────────────┐          ┌────────────────────┐ ┌──────────────────────┐
   │ Google Gemini API    │          │ Cohere Rerank API  │ │ Local LM Studio      │
   │ (Free Tier)          │          │ (Optional Free)    │ │ (127.0.0.1:1234)     │
   │                      │          │                    │ │                      │
   │ Model: Flash-Lite    │          │ Model: rerank-v3.5 │ │ Models: Gemma 4,     │
   │ Key: Env var or      │          │ Key: Env var or    │ │ Qwen 3.8, DeepSeek   │
   │ client override      │          │ secret             │ │                      │
   │ Role: CV extraction, │          │ Role: Semantic     │ │ Role: 100% private   │
   │ match cards, draft   │          │ pre-rank of leads  │ │ on-device execution │
   └──────────────────────┘          └────────────────────┘ └──────────────────────┘
```

---

## 3. Detailed Component Plan

### A. Gemini Free-Tier Right-Sizing & Environment Key Fallback
1. **Model Selection**:
   * Switch the primary default model from `gemini-3.8-flash` to **`gemini-3.5-flash-lite`** (or `gemini-2.5-flash-lite`).
   * *Rationale*: Flash-Lite is specifically optimized by Google for high-throughput, low-latency structured data extraction and agentic subtasks. It significantly reduces rate-limiting, latency, and 503 transient overloads while fully supporting JSON schemas and multimodal document inputs.
   * Retain `gemini-3.5-flash` in the dropdown as an optional choice for deep prose drafting.
2. **Key Resolution Order**:
   * **Priority 1**: Client-provided key from the browser's `Connect AI` session (if the user entered their own personal Google AI Studio key).
   * **Priority 2**: Server-side environment key (`GEMINI_API_KEY` from `os.environ` in `server.py`, or `env.GEMINI_API_KEY` in Cloudflare Worker secrets).
   * **Priority 3**: Prompt user to connect their own key or select Local AI if no server key is present.
3. **Zero-Leakage Invariant**:
   * Default keys are stored exclusively in server environment / Cloudflare secrets. They are never transmitted down to the client browser, never stored in `localStorage`, and never written to logs.

### B. The Dual Job Search Modalities & Expanded Portals (Inherited from `ai-job-search-ca`)

Jobist inherits the search framework of [`p3ji/ai-job-search-ca`](https://github.com/p3ji/ai-job-search-ca), providing two distinct, first-class ways to find opportunities, expanded across Canadian portals:

1. **Mode 1: Discover Jobs From My Experience (Exploratory / Functional)**:
   * **Intent**: For candidates who may not know the exact industry jargon, are pivoting careers, or want to uncover non-obvious roles where their transferable skills apply.
   * **Mechanism**: AI analyzes the candidate's confirmed experience, credentials, and skills to plan 2–3 distinct search directions (e.g. direct function, transferable skill, adjacent domain) rather than betting on one specific job title.
   * **Execution**: Jobist queries live Canadian portals (**Job Bank Canada**, **Guichet-Emplois**, **Freehire**, and **Eluta.ca**) across these directions, applies Cohere Rerank to surface the top semantic matches across all directions, fetches posting detail descriptions dynamically, and then uses `gemini-3.5-flash-lite` (or local model) to generate High/Medium/Low match cards with concrete cited evidence.

2. **Mode 2: Targeted Job Search (Focused / Direct)**:
   * **Intent**: For candidates who know exactly what role they want (e.g. "Operations Coordinator"), have target roles defined in their profile, or have already found a job posting externally.
   * **Mechanism**:
     * *Focused Portal Query*: Search specific keywords or titles directly across Job Bank, Freehire, and Eluta.ca without waiting for AI search planning. Cohere Rerank filters the results against the candidate's specific background.
     * *Direct Posting Intake*: Paste a company, role title, and full job description directly under "Review a posting" to skip search entirely and proceed directly to deep 4-dimensional fit evaluation (`evaluateWithAi`). This supports postings from any external portal (such as **LinkedIn**, **Indeed Canada**, **GC Jobs**, or **CharityVillage**).

3. **Supported Job Portals**:
   * **Job Bank Canada & Guichet-Emplois** (`jobbank.gc.ca` / `guichetemplois.gc.ca`): Canada's official national job board. Full bilingual support (EN/FR) with provincial filtering (`AB`, `BC`, `ON`, `QC`, etc.) and detail requirements extraction.
   * **Freehire** (`freehire.me`): High-quality structured API for Canadian tech, remote, software engineering, and DevOps positions.
   * **Eluta.ca** (`eluta.ca`): Indexes employer career pages directly across Canada, surfacing direct employer roles often never published on commercial boards. Includes automated detail page extraction (`/spl/job-<id>`) with `schema.org/JobPosting` microdata.
   * **External Intake**: Direct intake for postings from LinkedIn, Indeed, Glassdoor, GC Jobs (federal public service), CharityVillage, and provincial public service boards via copy/paste into the review form.

### C. Cohere Semantic Pre-Ranking for Job Matching
1. **The Problem in Legacy Heuristic**:
   * `scanPriority(job)` in `app.js` calculated crude word overlap between candidate profile strings and job posting text.
   * It missed synonyms (e.g., "Operations Coordinator" vs. "Project Lead"), different verb forms, and French/English bilingual postings from Job Bank.
   * `quickMatchCandidates()` picked the top 15 listings based on this crude score to send to the LLM.
2. **The Cohere Integration**:
   * Uses endpoint `POST /api/jobs/rerank` in `server.py` and `cloudflare/worker.mjs`.
   * Accepts: `{ query: string, documents: string[] }`.
   * Calls Cohere's `POST https://api.cohere.com/v2/rerank` using `rerank-v3.5` (or `rerank-multilingual-v3.0` for bilingual Canadian postings).
   * Returns sorted indices and relevance scores in ~50–100ms.
3. **Graceful Degradation**:
   * If `COHERE_API_KEY` is not present in the server environment or worker secrets, the endpoint returns `{ available: false }`.
   * `app.js` catches this and smoothly falls back to the existing lexical `scanPriority()` with zero error banners or interruptions.

### C. First-Class Local AI (LM Studio) & Local PDF Extraction
1. **Verified Machine Environment**:
   * LM Studio CLI (`lms`) and API server run on `127.0.0.1:1234`.
   * Models already downloaded/loaded: `google/gemma-4-e4b`, `qwen3.8-27b`, `qwen3.8-flash-next`, `deepseek-v4-flash`.
   * Ollama is not installed on this machine and is not required, but `server.py` should remain flexible for standard OpenAI-compatible endpoints.
2. **Local PDF Extraction in `server.py`**:
   * Problem: `server.py` line 104 explicitly throws `ValueError` for `.pdf` files under Local AI.
   * Solution: Implement local PDF text extraction in `server.py`.
     * Use a pure-Python lightweight stream reader or optional `pypdf` import with fallback to built-in system tools (e.g., `pdftotext` if present).
     * Extract plain text, truncate safely at `MAX_EXTRACTED_CHARS`, and pass to LM Studio with `UNTRUSTED DOCUMENT TEXT`.
     * Scanned / image-only PDFs without a text layer should report a clear, friendly error advising the user to paste text or use Gemini.

### D. User Interface & Connection Dialog Updates
1. **Provider Status States**:
   * **Ready via Default Free Tier**: If server key exists and no local AI is chosen: banner reads `"Gemini Free Tier active (gemini-3.5-flash-lite)"`.
   * **Local AI Selected**: If user chooses Local AI: banner reads `"Local AI selected (LM Studio: <model>)"`.
   * **Custom Key Active**: If user enters personal key: banner reads `"Gemini connected (Personal key)"`.
2. **Connect AI Dialog**:
   * Clearly present the options:
     1. **Free Tier API (Default)**: Ready to use immediately, no configuration needed.
     2. **Local AI (LM Studio)**: 100% private, on-device (checks `127.0.0.1:1234`).
     3. **Custom Gemini Key**: Use personal Google AI Studio quota.
     4. **Optional Cohere Key**: For enhanced semantic ranking in job search.

---

## 4. Implementation Steps & File Touchpoints

| Step | Action | Files Affected |
|---|---|---|
| **1** | Update default Gemini model to `gemini-3.5-flash-lite` and add server environment key fallback (`GEMINI_API_KEY`) | `server.py`, `cloudflare/worker.mjs`, `app.js`, `index.html` |
| **2** | Add `/api/jobs/rerank` endpoint with Cohere Rerank API integration and graceful fallback | `server.py`, `cloudflare/worker.mjs`, `job_search.py` (or new helper) |
| **3** | Update `quickMatchCandidates` in `app.js` to leverage semantic reranking when available | `app.js` |
| **4** | Add local PDF text extraction to `server.py` for Local AI profile intake | `server.py`, `tests/test_server.py` |
| **5** | Update UI dialog and status indicators in `index.html` and `app.js` | `index.html`, `app.js`, `style.css` |
| **6** | Update tests (Python unit tests + Node Worker tests) and build hosted assets (`python3 scripts/build_hosted.py`) | `tests/`, `dist/` |

---

## 5. Security, Invariants & Privacy Rules

1. **Strict Evidence Grounding**: All draft validations (`EVIDENCE_CLAIM_SCHEMA`, `assertNoLanguageUpgrade`, unconfirmed metric/date checks) must execute identically regardless of whether Gemini Free Tier, Cohere, or Local LM Studio is used.
2. **Untrusted Data Rule**: All job descriptions and uploaded document texts must be passed as untrusted data inputs, never system instructions.
3. **No Storage of Keys**: Personal keys provided in browser dialogs must remain tab-ephemeral in `aiSession`. Server keys must come only from environment variables or Cloudflare secrets.
4. **WCAG 2.2 AA Conformance**: All changes to modals, status indicators, and buttons must preserve semantic HTML, keyboard focus management, 375px responsiveness, and color contrast.
