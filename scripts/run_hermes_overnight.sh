#!/usr/bin/env bash
# run_hermes_overnight.sh
# Master overnight execution script for Hermes to benchmark and compare Jobist vs aijobsearch
# across multiple LLM models (Gemma 4 4B, Qwen 3.8 27B, Qwen 3.8 Flash Next MoE).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/test_cases/hermes_overnight.log"
NIGHTLY_LOG="$PROJECT_ROOT/test_cases/hermes_nightly_log.md"

mkdir -p "$PROJECT_ROOT/test_cases"

echo "=================================================================" >> "$LOG_FILE"
echo "HERMES OVERNIGHT BENCHMARK RUN: $(date -Iseconds)" >> "$LOG_FILE"
echo "=================================================================" >> "$LOG_FILE"

# 1. Check LM Studio is reachable
if ! curl -s -m 5 http://127.0.0.1:1234/v1/models >/dev/null; then
  echo "ERROR: LM Studio is not responding at http://127.0.0.1:1234" | tee -a "$LOG_FILE"
  exit 1
fi

# 2. Check Jobist local server on port 8080, start if needed
if ! curl -s -m 3 http://127.0.0.1:8080 >/dev/null; then
  echo "Jobist server not responding on 8080. Starting server.py..." | tee -a "$LOG_FILE"
  nohup python3 "$PROJECT_ROOT/server.py" > "$PROJECT_ROOT/test_cases/server_overnight.log" 2>&1 &
  sleep 2
fi

# 3. Run the primary comparative evaluation suite
echo "Running compare_aijobsearch_jobist.py..." | tee -a "$LOG_FILE"
cd "$PROJECT_ROOT"
python3 "$PROJECT_ROOT/scripts/compare_aijobsearch_jobist.py" >> "$LOG_FILE" 2>&1

# 4. Run the multi-model comparative suite
echo "Running compare_models.py..." | tee -a "$LOG_FILE"
python3 "$PROJECT_ROOT/scripts/compare_models.py" >> "$LOG_FILE" 2>&1

# 5. Invoke Hermes to perform the overnight audit & log findings
echo "Invoking Hermes to audit results and prepare morning briefing..." | tee -a "$LOG_FILE"

HERMES_PROMPT="You are the Hermes autonomous overnight agent auditing the Jobist comparative and multi-model benchmark runs.
Working Directory: $PROJECT_ROOT

Tasks:
1. Read '$PROJECT_ROOT/test_cases/overnight_comparison_report.md' and '$PROJECT_ROOT/test_cases/model_comparison_report.md'.
2. Check the metric fidelity, portal scan yields, and apply drafting status across all 4 personas:
   - Senior Policy Specialist (persona_1_policy)
   - Dr. Elena Rostova - Microbiology Researcher (persona_2_microbiology)
   - Marcus Vance - Clinical Pharmacist (persona_3_pharmacist)
   - Amina Diallo - Cloud Infrastructure Engineer (persona_4_cloud_engineer)
3. Audit multi-model performance:
   - Compare Gemma 4 4B vs Qwen 3.8 27B vs Qwen 3.8 Flash Next.
   - Note any context limit bottlenecks, dropped metrics, token throughput differences, or hallucination signals.
4. Append an executive log entry to '$NIGHTLY_LOG' with:
   - Run timestamp
   - High-level score table
   - Any issues, edge-case observations, or suggested prompt/template refinements
   - Confirmation of system health for the user's morning review.
Keep your response concise and focused on actionable findings."

# Execute Hermes with auto-approval in the Jobist workspace
hermes --yolo -z "$HERMES_PROMPT" >> "$LOG_FILE" 2>&1

echo "Hermes overnight run completed at $(date -Iseconds)." | tee -a "$LOG_FILE"
