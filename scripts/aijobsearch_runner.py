#!/usr/bin/env python3
"""
AI Job Search Workflow Runner (Approximator).
Executes the upstream aijobsearch pipeline (/setup, /rank, /apply)
using local LLM (LM Studio) to approximate Claude Code execution.
"""

import sys
import os
import json
import re
import urllib.request
from pathlib import Path

LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "http://127.0.0.1:1234/v1")
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "qwen3.8-27b")

AIJOBSEARCH_DIR = Path("/Users/pushp/Documents/Projects/ai-job-search-ca")


def query_llm(messages, max_tokens=2500, temperature=0.2, timeout=300):
    """Query local LLM via LM Studio with extended timeout."""
    payload = {
        "model": LOCAL_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }
    req = urllib.request.Request(
        f"{LM_STUDIO_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            msg = data.get("choices", [{}])[0].get("message", {})
            content = msg.get("content", "")
            if not content and "reasoning_content" in msg:
                content = msg.get("reasoning_content", "")
            return content.strip()
    except Exception as e:
        return f"LLM error: {e}"


def run_aijobsearch_setup(persona_dir: Path, persona_name: str, documents: list):
    """
    Approximates /setup (Phase 1):
    Reads all documents for the persona and generates 01-candidate-profile.md.
    """
    docs_text = []
    for doc in documents:
        doc_path = persona_dir / doc
        if not doc_path.is_file():
            continue
        if doc_path.suffix.lower() in [".txt", ".tex", ".md"]:
            content = doc_path.read_text(encoding="utf-8", errors="ignore")
            docs_text.append(f"=== Document: {doc} ===\n{content}\n")
        elif doc_path.suffix.lower() == ".pdf":
            try:
                import pypdf
                reader = pypdf.PdfReader(str(doc_path))
                text = "\n".join([page.extract_text() or "" for page in reader.pages])
                docs_text.append(f"=== Document: {doc} (PDF) ===\n{text}\n")
            except Exception as e:
                docs_text.append(f"=== Document: {doc} ===\n[PDF read error: {e}]\n")
        elif doc_path.suffix.lower() == ".docx":
            try:
                import zipfile
                import xml.etree.ElementTree as ET
                with zipfile.ZipFile(str(doc_path)) as z:
                    xml_content = z.read("word/document.xml")
                    tree = ET.fromstring(xml_content)
                    paragraphs = [node.text for node in tree.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t") if node.text]
                    docs_text.append(f"=== Document: {doc} (DOCX) ===\n{' '.join(paragraphs)}\n")
            except Exception as e:
                docs_text.append(f"=== Document: {doc} ===\n[DOCX read error: {e}]\n")

    all_raw_text = "\n".join(docs_text)

    prompt = f"""You are the AI Job Search setup assistant following .claude/commands/setup.md.
Build a comprehensive 01-candidate-profile.md for candidate '{persona_name}'.
Extract ALL employment history, roles, dates, organizations, and verbatim achievement bullets.
Preserve ALL quantitative metrics, percentages, dollar amounts, licenses, and publications exactly as written.

Raw Documents:
{all_raw_text[:12000]}

Output the complete markdown profile in standard aijobsearch format:
# Candidate Profile: {persona_name}
## Identity & Contact
## Professional Experience (Comprehensive)
## Technical Skills & Credentials
## Publications & Research (if applicable)
"""
    messages = [
        {"role": "system", "content": "You are Claude running /setup in ai-job-search-ca. You extract comprehensive candidate profiles with strict metric fidelity."},
        {"role": "user", "content": prompt}
    ]
    return query_llm(messages, max_tokens=2500)


def run_aijobsearch_apply(profile_text: str, target_job: dict):
    """
    Approximates /apply (Phase 3):
    Evaluates fit, tailors LaTeX moderncv CV, and drafts cover letter.
    """
    job_title = target_job.get("role") or target_job.get("title") or "Target Role"
    job_company = target_job.get("company", "Target Company")
    job_desc = target_job.get("description", "")

    prompt = f"""You are Claude running /apply in ai-job-search-ca for:
Role: {job_title} at {job_company}

Target Job Posting:
{job_desc[:4000]}

Candidate Profile:
{profile_text[:6000]}

Provide:
1. Fit Evaluation: Scores (Technical, Experience, Behavioral, Career: 0-100), and Gating Checks (Work eligibility, language).
2. ModernCV LaTeX Fragment: Provide tailored \\cventry bullets for cv/main.tex.
3. Tailored Cover Letter: 3 concise paragraphs.
4. Step 3 Factual Grounding Audit: Confirm each claim maps to the candidate profile facts.
"""
    messages = [
        {"role": "system", "content": "You are Claude executing /apply in ai-job-search-ca with moderncv LaTeX and factual grounding audit."},
        {"role": "user", "content": prompt}
    ]
    return query_llm(messages, max_tokens=2500)
