# Jobist

Jobist is an accessible, browser-based job-search assistant inspired by
[`p3ji/ai-job-search-ca`](https://github.com/p3ji/ai-job-search-ca). It turns a
candidate's confirmed experience and a job description into a transparent fit
report, an evidence-grounded résumé draft, and a cover letter draft.

The intended GUI journey follows the source project's three stages:

1. **Build a profile.** Bring career evidence into Jobist, review extracted
   facts, and confirm what the AI may use.
2. **Find jobs.** Search for and shortlist roles that fit the confirmed profile.
3. **Prepare an application.** Check fit and eligibility, draft a tailored
   résumé and cover letter, review both, and track the application. Jobist never
   submits an application for the user.

### What the GUI supports today

| Stage | Available now | Still to build |
| --- | --- | --- |
| Profile | Guided form and one document at a time for AI fact extraction; the user edits and confirms the result. | Combine multiple sources such as a CV, LinkedIn export, diplomas, references, and past applications; paste a CV as a dedicated import path; guided profile interview; source records for each fact. |
| Find jobs | Paste a job description and enter its company, role, and location. A posting URL can be saved as a reference. | Search job boards, deduplicate listings, rank matches, and open a selected result in the application flow. The current URL field does not fetch a posting. |
| Prepare application | AI fit report with gates, tailored résumé and cover-letter drafts, a separate review pass, editable output, print/save as PDF, and a local tracker. | Fuller document formatting and export checks comparable to the source framework. Sending or submitting remains a user action outside Jobist. |

This is the first working slice of that journey. It does not yet reproduce the
source project's `/scrape` job search or all three `/setup` intake paths.

This vertical slice is deliberately dependency-free. Personal workspace data
stays in browser local storage. Users can select a local LM Studio model or
connect their own Google Gemini API key for document extraction, fit evaluation,
and evidence-grounded drafting. Gemini keys are held only in tab memory and
passed through the included ephemeral proxy. Jobist does not submit
applications or send messages.

## Run

From this directory run:

```sh
python3 server.py
```

Then visit `http://localhost:8080`.

Open `http://localhost:8080/?demo=1` to jump directly into an example fit
report.

## Included

- Mobile-first, keyboard-accessible interface
- Guided profile setup and editable evidence cards
- AI extraction from PDF, Word, and text career documents
- Job-description intake and transparent fit scoring
- Eligibility, language, and logistics flags
- AI-generated, evidence-linked résumé and cover-letter drafting
- Printable/PDF-ready application view
- Application tracker
- Local JSON export and complete local-data deletion

The target hosted architecture is documented in
[`docs/architecture.md`](docs/architecture.md).

## Hosted site

The Cloudflare Worker deployment is configured for `https://jobist.peji.ca/`.
It serves the browser interface and proxies Gemini requests without storing
the user's API key. The hosted site offers Gemini; Local AI requires running
this repository and LM Studio together on the same computer. The hosted site
does not yet support a local-model bridge from a visitor's computer.

Run `python3 scripts/build_hosted.py` after changing `index.html`, `style.css`,
or `app.js`, then commit the updated `dist/` files. Cloudflare builds the
connected `main` branch with `npx wrangler deploy`. To deploy from this computer
immediately, run `npx wrangler deploy` after building the assets and
authenticating Wrangler with the Cloudflare account that owns `peji.ca`.

## AI connection and privacy

Use **Connect AI** to choose a provider. For **Local AI**, install and open
[LM Studio](https://lmstudio.ai/), download a generation model, and start its
server in the Developer tab or run `lms server start --port 1234 --bind 127.0.0.1`.
Then choose one of the models Jobist lists. Jobist and LM Studio must run on
the same computer. This local option cannot be reached from a remotely hosted
Jobist site through a visitor's `localhost`.

Local document extraction currently reads `.txt`, `.md`, and `.docx`. For PDF
or legacy `.doc`, enter facts in the profile form or use Gemini. Always review
extracted facts before confirming them. A local model can still produce errors;
Jobist blocks drafts with uncited claims or changed dates and numbers, and you
must review the rest of the text.

For **Gemini**, enter your API key. Jobist does not save it in local storage or
logs. The browser sends it to the local Jobist proxy for each request, and the
proxy forwards the request to Google without storing either. Switching
providers is explicit; a failed request is never silently sent elsewhere.

Google's own data-use and retention terms still apply. A user-supplied API key
does not by itself provide zero data retention; the user's plan and enabled
Gemini features determine Google's handling.
