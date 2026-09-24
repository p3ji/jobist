# Jobist

Jobist is an accessible, browser-based job-search assistant inspired by
[`p3ji/ai-job-search-ca`](https://github.com/p3ji/ai-job-search-ca). It turns a
candidate's confirmed experience and a job description into a transparent fit
report, an evidence-grounded résumé draft, and a cover letter draft.

This vertical slice is deliberately dependency-free. Personal workspace data
stays in browser local storage. Users can connect their own Google Gemini API
key for document extraction, fit evaluation, and evidence-grounded drafting;
the key is held only in tab memory and passed through the included ephemeral
proxy for each request. Jobist does not submit applications or send messages.

## Run

From this directory run:

```powershell
python server.py
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

## AI connection and privacy

Use **Connect AI** and provide a Gemini API key. Jobist does not save the key in
local storage or logs. The browser sends it to the local Jobist proxy for each
request, and the proxy forwards the request to Google without storing either.

Google's own data-use and retention terms still apply. A user-supplied API key
does not by itself provide zero data retention; the user's plan and enabled
Gemini features determine Google's handling.
