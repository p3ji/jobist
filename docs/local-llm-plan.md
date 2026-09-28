# Local AI option for Jobist

Status: LM Studio provider selection and the core proxy are implemented.
Remaining work is listed below, especially PDF extraction, stronger grounding
checks, and a complete browser regression suite.

## Goal and boundary

Let a user choose **Local AI (LM Studio)** for profile extraction, fit evaluation,
and drafting when they have no Gemini key or prefer local processing. Keep the
example flow separate. The initial implementation runs Jobist's Python server
and LM Studio on the **same computer**. A remotely hosted Jobist server cannot
reach LM Studio on a visitor's `localhost`; that deployment needs a separate
desktop bridge or a different architecture.

The current Mac has LM Studio and an `lms` CLI. Its API server was available
during the local integration test; Jobist checks availability each time the
connection dialog opens.
Downloaded generation models include Qwen3.8 27B, Qwen3.8 Flash Next,
DeepSeek V4 Flash, Qwen3.6 35B, and Gemma 4 E4B. The Qwen and DeepSeek entries
are links to the local Hermes model directory; verify that LM Studio can load
them before selecting one. Nomic Embed is an embedding model, not a generation
option. A synthetic end-to-end trial with Gemma 4 E4B completed profile
extraction, fit evaluation, drafting, and review. A model default should be
chosen from measured quality, schema reliability, and latency.

## Implementation sequence and progress

1. **Add a provider choice and health check — implemented.** The connection dialog
   offer Gemini or Local AI. Add a read-only server endpoint that checks
   LM Studio at a fixed `127.0.0.1:1234` address, lists available generation
   models, and reports whether its API is available. Never accept an arbitrary
   base URL from the browser. Show the selected provider and model in the workspace.
   When no Gemini key is supplied, offer Local AI if the health check passes;
   otherwise explain how to start the LM Studio server. Keep selection in tab memory.

2. **Use one AI request contract — implemented.** `callAi()` in `app.js` sends the
   same `{prompt, schema, file}` request for both providers and return the same
   parsed `output` shape. Route it through a server-side provider adapter in
   `server.py`. The Gemini path keeps its session-only key handling. The local
   path calls LM Studio's `POST /v1/chat/completions` with `stream: false` and
   `response_format: {type: "json_schema", json_schema: {name, schema}}`.
   Decode `choices[0].message.content` as JSON and validate it
   against the same application rules before storing or rendering anything.
   Use a separate `provider` field so a missing Gemini key never silently
   selects a different destination.

3. **Make document extraction work locally — partial.** The Gemini path sends
   PDF and Word bytes directly to Gemini. Extract text before calling the local
   model. `.txt`, `.md`, and `.docx` work via Python's standard library.
   Add PDF text extraction with a clearly documented local parser dependency
   and handle scanned PDFs separately with OCR or a tested vision model.
   Treat legacy `.doc` as unsupported locally until a reliable local converter
   is available. Report unsupported or image-only files clearly and keep the
   manual profile form usable. Limit input size and extracted text length.

4. **Keep evidence checks provider-independent — partial.** Reuse the current profile
   confirmation, gate display, drafter/reviewer stages, and evidence markers.
   Strengthen draft validation so valid evidence IDs alone do not count as
   proof that the cited text supports a claim. At minimum, block missing or
   invalid citations and show a review warning for claims that cannot be
   mechanically checked; add targeted tests with unsupported dates, metrics,
   credentials, and prompt-injection text in job descriptions.

5. **Define fallback behavior in the UI — implemented.** If Gemini is unconfigured, offer
   Local AI as an explicit choice. If Gemini fails after a request starts,
   show the error and ask the user to switch; do not resend sensitive data to
   another provider automatically. Record the provider and model on each fit
   report and draft so a saved artifact remains understandable later.

6. **Test and document the full flow — partial.** A synthetic real-model trial
   completed profile extraction, fit evaluation, drafting, review, and tracker
   save with Gemma 4 E4B. The interface was inspected at 375px, and the server
   tests cover the fixed local endpoint, schema validation, and unsupported
   files. Add automated browser regression coverage for both providers, keyboard
   use, LM Studio offline/timeout behavior, and confirmation that local mode
   makes no Gemini request. Document model choice and expected latency after
   comparative Jobist workflow trials.

## Security and privacy details

Bind Jobist and LM Studio to loopback for this version. Restrict the local proxy
to the fixed LM Studio host/port, reject unexpected model names using the
installed-model list, cap requests and responses, and avoid logging career
content. Keep the Origin check on Jobist's POST route. Verify that each selected
model is a downloaded local model before promising offline processing. Do not
turn on LM Studio's network serving or browser CORS for this integration.

## Acceptance criteria

- A user with no Gemini key can select a listed local model and complete the
  profile → job → fit → reviewed draft flow.
- All local-mode AI calls remain on the same computer; unsupported file types
  fail with a clear message and manual entry remains available.
- Provider errors and malformed JSON leave the user's confirmed profile and
  prior drafts intact.
- Gemini still works with its key only in tab memory, and switching providers
  never happens without the user's choice.
