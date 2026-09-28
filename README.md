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
| Profile | Upload several documents or choose a folder, paste one CV, answer a four-step guided interview, or type directly. AI extracts facts from supported files into a reviewable form. Additional documents add new facts; repeated files are skipped by checksum. Education has its own field, and conflicting details are shown for comparison. | Detailed source spans for each fact and automatic import from external accounts. |
| Find jobs | AI plans several search directions from confirmed work and skills, including transferable functions outside known titles. Jobist searches Job Bank and Freehire, then gives up to 15 readable postings a quick AI High/Medium/Low match estimate. A specific keyword search remains available. The candidate can also paste a posting. | Add more portals, broader search strategies, and source health monitoring. |
| Prepare application | AI fit report with gates, tailored résumé and cover-letter drafts, a separate review pass, editable output, print/save as PDF, and a local tracker. | Fuller document formatting and export checks comparable to the source framework. Sending or submitting remains a user action outside Jobist. |

Target roles and career goals are optional. You can confirm your experience
without knowing your next title, then discover opportunities or paste a job
posting to explore its fit.
When both fields are blank, Jobist shows career direction as not assessed and
calculates the overall score from skills, experience, and work style only. The
job step plans multiple search directions from confirmed experience and
skills, with each direction linked to evidence. This follows the original tool's
search setup, where multiple work categories guide discovery. Select
**Discover matching jobs** to search those directions automatically, or open
the specific title or keyword search for a focused query. AI planning and
matching need a connected provider. The scan's High/Medium/Low estimate is a
quick screen using confirmed profile evidence and job descriptions, not the
full fit report. Listings without
readable descriptions remain unrated. Open and verify each original posting;
some sources do not expose the full description, so you may need to paste it.
Select one job and get the full fit report before drafting an application.

This is the first working slice of that journey. The scan covers two public
Canadian sources; it does not yet reproduce the source project's full `/scrape`
portal coverage. A browser cannot read a local `documents/` folder without the
user choosing it, so Jobist offers a folder picker on desktop.

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
On a Mac, you can instead double-click `Start Jobist.command` in this folder;
keep its window open while using the local server.

Open `http://localhost:8080/?demo=1` to jump directly into an example fit
report.

## Included

- Mobile-first, keyboard-accessible interface
- Guided profile setup and editable evidence cards
- AI extraction from PDF, Word, and text career documents
- Live Canadian job scan through Job Bank and Freehire, with quick AI fit tiers,
  source links, and an option to review a result in the application workflow
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

Local document extraction currently reads PDF, Word (.docx), `.txt`, `.md`, `.tex`, and `.csv`. A
`.tex` file is read as source text; files referenced with `\input` are not
loaded. For legacy `.doc`, enter facts in the profile form or use Gemini. Always review
extracted facts before confirming them. A local model can still produce errors;
Jobist blocks drafts with uncited claims or changed dates and numbers, and you
must review the rest of the text.

For **Gemini**, Jobist defaults to **Gemini 3.5 Flash-Lite** for fast, high-throughput
free-tier usage. When running on a server or hosted site where `GEMINI_API_KEY` is
configured (e.g. Cloudflare Worker secrets or local environment), Jobist works
immediately out of the box with the default Free Tier. You can also enter your own
API key in Connect AI to use personal quota. Choose files and select **Read documents with AI**;
simply connecting the key or choosing files does not start extraction. `.tex`, `.md`,
`.txt`, and `.csv` files are sent as text, while PDFs are forwarded natively. Jobist does
not save keys in local storage or logs.

For **Job search ranking**, Jobist optionally uses **Cohere Rerank** (`rerank-v3.5`)
when `COHERE_API_KEY` is configured, providing deep semantic relevance scoring across
scraped job leads. If unconfigured, Jobist smoothly falls back to its built-in keyword priority.

Google's and Cohere's own data-use and retention terms apply to external API requests.
A user-supplied or default API key does not by itself provide zero data retention; the
provider's plan and enabled features determine upstream handling.

