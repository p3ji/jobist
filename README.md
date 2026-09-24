# Jobist

Jobist is an accessible, browser-based job-search assistant inspired by
[`p3ji/ai-job-search-ca`](https://github.com/p3ji/ai-job-search-ca). It turns a
candidate's confirmed experience and a job description into a transparent fit
report, an evidence-grounded résumé draft, and a cover letter draft.

This first vertical slice is deliberately zero-dependency. Personal information
stays in the browser's local storage, and the built-in drafting engine is clearly
labelled as demo mode. It does not send data, submit applications, or invent
experience.

## Run

Open `index.html` directly, or from this directory run:

```powershell
python -m http.server 8080
```

Then visit `http://localhost:8080`.

Open `http://localhost:8080/?demo=1` to jump directly into an example fit
report.

## Included

- Mobile-first, keyboard-accessible interface
- Guided profile setup and editable evidence cards
- Job-description intake and transparent fit scoring
- Eligibility, language, and logistics flags
- Evidence-linked résumé and cover-letter drafting
- Printable/PDF-ready application view
- Application tracker
- Local JSON export and complete local-data deletion

The target hosted architecture is documented in
[`docs/architecture.md`](docs/architecture.md).
