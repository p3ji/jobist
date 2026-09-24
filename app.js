(() => {
  "use strict";

  const STORAGE_KEY = "jobist.prototype.v1";
  const VIEWS = ["profile", "job", "fit", "drafts", "tracker"];
  const STOP_WORDS = new Set("about after again against also and are because been being between both but can could does doing each for from further had has have having her here herself him himself his how into its itself just more most other our ours ourselves out over own same she should some such than that the their theirs them themselves then there these they this those through too under until very was were what when where which while who whom why will with would you your yours yourself yourselves role work working team teams candidate candidates experience years required preferred including responsibilities qualifications company position opportunity looking strong skills skill ability support using use".split(" "));

  const emptyState = () => ({
    profile: null,
    job: null,
    evaluation: null,
    drafts: null,
    applications: [],
    currentView: "profile",
    updatedAt: new Date().toISOString(),
  });

  const exampleState = () => ({
    ...emptyState(),
    profile: {
      name: "Maya Chen",
      headline: "Operations & Project Coordinator",
      email: "maya.chen@example.com",
      location: "Toronto, ON",
      skills: "Project coordination\nExcel and performance reporting\nClient communication\nProcess improvement\nCross-functional collaboration",
      experience: "Operations Coordinator, Northstar Co., 2022–present — Coordinated 30+ client projects and improved on-time delivery from 82% to 94%.\nProgram Assistant, CityWorks, 2020–2022 — Maintained project schedules, prepared weekly reports, and supported stakeholder meetings.\nVolunteer Lead, Community Pantry, 2019–present — Organize monthly shifts for 25 volunteers.",
      targetRoles: "Project coordinator, Program coordinator, Operations coordinator",
      languages: "English — fluent; Mandarin — fluent; French — conversational",
      authorization: "Citizen or permanent resident",
      workPreference: "Hybrid",
      goals: "Grow into project leadership while doing practical work that improves services for people.",
    },
    job: {
      company: "Cedar Public Services",
      role: "Project Coordinator",
      jobLocation: "Toronto, ON — hybrid",
      url: "",
      description: "We are hiring a Project Coordinator to support cross-functional service improvement projects. The successful candidate will maintain project schedules, prepare performance reports in Excel, coordinate stakeholder meetings, track risks and actions, and communicate with clients. Required: two years of project coordination or related experience, strong written English, Excel, and excellent organizational skills. Preferred: experience with Power BI and public-sector programs. This is a hybrid role based in Toronto. Applicants must be legally entitled to work in Canada.",
    },
  });

  let state = loadState();
  if (new URLSearchParams(location.search).has("demo") && !state.profile) {
    state = exampleState();
    state.evaluation = evaluate(state.profile, state.job);
    state.currentView = "fit";
  }
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = "") => String(value).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const lines = value => String(value || "").split(/\n+/).map(item => item.trim()).filter(Boolean);
  const words = value => String(value || "").toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").split(/\s+/).filter(word => word.length > 2 && !STOP_WORDS.has(word));

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved && typeof saved === "object" ? { ...emptyState(), ...saved } : emptyState();
    } catch {
      return emptyState();
    }
  }

  function saveState(message = "Saved locally") {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const indicator = $("#saveState");
    if (indicator) indicator.textContent = message;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  function showApp(view = "profile") {
    $("#welcomeView").classList.add("is-hidden");
    $("#appView").classList.remove("is-hidden");
    populateForms();
    showView(view, false);
    updateNavigation();
  }

  function canOpen(view) {
    if (view === "profile" || view === "tracker") return true;
    if (view === "job") return Boolean(state.profile);
    if (view === "fit") return Boolean(state.evaluation);
    if (view === "drafts") return Boolean(state.drafts);
    return false;
  }

  function showView(view, announce = true) {
    if (!canOpen(view)) {
      showToast(view === "job" ? "Confirm your profile first." : view === "fit" ? "Add and evaluate a job first." : "Create an application first.");
      return;
    }
    VIEWS.forEach(name => $(`#${name}View`).classList.toggle("is-hidden", name !== view));
    $$(".nav-step").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
    state.currentView = view;
    saveState();
    if (view === "fit" && state.evaluation) renderEvaluation();
    if (view === "drafts" && state.drafts) renderDrafts();
    if (view === "tracker") renderTracker();
    if (announce) {
      const heading = $(`#${view}View h2`);
      heading?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function updateNavigation() {
    $("#profileNavStatus").textContent = state.profile ? "Confirmed" : "In progress";
    $("#jobNavStatus").textContent = state.job ? "Added" : "Not started";
    $("#fitNavStatus").textContent = state.evaluation ? `${state.evaluation.overall}/100` : "Not started";
    $("#draftsNavStatus").textContent = state.drafts ? "Ready" : "Not started";
    $("#trackerNavStatus").textContent = `${state.applications.length} saved`;
  }

  function populateForms() {
    if (state.profile) setFormValues($("#profileForm"), state.profile);
    if (state.job) setFormValues($("#jobForm"), state.job);
  }

  function setFormValues(form, values) {
    Object.entries(values).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value;
    });
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function validateForm(form) {
    $$(".field-error", form).forEach(node => node.remove());
    $$('[aria-invalid="true"]', form).forEach(node => node.removeAttribute("aria-invalid"));
    const invalid = $$('[required]', form).filter(field => !field.value.trim() || (field.type === "email" && !field.validity.valid));
    invalid.forEach(field => {
      field.setAttribute("aria-invalid", "true");
      const error = document.createElement("span");
      error.className = "field-error";
      error.textContent = field.value.trim() ? "Enter a valid value." : "This information is needed.";
      field.insertAdjacentElement("afterend", error);
    });
    invalid[0]?.focus();
    if (invalid.length) showToast(`Please check ${invalid.length} highlighted ${invalid.length === 1 ? "field" : "fields"}.`);
    return invalid.length === 0;
  }

  function keywordFrequency(text) {
    const counts = new Map();
    words(text).forEach(word => counts.set(word, (counts.get(word) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
  }

  function overlapScore(source, target, base = 35) {
    const sourceSet = new Set(words(source));
    const important = keywordFrequency(target).slice(0, 24);
    const matches = important.filter(word => sourceSet.has(word));
    const score = Math.min(96, Math.round(base + (matches.length / Math.max(important.length, 1)) * 90));
    return { score, matches, missing: important.filter(word => !sourceSet.has(word)) };
  }

  function evaluate(profile, job) {
    const description = job.description.toLowerCase();
    const profileText = Object.values(profile).join(" ");
    const technical = overlapScore(`${profile.skills} ${profile.experience}`, description, 28);
    const experience = overlapScore(profile.experience, description, 32);
    const career = overlapScore(`${profile.targetRoles} ${profile.goals}`, `${job.role} ${job.description}`, 38);
    const preferenceMatch = description.includes(profile.workPreference.toLowerCase()) || profile.workPreference === "Flexible";
    const behaviouralScore = Math.min(92, 62 + (preferenceMatch ? 15 : 0) + (description.includes("collabor") && profileText.toLowerCase().includes("collabor") ? 10 : 0));

    const sponsorshipRequired = profile.authorization === "Requires sponsorship";
    const citizenshipGate = /citizen(ship)? required|permanent resident required|security clearance/.test(description);
    const legalEntitlement = /legally entitled|authorized to work|work authorization/.test(description);
    const authorizationFlag = citizenshipGate && profile.authorization !== "Citizen or permanent resident" || (legalEntitlement && sponsorshipRequired);
    const jobLanguage = /\bfrench\b/.test(description) ? "French" : /\benglish\b/.test(description) ? "English" : null;
    const languageFlag = jobLanguage && !profile.languages.toLowerCase().includes(jobLanguage.toLowerCase());
    const locationText = `${job.jobLocation} ${job.description}`.toLowerCase();
    const locationFlag = profile.workPreference === "Remote" && !locationText.includes("remote") || profile.workPreference === "Hybrid" && /on-site|onsite|in office five|5 days/.test(locationText);

    const dimensions = [
      { name: "Technical skills", score: technical.score, note: `${technical.matches.length} relevant terms found in your evidence.` },
      { name: "Experience", score: experience.score, note: "Compares the work described, not just job titles." },
      { name: "Work style", score: behaviouralScore, note: preferenceMatch ? "The working arrangement aligns with your preference." : "The posting does not clearly confirm your preferred arrangement." },
      { name: "Career direction", score: career.score, note: "Compares the role with your target roles and stated goals." },
    ];
    const overall = Math.round(technical.score * .3 + experience.score * .25 + behaviouralScore * .15 + career.score * .3);
    const skillLines = lines(profile.skills);
    const matchedSkills = skillLines.filter(skill => description.includes(skill.toLowerCase()) || words(skill).some(word => description.includes(word))).slice(0, 4);
    const missing = technical.missing.filter(word => word.length > 4).slice(0, 4);
    const recommendation = authorizationFlag || languageFlag ? "Pause and verify" : overall >= 75 ? "Strong fit" : overall >= 60 ? "Worth applying" : overall >= 45 ? "Consider with care" : "Probably skip";

    return {
      overall,
      recommendation,
      dimensions,
      gates: [
        { name: "Work eligibility", status: authorizationFlag ? "FLAG" : "PASS", note: authorizationFlag ? "Your stated authorization may not meet the posting’s wording. Verify before applying." : "No conflict detected between your stated authorization and the posting." },
        { name: "Language", status: languageFlag ? "FLAG" : "PASS", note: languageFlag ? `${jobLanguage} appears required but is not listed in your profile.` : jobLanguage ? `${jobLanguage} appears in both the posting and your profile.` : "No explicit language conflict detected." },
        { name: "Location & logistics", status: locationFlag ? "FLAG" : "PASS", note: locationFlag ? "The stated work arrangement may conflict with your preference." : "No location or work-arrangement conflict detected." },
      ],
      strengths: matchedSkills.length ? matchedSkills.map(skill => `${skill} is supported by your confirmed profile.`) : ["Your experience contains transferable evidence, but the posting uses different terminology."],
      gaps: missing.length ? missing.map(word => `“${word}” appears important in the posting but is not explicit in your profile.`) : ["No obvious keyword gaps were detected. Review the full posting before relying on this result."],
      keywords: technical.matches.slice(0, 8),
      createdAt: new Date().toISOString(),
    };
  }

  function renderEvaluation() {
    const evaluation = state.evaluation;
    $("#overallScore").textContent = evaluation.overall;
    $("#fitSubtitle").textContent = `${state.job.role} at ${state.job.company}`;
    $("#gatePanel").innerHTML = evaluation.gates.map(gate => `<div class="gate ${gate.status === "PASS" ? "pass" : "flag"}"><span class="gate-status">${gate.status}</span><div><strong>${escapeHtml(gate.name)}</strong>${escapeHtml(gate.note)}</div></div>`).join("");
    $("#scoreGrid").innerHTML = evaluation.dimensions.map(item => `<article class="score-card"><p>${escapeHtml(item.name)}</p><strong>${item.score}<small>/100</small></strong><div class="score-bar" aria-label="${escapeHtml(item.name)} score ${item.score} out of 100"><span style="width:${item.score}%"></span></div><p>${escapeHtml(item.note)}</p></article>`).join("");
    $("#strengthList").innerHTML = evaluation.strengths.map(item => `<li>${escapeHtml(item)}</li>`).join("");
    $("#gapList").innerHTML = evaluation.gaps.map(item => `<li>${escapeHtml(item)}</li>`).join("");
    $("#recommendationTitle").textContent = evaluation.recommendation;
    $("#recommendationText").textContent = evaluation.recommendation === "Pause and verify" ? "A hard requirement may conflict with your profile. Resolve it before investing in an application." : "The score is a conversation starter, not a hiring prediction. Review the evidence and decide whether the opportunity is worth your time.";
  }

  function buildDrafts() {
    const profile = state.profile;
    const job = state.job;
    const experience = lines(profile.experience);
    const skills = lines(profile.skills);
    const evidence = [...experience.map((text, index) => ({ id: index + 1, text })), ...skills.map((text, index) => ({ id: experience.length + index + 1, text }))];
    const relevantSkills = skills.filter(skill => job.description.toLowerCase().includes(skill.toLowerCase()) || words(skill).some(word => job.description.toLowerCase().includes(word))).slice(0, 7);
    const selectedSkills = relevantSkills.length ? relevantSkills : skills.slice(0, 7);
    const resume = `<h1>${escapeHtml(profile.name)}</h1><p class="document-contact">${escapeHtml(profile.headline)} · ${escapeHtml(profile.location)} · ${escapeHtml(profile.email)}</p><h2>Profile</h2><p>${escapeHtml(profile.headline)} with experience relevant to ${escapeHtml(job.role)}. Brings ${escapeHtml(selectedSkills.slice(0, 3).join(", "))} and a stated goal to ${escapeHtml(profile.goals.charAt(0).toLowerCase() + profile.goals.slice(1))}</p><h2>Relevant experience</h2>${experience.map((item, index) => `<p>${escapeHtml(item)} <sup title="Evidence ${index + 1}: ${escapeHtml(item)}" aria-label="Supported by evidence ${index + 1}">${index + 1}</sup></p>`).join("")}<h2>Core skills</h2><ul>${selectedSkills.map(skill => { const id = experience.length + skills.indexOf(skill) + 1; return `<li>${escapeHtml(skill)} <sup title="Evidence ${id}: ${escapeHtml(skill)}" aria-label="Supported by evidence ${id}">${id}</sup></li>`; }).join("")}</ul><h2>Languages & eligibility</h2><p>${escapeHtml(profile.languages)} · ${escapeHtml(profile.authorization)}</p>`;
    const leadEvidence = experience[0] || "the experience in my profile";
    const letter = `<p>${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p><p>Dear Hiring Manager,</p><p>I am applying for the ${escapeHtml(job.role)} position at ${escapeHtml(job.company)}. The role's emphasis on ${escapeHtml(state.evaluation.keywords.slice(0, 3).join(", ") || "practical collaboration")} connects closely with my background as a ${escapeHtml(profile.headline)}.</p><p>Most directly, ${escapeHtml(leadEvidence)} <sup title="Evidence 1: ${escapeHtml(leadEvidence)}" aria-label="Supported by evidence 1">1</sup> This experience would help me contribute to the responsibilities described in your posting while learning the parts of the role that are new to me.</p><p>I am especially interested in this opportunity because ${escapeHtml(profile.goals.charAt(0).toLowerCase() + profile.goals.slice(1))} I would welcome the chance to discuss how my experience could support the team.</p><p>Sincerely,<br>${escapeHtml(profile.name)}<br>${escapeHtml(profile.email)}</p>`;
    return { resume, letter, evidence, profileSnapshot: profile, jobSnapshot: job, createdAt: new Date().toISOString() };
  }

  function sanitizeDraft(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const allowed = new Set(["H1", "H2", "H3", "P", "UL", "OL", "LI", "BR", "STRONG", "EM", "SUP"]);
    [...doc.body.querySelectorAll("*")].forEach(node => {
      if (!allowed.has(node.tagName)) node.replaceWith(...node.childNodes);
      else [...node.attributes].forEach(attr => {
        if (!(node.tagName === "SUP" && ["title", "aria-label"].includes(attr.name))) node.removeAttribute(attr.name);
      });
    });
    return doc.body.innerHTML;
  }

  function renderDrafts() {
    $("#resumeDocument").innerHTML = sanitizeDraft(state.drafts.resume);
    $("#letterDocument").innerHTML = sanitizeDraft(state.drafts.letter);
  }

  function renderTracker() {
    const container = $("#trackerList");
    if (!state.applications.length) {
      container.innerHTML = `<div class="tracker-empty"><h3>No saved applications yet</h3><p>Create an application, then save it here to track what happens next.</p></div>`;
      return;
    }
    container.innerHTML = state.applications.map(app => `<article class="tracker-card"><div><h3>${escapeHtml(app.role)} · ${escapeHtml(app.company)}</h3><p>Fit ${app.score}/100 · Saved ${new Date(app.savedAt).toLocaleDateString()}</p></div><label>Status<span class="sr-only"> for ${escapeHtml(app.role)}</span><select data-application-id="${app.id}"><option${app.status === "Drafting" ? " selected" : ""}>Drafting</option><option${app.status === "Applied" ? " selected" : ""}>Applied</option><option${app.status === "Interview" ? " selected" : ""}>Interview</option><option${app.status === "Offer" ? " selected" : ""}>Offer</option><option${app.status === "Closed" ? " selected" : ""}>Closed</option></select></label></article>`).join("");
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  $("#startButton").addEventListener("click", () => showApp(state.currentView || "profile"));
  $("#loadExampleButton").addEventListener("click", () => {
    state = exampleState();
    state.evaluation = evaluate(state.profile, state.job);
    saveState("Example loaded");
    showApp("fit");
    showToast("Example profile and job loaded.");
  });
  $$(".nav-step").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $$('[data-back]').forEach(button => button.addEventListener("click", () => showView(button.dataset.back)));

  $("#profileForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!validateForm(event.currentTarget)) return;
    state.profile = formValues(event.currentTarget);
    state.evaluation = null;
    state.drafts = null;
    saveState("Profile confirmed");
    updateNavigation();
    showView("job");
  });

  $("#jobForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!validateForm(event.currentTarget)) return;
    state.job = formValues(event.currentTarget);
    state.evaluation = evaluate(state.profile, state.job);
    state.drafts = null;
    saveState("Job evaluated");
    updateNavigation();
    showView("fit");
  });

  $("#generateButton").addEventListener("click", () => {
    const blocked = state.evaluation.gates.some(gate => gate.status === "FLAG");
    if (blocked && !window.confirm("This fit report contains a flag. Create drafts anyway for your review?")) return;
    state.drafts = buildDrafts();
    saveState("Application created");
    updateNavigation();
    showView("drafts");
  });

  function setDocumentTab(active) {
    const resumeActive = active === "resume";
    $("#resumeTab").setAttribute("aria-selected", String(resumeActive));
    $("#letterTab").setAttribute("aria-selected", String(!resumeActive));
    $("#resumePanel").classList.toggle("is-hidden", !resumeActive);
    $("#letterPanel").classList.toggle("is-hidden", resumeActive);
  }
  $("#resumeTab").addEventListener("click", () => setDocumentTab("resume"));
  $("#letterTab").addEventListener("click", () => setDocumentTab("letter"));
  $$(".document-page").forEach(documentPage => {
    documentPage.addEventListener("blur", () => {
      if (!state.drafts) return;
      const key = documentPage.id === "resumeDocument" ? "resume" : "letter";
      state.drafts[key] = sanitizeDraft(documentPage.innerHTML);
      saveState("Edits saved");
    });
    documentPage.addEventListener("paste", event => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    });
  });

  $("#printButton").addEventListener("click", () => window.print());
  $("#saveApplicationButton").addEventListener("click", () => {
    const existing = state.applications.find(app => app.company === state.job.company && app.role === state.job.role);
    if (existing) {
      existing.score = state.evaluation.overall;
      existing.savedAt = new Date().toISOString();
    } else {
      state.applications.unshift({ id: crypto.randomUUID(), company: state.job.company, role: state.job.role, score: state.evaluation.overall, status: "Drafting", savedAt: new Date().toISOString() });
    }
    saveState("Saved to tracker");
    updateNavigation();
    showToast("Application saved to your tracker.");
  });

  $("#trackerList").addEventListener("change", event => {
    const select = event.target.closest("select[data-application-id]");
    if (!select) return;
    const application = state.applications.find(app => app.id === select.dataset.applicationId);
    if (application) {
      application.status = select.value;
      saveState("Status updated");
      showToast("Application status updated.");
    }
  });

  $("#exportDataButton").addEventListener("click", () => {
    download(`jobist-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), "application/json");
    showToast("Your Jobist data was exported.");
  });

  const helpDialog = $("#helpDialog");
  $("#helpButton").addEventListener("click", () => helpDialog.showModal());
  $(".dialog-close", helpDialog).addEventListener("click", () => helpDialog.close());
  const deleteDialog = $("#deleteDialog");
  $("#deleteDataButton").addEventListener("click", () => deleteDialog.showModal());
  $("#cancelDeleteButton").addEventListener("click", () => deleteDialog.close());
  $("#confirmDeleteButton").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    state = emptyState();
    deleteDialog.close();
    location.reload();
  });

  [helpDialog, deleteDialog].forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));

  if (state.profile || state.job || state.applications.length) showApp(canOpen(state.currentView) ? state.currentView : "profile");
})();
