#!/usr/bin/env python3
"""
Generate test fixtures for Jobist vs. AI Job Search comparative evaluation.
Creates synthetic candidate profiles and target jobs for:
- Persona 1: Senior Policy Specialist (referencing aijobsearch documents)
- Persona 2: Microbiology Researcher (academic CV with 14 publications)
- Persona 3: Clinical Pharmacist (Pharm.D. with hospital residency & licensing)
- Persona 4: Cloud Software / Infrastructure Engineer (DevOps/SRE)
All generated files are placed in test_cases/ which is gitignored.
"""

import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST_DIR = ROOT / "test_cases"
AIJOBSEARCH_DIR = Path("/Users/pushp/Documents/Projects/aijobsearch")


def create_docx(path: Path, paragraphs: list[str]) -> None:
    """Create a minimal valid Word .docx document from a list of paragraphs."""
    p_xmls = []
    for p in paragraphs:
        text_escaped = (
            p.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )
        p_xmls.append(
            f'<w:p><w:r><w:t xml:space="preserve">{text_escaped}</w:t></w:r></w:p>'
        )

    doc_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>' + "".join(p_xmls) + "</w:body></w:document>"
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        z.writestr("word/document.xml", doc_xml)


def create_pdf_from_text(path: Path, text: str) -> None:
    """Generate a clean PDF with text layer using macOS cupsfilter."""
    cupsfilter = "/usr/sbin/cupsfilter"
    if os.path.exists(cupsfilter):
        try:
            proc = subprocess.Popen(
                [cupsfilter, "-i", "text/plain", "-m", "application/pdf"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            pdf_bytes, _ = proc.communicate(input=text.encode("utf-8"))
            if proc.returncode == 0 and pdf_bytes.startswith(b"%PDF"):
                path.write_bytes(pdf_bytes)
                return
        except Exception:
            pass

    # Fallback to minimal PDF stream if cupsfilter is unavailable
    escaped = text.replace("(", "\\(").replace(")", "\\)").encode("latin-1", "replace")
    stream = b"BT\n/F1 10 Tf\n50 750 Td\n(" + escaped[:2000] + b") Tj\nET"
    pdf = (
        b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
        b"4 0 obj<</Length "
        + str(len(stream)).encode()
        + b">>stream\n"
        + stream
        + b"\nendstream\nendobj\n"
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \n0000000300 00000 n \n"
        b"trailer<</Size 6/Root 1 0 R>>\nstartxref\n380\n%%EOF"
    )
    path.write_bytes(pdf)


def setup_persona_1(dest: Path) -> dict:
    """Setup Persona 1: Senior Policy Specialist using aijobsearch documents."""
    dest.mkdir(parents=True, exist_ok=True)
    jobs_dir = dest / "target_jobs"
    jobs_dir.mkdir(exist_ok=True)

    copied_files = []
    # Copy plain text resume and docx application from aijobsearch if present
    src_gc = AIJOBSEARCH_DIR / "documents" / "cv" / "resume_gcjobs.txt"
    if src_gc.exists():
        shutil.copy2(src_gc, dest / "resume_gcjobs.txt")
        copied_files.append("resume_gcjobs.txt")

    src_app = AIJOBSEARCH_DIR / "documents" / "applications" / "EC07_TBS.docx"
    if src_app.exists():
        shutil.copy2(src_app, dest / "EC07_TBS.docx")
        copied_files.append("EC07_TBS.docx")

    # Target Job: EC-07 Federal Policy Analyst
    ec07_job = {
        "company": "Treasury Board of Canada Secretariat",
        "role": "Senior Policy Analyst (EC-07)",
        "jobLocation": "Ottawa, ON — hybrid",
        "url": "https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page2440?poster=2026-TBS-IA-01",
        "description": """Treasury Board of Canada Secretariat — International Affairs & Economic Policy Directorate
Position: Senior Policy Analyst (EC-07)
Salary: $118,500 to $137,200 (EC collective agreement)
Location: Ottawa, Ontario (Hybrid — minimum 3 days on-site)
Language Requirement: Bilingual imperative (CBC/CBC)

Essential Qualifications:
- Graduation with a degree from a recognized post-secondary institution with acceptable specialization in economics, sociology, statistics, or public administration.
- Significant experience leading quantitative and qualitative economic policy analysis.
- Significant experience briefing senior executives (Director General and Assistant Deputy Minister level) on complex regulatory or fiscal files.
- Demonstrated experience collaborating with intergovernmental and international stakeholders.

Eligibility:
Persons residing in Canada and Canadian citizens or permanent residents abroad. Preference will be given to Canadian citizens and permanent residents.""",
    }
    (jobs_dir / "ec07_policy_analyst.json").write_text(
        json.dumps(ec07_job, indent=2), encoding="utf-8"
    )

    return {
        "id": "persona_1_policy",
        "name": "Senior Policy & Economics Specialist",
        "domain": "Federal Public Service & Economic Policy",
        "files": copied_files,
        "targetJobs": ["ec07_policy_analyst.json"],
    }


def setup_persona_2(dest: Path) -> dict:
    """Setup Persona 2: Microbiology & Immunology Academic Researcher."""
    dest.mkdir(parents=True, exist_ok=True)
    jobs_dir = dest / "target_jobs"
    jobs_dir.mkdir(exist_ok=True)

    cv_text = """Dr. Elena Rostova, Ph.D.
Senior Research Scientist — Microbiology & Molecular Immunology
Montreal, QC | elena.rostova.phd@example.org | (514) 555-0182 | Canadian Permanent Resident

PROFESSIONAL PROFILE
Molecular microbiologist with 9+ years of research leadership spanning microbial genomics, antimicrobial resistance (AMR), and bacterial pathogenesis. Directed 6 multi-institution scientific projects, mentored 12 graduate students, and authored 14 peer-reviewed publications (h-index: 11, >620 citations). Experienced in translating wet-lab assay development into high-throughput screening platforms.

EDUCATION & CREDENTIALS
Ph.D. in Microbiology & Immunology, McGill University (2015 – 2020)
  Dissertation: "Genomic architecture and efflux-mediated drug resistance in Pseudomonas aeruginosa"
  Supervised by Dr. H. Tremblay; NSERC Alexander Graham Bell Graduate Scholarship ($105,000)
B.Sc. (Honours) in Biochemistry with Distinction, University of British Columbia (2011 – 2015)

RESEARCH & PROFESSIONAL EXPERIENCE
Senior Postdoctoral Research Fellow | McGill Genome Centre & Dept. of Microbiology (2022 – present)
- Directed experimental pipelines evaluating 450+ bacterial isolates for novel beta-lactamase inhibitors using RNA-seq, Tn-seq, and mass spectrometry.
- Secured $320,000 in collaborative funding as co-applicant on a CIHR Project Grant (2023–2026).
- Engineered a high-throughput multiplex PCR assay reducing variant classification turnaround time from 72 hours to 6 hours.
- Supervised 4 Ph.D. candidates and 5 undergraduate researchers in Biosafety Level 2+ (BSL-2+) lab protocols.

Postdoctoral Fellow | Michael Smith Laboratories, University of British Columbia (2020 – 2022)
- Characterized quorum-sensing regulons across 12 clinically isolated bacterial pathogens using Illumina NovaSeq and Oxford Nanopore sequencing.
- Co-invented a patented microfluidic diagnostic cartridge for rapid point-of-care pathogen identification (US Patent Application 18/402,119).
- Authored 5 first-author papers in high-impact journals including Nature Communications and Antimicrobial Agents and Chemotherapy.

Graduate Research & Teaching Assistant | McGill University (2015 – 2020)
- Optimized CRISPR-Cas9 genome editing protocols in multidrug-resistant Pseudomonas aeruginosa, improving transformation efficiency by 40%.
- Taught advanced undergraduate laboratory courses in Bacterial Genetics and Medical Bacteriology (180+ students over 4 academic terms).

PEER-REVIEWED PUBLICATIONS (Selected 14 Publications)
1. Rostova, E., et al. (2024). "Transcriptomic dynamics of efflux pump overexpression during carbapenem challenge." Nature Communications, 15(1), 2841.
2. Rostova, E., & Tremblay, H. (2023). "Mechanisms of acquired beta-lactamase resistance in clinical isolates." Antimicrobial Agents and Chemotherapy, 67(4), e01923.
3. Rostova, E., Patel, K., & Smith, D. (2023). "High-throughput phenotypic profiling of clinical biofilm formers." Journal of Bacteriology, 205(8), e00112.
4. Chen, M., Rostova, E., et al. (2022). "Multiplex nanopore sequencing for rapid identification of hospital-acquired pathogens." Lancet Infectious Diseases, 22(9), 1312-1320.
5. Rostova, E., et al. (2022). "Structural characterization of a novel aminoglycoside-modifying enzyme." Journal of Biological Chemistry, 298(2), 101550.
6. Rostova, E., & Smith, D. (2021). "Quorum sensing inhibition reverses macrolide tolerance." ACS Infectious Diseases, 7(11), 3020-3031.
7. Tremblay, H., Rostova, E., et al. (2021). "Genomic surveillance of ESKAPE pathogens in Canadian intensive care units." Canadian Journal of Microbiology, 67(5), 389-402.
8. Rostova, E., et al. (2020). "Tn-seq analysis of essential genes under hyperosmotic stress." mBio, 11(3), e00812.
9. Patel, K., Rostova, E., et al. (2020). "Microfluidic platforms for single-cell bacterial antibiotic profiling." Lab on a Chip, 20(14), 2560-2571.
10. Rostova, E., et al. (2019). "Whole-genome assembly of highly resistant environmental pseudomonads." Genome Biology and Evolution, 11(8), 2210-2218.
11. Rostova, E., & Tremblay, H. (2018). "Evolutionary trade-offs in bacterial virulence and resistance." Trends in Microbiology, 26(12), 1002-1014.
12. Nguyen, L., Rostova, E., et al. (2018). "Automated liquid handling protocols for microbial MIC testing." Journal of Microbiological Methods, 152, 45-52.
13. Rostova, E., et al. (2017). "Comparative genomic analysis of cystic fibrosis airway isolates." Infection and Immunity, 85(7), e00234.
14. Rostova, E., et al. (2016). "Rapid fluorescent dye assay for membrane integrity in Gram-negative bacteria." Applied and Environmental Microbiology, 82(18), 5601-5610.

CORE TECHNICAL SKILLS
Laboratory Techniques: BSL-2+ containment, CRISPR-Cas9 mutagenesis, microbial culturing, RNA-seq library prep, Illumina NovaSeq, Oxford Nanopore, mass spectrometry, HPLC, automated liquid handling (Biomek), qPCR.
Bioinformatics & Data: Python (pandas, Biopython), R (DESeq2, ggplot2), Nextflow pipelines, BLAST, variant calling, Linux HPC environments.
Regulatory & Compliance: GLP (Good Laboratory Practice), Canadian Biosafety Standards, CIHR grant administration, patent filings.
Languages: English (fluent), French (conversational — B1/B2 level).
"""

    (dest / "cv_microbiology_phd.txt").write_text(cv_text, encoding="utf-8")
    create_pdf_from_text(dest / "cv_microbiology_phd.pdf", cv_text)

    # LaTeX version
    tex_content = r"""\documentclass[10pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage{geometry}
\geometry{margin=0.75in}
\begin{document}
\section*{Dr. Elena Rostova, Ph.D. -- Curriculum Vitae}
\textbf{Senior Research Scientist -- Microbiology \& Molecular Immunology}\\
Montreal, QC | elena.rostova.phd@example.org | Canadian Permanent Resident

\subsection*{Education}
\textbf{Ph.D. in Microbiology \& Immunology}, McGill University (2015 -- 2020)\\
\textbf{B.Sc. (Honours) in Biochemistry}, University of British Columbia (2011 -- 2015)

\subsection*{Research Experience}
\textbf{Senior Postdoctoral Research Fellow}, McGill Genome Centre (2022 -- present)
\begin{itemize}
  \item Directed experimental pipelines evaluating 450+ bacterial isolates using RNA-seq and mass spectrometry.
  \item Secured \$320,000 in collaborative funding as co-applicant on a CIHR Project Grant (2023--2026).
  \item Engineered high-throughput multiplex PCR assay reducing variant turnaround time from 72h to 6h.
\end{itemize}

\textbf{Postdoctoral Fellow}, Michael Smith Laboratories, UBC (2020 -- 2022)
\begin{itemize}
  \item Characterized quorum-sensing regulons across 12 clinical isolates using Illumina and Oxford Nanopore.
  \item Co-invented a patented microfluidic diagnostic cartridge (US Patent Application 18/402,119).
\end{itemize}

\subsection*{Selected Publications (14 Total)}
1. Rostova, E., et al. (2024). Nature Communications, 15(1), 2841.\\
2. Rostova, E., \& Tremblay, H. (2023). Antimicrobial Agents and Chemotherapy, 67(4), e01923.\\
3. Rostova, E., et al. (2023). Journal of Bacteriology, 205(8), e00112.

\end{document}
"""
    (dest / "cv_microbiology_phd.tex").write_text(tex_content, encoding="utf-8")

    # Target Job 1: Biotech Senior Research Scientist (Montreal)
    biotech_job = {
        "company": "AdMare BioInnovations",
        "role": "Senior Scientist — Antimicrobial Discovery & Assay Development",
        "jobLocation": "Montreal, QC",
        "url": "https://www.admarebio.com/careers/senior-scientist-amr",
        "description": """AdMare BioInnovations is seeking a Senior Scientist to lead our antimicrobial discovery programs in Montreal.
Role Responsibilities:
- Lead the design and execution of biochemical and cell-based high-throughput screening assays for bacterial targets.
- Direct external academic collaborations and CRO relationships for compound profiling.
- Analyze genomic and transcriptomic sequencing datasets to elucidate mechanisms of action for novel therapeutics.
- Present findings to scientific advisory boards and contribute to patent filings and regulatory dossiers.

Requirements:
- Ph.D. in Microbiology, Molecular Biology, Biochemistry, or related discipline with 3+ years of postdoctoral or industry experience.
- Track record of peer-reviewed publications and demonstrated ability to secure research grants.
- Hands-on expertise with BSL-2 pathogen handling, RNA-seq, qPCR, and assay miniaturization.
- Demonstrated experience mentoring junior scientists.
- Legal authorization to work in Canada.""",
    }
    (jobs_dir / "biotech_scientist.json").write_text(
        json.dumps(biotech_job, indent=2), encoding="utf-8"
    )

    # Target Job 2: Health Canada Scientific Evaluator (Ottawa / Hybrid)
    hc_job = {
        "company": "Health Canada",
        "role": "Scientific Evaluator — Biologics and Radiopharmaceuticals (BI-04)",
        "jobLocation": "Ottawa, ON or Montreal, QC — hybrid",
        "url": "https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page2440?poster=2026-HC-BI04",
        "description": """Health Canada — Health Products and Food Branch (HPFB)
Position: Scientific Evaluator (BI-04)
Salary: $98,400 to $121,900
Language: English essential, bilingual imperative (BBB) an asset.

Duties:
- Conduct rigorous scientific evaluations of drug submissions, clinical trial applications, and manufacturing protocols for biologics and antimicrobial agents.
- Formulate scientific risk assessments and advisory reports regarding drug safety, efficacy, and quality.
- Liaise with domestic academic researchers, industry sponsors, and international regulatory agencies (FDA, EMA).

Qualifications:
- Ph.D. or Master's degree in microbiology, biochemistry, immunology, or pharmacology.
- Minimum 3 years of post-graduate experience evaluating scientific research data, molecular assays, or regulatory standards.
- Demonstrated written communication skills producing critical appraisal documents.
- Canadian Citizenship or Permanent Residency required.""",
    }
    (jobs_dir / "health_canada_evaluator.json").write_text(
        json.dumps(hc_job, indent=2), encoding="utf-8"
    )

    return {
        "id": "persona_2_microbiology",
        "name": "Dr. Elena Rostova",
        "domain": "Microbiology & Biotech Research",
        "files": [
            "cv_microbiology_phd.txt",
            "cv_microbiology_phd.pdf",
            "cv_microbiology_phd.tex",
        ],
        "targetJobs": ["biotech_scientist.json", "health_canada_evaluator.json"],
    }


def setup_persona_3(dest: Path) -> dict:
    """Setup Persona 3: Licensed Clinical Pharmacist."""
    dest.mkdir(parents=True, exist_ok=True)
    jobs_dir = dest / "target_jobs"
    jobs_dir.mkdir(exist_ok=True)

    paragraphs = [
        "Marcus Vance, Pharm.D., ACPR",
        "Clinical Oncology & Critical Care Pharmacist",
        "Toronto, ON | marcus.vance.pharm@example.org | (416) 555-0149 | Canadian Citizen",
        "",
        "PROFESSIONAL PROFILE",
        "Licensed clinical pharmacist (OCP Part A, #618492) with 6 years of specialized hospital practice across critical care (ICU), hematology/oncology, and sterile compounding. Accredited Canadian Pharmacy Residency (ACPR) graduate with extensive experience in clinical pharmacokinetics, protocol optimization, multidisciplinary rounds, and adverse drug reaction reporting.",
        "",
        "PROFESSIONAL LICENSURE & EDUCATION",
        "Pharmacist Part A License, Ontario College of Pharmacists (OCP) (2018 – present)",
        "Accredited Canadian Pharmacy Residency (ACPR), Sunnybrook Health Sciences Centre (2018 – 2019)",
        "Doctor of Pharmacy (Pharm.D.), Leslie Dan Faculty of Pharmacy, University of Toronto (2014 – 2018)",
        "NAPRA Sterile Compounding Certification (Hazardous & Non-Hazardous) (2019)",
        "",
        "CLINICAL EXPERIENCE",
        "Clinical Pharmacy Specialist — Hematology & Inpatient Oncology | Sunnybrook Health Sciences Centre, Toronto, ON (2021 – present)",
        "- Designed, monitored, and adjusted 1,200+ complex chemotherapy and immunotherapy regimens annually in collaboration with medical oncologists.",
        "- Established therapeutic drug monitoring (TDM) protocols for high-dose methotrexate and busulfan, reducing acute nephrotoxicity incidents by 28%.",
        "- Supervised the hospital cleanroom compounding team to ensure 100% adherence to USP 797 and NAPRA hazardous sterile preparation guidelines.",
        "- Acted as primary clinical preceptor for 8 Pharm.D. students and 3 hospital pharmacy residents.",
        "",
        "Clinical Pharmacist — Intensive Care Unit (ICU) & Emergency Medicine | St. Michael's Hospital, Unity Health Toronto (2019 – 2021)",
        "- Participated in daily bedside interprofessional trauma and ICU rounds for a 24-bed Level 1 trauma centre.",
        "- Managed continuous renal replacement therapy (CRRT) antibiotic dosing and pharmacokinetic consultations for 350+ critically ill patients.",
        "- Co-authored the hospital emergency antimicrobial stewardship guidelines, achieving an 18% reduction in unnecessary broad-spectrum carbapenem utilization.",
        "",
        "Pharmacy Resident (ACPR) | Sunnybrook Health Sciences Centre, Toronto, ON (2018 – 2019)",
        "- Completed 52-week clinical hospital rotations in cardiology, infectious diseases, nephrology, oncology, and health authority administration.",
        "- Conducted residency research project on anticoagulant reversal in traumatic intracranial hemorrhage, presented at the Canadian Society of Hospital Pharmacists (CSHP) National Conference.",
        "",
        "SKILLS & COMPETENCIES",
        "Clinical Expertise: Pharmacokinetics (TDM), oncology chemotherapy protocols, antimicrobial stewardship, adverse event reporting (MedEffect Canada).",
        "Technical & Systems: Cerner PowerChart, Epic Willow, Pyxis automated dispensing, Lexicomp, UpToDate, NAPRA Cleanroom standards.",
        "Languages: English (fluent), French (basic/conversational).",
    ]

    create_docx(dest / "cv_clinical_pharmacist.docx", paragraphs)
    plain_text = "\n".join(paragraphs)
    (dest / "cv_clinical_pharmacist.txt").write_text(plain_text, encoding="utf-8")
    create_pdf_from_text(dest / "cv_clinical_pharmacist.pdf", plain_text)

    # Target Job 1: Hospital Clinical Pharmacist (Toronto)
    hospital_job = {
        "company": "University Health Network (UHN)",
        "role": "Clinical Pharmacist — Inpatient Oncology (Princess Margaret Cancer Centre)",
        "jobLocation": "Toronto, ON",
        "url": "https://www.uhn.ca/careers/clinical-pharmacist-pmh",
        "description": """Princess Margaret Cancer Centre — University Health Network
Position: Clinical Pharmacist — Inpatient Medical Oncology
Job Type: Full-Time, Permanent
Salary: $96,000 to $122,000

Job Overview:
As a Clinical Pharmacist at Princess Margaret Cancer Centre, you will provide comprehensive patient-centred pharmacotherapy management for inpatient medical oncology and stem cell transplant units.

Key Responsibilities:
- Conduct comprehensive admission medication reconciliations, chemotherapy order verification, and clinical progress reviews.
- Provide pharmacokinetic dosing consultations and manage supportive care (antiemetics, pain management, neutropenic fever).
- Collaborate closely with physicians, nurse practitioners, and cleanroom pharmacy technicians.
- Participate in quality improvement initiatives, clinical audits, and student preceptor programs.

Qualifications:
- Doctor of Pharmacy (Pharm.D.) or Bachelor of Science in Pharmacy from an accredited university.
- Current Part A registration in good standing with the Ontario College of Pharmacists (OCP).
- Completion of an Accredited Canadian Pharmacy Residency (ACPR) or minimum 2 years hospital oncology practice.
- Experience with Epic electronic health record system is strongly preferred.""",
    }
    (jobs_dir / "hospital_clinical_pharmacist.json").write_text(
        json.dumps(hospital_job, indent=2), encoding="utf-8"
    )

    # Target Job 2: Medical Science Liaison (MSL) - Oncology
    msl_job = {
        "company": "AstraZeneca Canada",
        "role": "Medical Science Liaison (MSL) — Solid Tumours / Oncology",
        "jobLocation": "Toronto, ON or Montreal, QC — hybrid",
        "url": "https://careers.astrazeneca.com/job/msl-oncology-canada",
        "description": """AstraZeneca Canada is hiring a Medical Science Liaison (MSL) in Oncology covering Ontario and Eastern Canada.
Role Summary:
The MSL is a field-based peer scientific expert responsible for providing credible, evidence-based scientific and clinical information to Key External Experts (KEEs) and clinical oncologists.

Key Responsibilities:
- Engage in peer-to-peer scientific exchanges with oncology clinicians, investigators, and pharmacy directors regarding clinical trial data and therapeutic developments.
- Support investigator-initiated studies (IIS) and facilitate connections to research infrastructure.
- Deliver clinical presentations at regional and national oncology symposiums.
- Provide scientific insights from the field to internal medical affairs and market access teams.

Qualifications:
- Advanced health science degree: Pharm.D., Ph.D., or M.D. required.
- Minimum 2 years of hospital clinical experience in oncology, or previous MSL experience.
- Deep understanding of Canadian clinical practice guidelines, healthcare systems, and provincial drug formulary processes.
- Excellent interpersonal and scientific presentation skills.
- Valid driver's license and ability to travel up to 40% regionally.""",
    }
    (jobs_dir / "medical_science_liaison.json").write_text(
        json.dumps(msl_job, indent=2), encoding="utf-8"
    )

    return {
        "id": "persona_3_pharmacist",
        "name": "Marcus Vance",
        "domain": "Hospital Pharmacy & Clinical Practice",
        "files": [
            "cv_clinical_pharmacist.docx",
            "cv_clinical_pharmacist.pdf",
            "cv_clinical_pharmacist.txt",
        ],
        "targetJobs": [
            "hospital_clinical_pharmacist.json",
            "medical_science_liaison.json",
        ],
    }


def setup_persona_4(dest: Path) -> dict:
    """Setup Persona 4: Cloud Software / Infrastructure Engineer."""
    dest.mkdir(parents=True, exist_ok=True)
    jobs_dir = dest / "target_jobs"
    jobs_dir.mkdir(exist_ok=True)

    cv_text = """Amina Diallo
Senior Cloud Infrastructure & Site Reliability Engineer
Calgary, AB | amina.diallo.dev@example.com | (403) 555-0199 | Canadian Citizen

PROFESSIONAL SUMMARY
Senior Site Reliability and Cloud Infrastructure Engineer with 8 years of experience scaling Kubernetes, multi-cloud architectures (AWS/GCP), and distributed microservices. Proven record maintaining 99.99% availability for enterprise SaaS platforms processing 15M transactions daily. Expert in Terraform infrastructure-as-code, zero-trust security architectures, and automated CI/CD release engineering.

CORE TECHNICAL SKILLS
Cloud Platforms: AWS (EKS, RDS, S3, IAM, CloudFront, Lambda), GCP (GKE, BigQuery, Cloud Spanner).
Containers & Orchestration: Kubernetes, Docker, Helm, Istio Service Mesh, ArgoCD, Cilium.
Infrastructure as Code: Terraform, Terragrunt, Ansible, CloudFormation.
Observability & Reliability: Prometheus, Grafana, Datadog, OpenTelemetry, ELK Stack, Chaos Engineering.
Programming & Scripting: Go, Python, Bash, SQL, YAML.
Security & Compliance: SOC 2 Type II, ISO 27001, Vault, OAuth 2.0, CIS Benchmarks.

PROFESSIONAL EXPERIENCE
Staff Site Reliability Engineer | CloudScale Systems, Calgary, AB (2021 – present)
- Architected and deployed multi-region AWS EKS Kubernetes clusters serving 15M daily requests with 99.99% measured SLA.
- Reduced annual cloud infrastructure spend by 38% ($420,000 savings) through Karpenter spot autoscaling and Graviton CPU migration.
- Automated end-to-end GitOps deployment pipelines with ArgoCD and Helm, reducing production deployment lead time from 4 hours to 8 minutes.
- Led incident response as on-call commander, decreasing Mean Time to Recovery (MTTR) by 55% through automated self-healing runbooks.

Senior DevOps Engineer | Benevity, Calgary, AB (2018 – 2021)
- Managed production Kubernetes microservices handling over $2.5B in charitable donations annually across global jurisdictions.
- Migrated legacy on-premise Oracle databases to AWS Aurora PostgreSQL with zero recorded customer downtime.
- Implemented HashiCorp Vault for centralized secret management, achieving full SOC 2 Type II audit compliance across 80+ microservices.
- Mentored a distributed team of 6 DevOps engineers and conducted bi-weekly reliability reviews.

Cloud Operations Engineer | Shaw Communications, Calgary, AB (2016 – 2018)
- Automated provisioning of 300+ Linux virtual machines using Terraform, Ansible, and Python scripts.
- Designed automated Prometheus and Grafana dashboards monitoring real-time network throughput and server health.
- Resolved Level 3 infrastructure incidents and maintained detailed post-mortem documentation.

EDUCATION & CERTIFICATIONS
B.Sc. in Computer Science, University of Calgary (2012 – 2016)
AWS Certified Solutions Architect — Professional (2023)
Certified Kubernetes Administrator (CKA), Cloud Native Computing Foundation (2022)
HashiCorp Certified: Terraform Associate (2021)
"""

    (dest / "cv_cloud_engineer.txt").write_text(cv_text, encoding="utf-8")
    create_pdf_from_text(dest / "cv_cloud_engineer.pdf", cv_text)

    # Target Job 1: Senior SRE (Canadian SaaS)
    sre_job = {
        "company": "Shopify",
        "role": "Senior Site Reliability Engineer — Core Infrastructure",
        "jobLocation": "Remote (Canada)",
        "url": "https://www.shopify.com/careers/senior-sre-infrastructure",
        "description": """Shopify is seeking a Senior Site Reliability Engineer to join our Core Infrastructure team.
About the Role:
Our infrastructure powers millions of merchants processing hundreds of billions in commerce. You will design, build, and operate resilient distributed systems and global Kubernetes clusters.

What you'll do:
- Design and scale distributed cloud infrastructure across multi-cloud environments.
- Build resilient automation for capacity planning, autoscaling, and disaster recovery.
- Collaborate with development teams to establish SLOs, SLIs, and error budgets.
- Participate in on-call rotation and lead root-cause analysis (RCA) post-mortems.

What you bring:
- 5+ years of experience operating production Kubernetes clusters at enterprise scale.
- Strong proficiency in Go, Python, or Ruby and deep understanding of Linux systems internals.
- Proven expertise with Infrastructure as Code (Terraform) and cloud networking.
- Demonstrated experience with high-availability distributed systems (99.99% SLA).
- Based in Canada with legal authorization to work.""",
    }
    (jobs_dir / "senior_devops_engineer.json").write_text(
        json.dumps(sre_job, indent=2), encoding="utf-8"
    )

    return {
        "id": "persona_4_cloud_engineer",
        "name": "Amina Diallo",
        "domain": "Cloud Infrastructure & SRE",
        "files": ["cv_cloud_engineer.txt", "cv_cloud_engineer.pdf"],
        "targetJobs": ["senior_devops_engineer.json"],
    }


def main():
    print(f"Initializing test cases directory: {TEST_DIR}")
    TEST_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {"version": "1.0", "personas": []}

    print("Setting up Persona 1: Senior Policy Specialist...")
    p1 = setup_persona_1(TEST_DIR / "persona_1_policy")
    manifest["personas"].append(p1)

    print("Setting up Persona 2: Microbiology Researcher (14 publications)...")
    p2 = setup_persona_2(TEST_DIR / "persona_2_microbiology")
    manifest["personas"].append(p2)

    print("Setting up Persona 3: Clinical Pharmacist (Hospital & Licensing)...")
    p3 = setup_persona_3(TEST_DIR / "persona_3_pharmacist")
    manifest["personas"].append(p3)

    print("Setting up Persona 4: Cloud Infrastructure Engineer...")
    p4 = setup_persona_4(TEST_DIR / "persona_4_cloud_engineer")
    manifest["personas"].append(p4)

    manifest_path = TEST_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Successfully generated test fixtures. Manifest written to {manifest_path}")


if __name__ == "__main__":
    main()
