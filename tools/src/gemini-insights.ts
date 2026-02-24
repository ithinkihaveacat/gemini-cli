/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getProjectHash } from "@google/gemini-cli-core/dist/src/utils/paths.js";
import {
  analyzeInParallel,
  formatBytes,
  readAndFormatChatLog,
  runWithRetry,
  MAX_AGGREGATION_BYTES
} from "./analysis-utils.js";
import type { BaseProcessResult } from "./analysis-utils.js";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const ANALYSIS_MODEL = "gemini-3-flash-preview";
const AGGREGATION_MODEL = "gemini-3.1-pro-preview";
const MAX_TOTAL_RETRIES = 10;
const MAX_RETRIES_PER_REQUEST = 3;

interface FrictionPoint {
  task_description: string;
  friction_type:
    | "autonomous_retry"
    | "user_intervention"
    | "hunting"
    | "repetition"
    | "tool_failure"
    | "other";
  root_cause:
    | "environment_issue"
    | "model_hallucination"
    | "tool_limitation"
    | "user_ambiguity"
    | "complex_task"
    | "unknown";
  user_sentiment: "frustrated" | "helpful" | "neutral" | "absent";
  severity: "low" | "medium" | "high";
  resolution: "success" | "failure" | "partial";
  details: string;
  user_quote?: string;
}

interface ToolUsage {
  category: string;
  specific_tool: string;
  params?: string;
  usage_pattern:
    | "standard"
    | "workaround"
    | "exploration"
    | "verification"
    | "other";
  effectiveness: "high" | "medium" | "low" | "failed";
  gap_identified: boolean;
  human_suggested: boolean;
  notes?: string;
}

interface CombinedInsight {
  sessionFile?: string;
  friction_points?: FrictionPoint[];
  tools?: ToolUsage[];
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY OUTPUT_DIR

Extracts both friction insights and tool usage reports from Gemini CLI logs for a given directory.
Produces 'friction-report.md' and 'tooling-requirements.md' in the OUTPUT_DIR.

Arguments:
  DIRECTORY         The directory to look up history for.
  OUTPUT_DIR        The directory to write the Markdown reports to.

Options:
  --limit NUMBER        Limit analysis to the N most recent conversations (default: all).
  --dump-analysis FILE  Output intermediate analysis data to FILE (JSON format).
  -h, --help            Display this help message and exit

Environment:
  GEMINI_API_KEY    Required. Your Gemini API key.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      "dump-analysis": { type: "string" }
    },
    allowPositionals: true
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  if (positionals.length < 2) {
    usage();
    process.exit(1);
  }

  const targetDirArg = positionals[0];
  const outputDirArg = positionals[1];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  const genAI = new GoogleGenAI({ apiKey });

  const resolvedTargetDir = path.resolve(targetDirArg);
  if (
    !fs.existsSync(resolvedTargetDir) ||
    !fs.statSync(resolvedTargetDir).isDirectory()
  ) {
    console.error(`Error: Directory '${resolvedTargetDir}' does not exist.`);
    process.exit(1);
  }

  const resolvedOutputDir = path.resolve(outputDirArg);
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  } else if (!fs.statSync(resolvedOutputDir).isDirectory()) {
    console.error(`Error: Output path '${resolvedOutputDir}' is not a directory.`);
    process.exit(1);
  }

  const hash = getProjectHash(resolvedTargetDir);
  const geminiTmp = path.join(os.homedir(), ".gemini/tmp", hash);
  const chatsDir = path.join(geminiTmp, "chats");

  if (!fs.existsSync(chatsDir)) {
    console.error(`Error: No 'chats' subdirectory found in: ${geminiTmp}`);
    process.exit(0);
  }

  let chatFiles = fs
    .readdirSync(chatsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(chatsDir, f),
      time: fs.statSync(path.join(chatsDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time); // Newest first

  const totalFoundCount = chatFiles.length;

  if (totalFoundCount === 0) {
    console.log("No chat logs found.");
    process.exit(0);
  }

  // Filter based on limit
  if (values.limit) {
    const limit = parseInt(values.limit, 10);
    if (isNaN(limit) || limit <= 0) {
      console.error("Invalid limit specified.");
      process.exit(1);
    }
    chatFiles = chatFiles.slice(0, limit);
    console.error(`Analyzing most recent ${chatFiles.length} logs...`);
  } else {
    console.error(`Analyzing all ${chatFiles.length} logs...`);
  }

  const selectedCount = chatFiles.length;

  // Global retry counter for this run
  let totalRetries = 0;

  const processLogFileWrapper = async (
    filePath: string
  ): Promise<BaseProcessResult<CombinedInsight> | null> => {
    return runWithRetry(() => processLogFile(filePath, genAI), {
      maxRetries: MAX_RETRIES_PER_REQUEST,
      onRetry: () => {
        totalRetries++;
        if (totalRetries > MAX_TOTAL_RETRIES) {
          console.error(
            `
Max total retries (${MAX_TOTAL_RETRIES}) exceeded. Skipping ${path.basename(filePath)}.`
          );
          return false; // Stop retrying
        }
        return true; // Continue retrying
      }
    });
  };

  const {
    results: combinedInsights,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes,
    failedCount,
    skippedCount
  } = await analyzeInParallel(
    chatFiles.map((f) => f.path),
    processLogFileWrapper
  );

  if (combinedInsights.length === 0) {
    console.log("No insights extracted.");
    process.exit(0);
  }

  if (values["dump-analysis"]) {
    fs.writeFileSync(values["dump-analysis"], JSON.stringify(combinedInsights, null, 2));
    console.error(`Raw combined output written to: ${values["dump-analysis"]}`);
  }

  console.error("\nAggregating insights in parallel...");
  const metadata = {
    directory: resolvedTargetDir,
    totalFound: totalFoundCount,
    selectedCount: selectedCount,
    analyzedCount: combinedInsights.length,
    failedCount: failedCount,
    skippedCount: skippedCount,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes
  };

  // Run both aggregations in parallel
  const [frictionReport, toolReport] = await Promise.all([
    aggregateFrictionInsights(combinedInsights, genAI, metadata),
    aggregateToolInsights(combinedInsights, genAI, metadata)
  ]);

  const frictionFile = path.join(resolvedOutputDir, "friction-report.md");
  const toolFile = path.join(resolvedOutputDir, "tooling-requirements.md");

  fs.writeFileSync(frictionFile, frictionReport);
  fs.writeFileSync(toolFile, toolReport);

  console.log(`Friction report written to: ${frictionFile}`);
  console.log(`Tool usage report written to: ${toolFile}`);
}

async function processLogFile(
  filePath: string,
  genAI: GoogleGenAI
): Promise<BaseProcessResult<CombinedInsight> | null> {
  const resultData = readAndFormatChatLog(filePath);
  if (!resultData) return null;

  const { content: transcript, rawSize, filteredSize } = resultData;

  if (filteredSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Transcript for ${path.basename(filePath)} (${filteredSize} bytes) exceeds ${MAX_AGGREGATION_BYTES} bytes. This may consume excessive context.`
    );
  }

  const prompt = `
<role>
You are an expert software engineering analyst specializing in evaluating AI agent performance, identifying friction points, and evaluating the effectiveness of tools used by AI agents.
</role>

<instructions>
1. **Plan**: Read the entire log to understand the user's ultimate goal, the agent's strategy, and every tool invocation.
2. **Extract Friction Points**: Identify specific moments where the interaction broke down or slowed down.
    - **Friction Definition**:
        - **Autonomous Retries**: Loops or repeated variations without success.
        - **User Intervention**: User corrects, interrupts, or guides the agent.
        - **Hunting**: Blind searching (grep/find) for information.
        - **Tool Failure**: Tools crashing or returning useless data.
        - **Repetition**: Repeating the same mistake.
    - **Analyze Root Cause**: For each friction point, determine *why* it happened (e.g., tool crash, hallucination).
    - **Assess User Sentiment**: Look at the user's language (frustrated, helpful, neutral).
    - **Validate**: Ensure severity matches disruption. High severity means user *had* to intervene or task failed.
3. **Extract Tool Usage**: For each action, command execution, or tool invocation, extract:
    - **Category**: Broad classification (e.g., FileOps, Device, Build, Search).
    - **Specific Tool**: The exact command or skill (e.g., \`grep\`, \`adb-screenshot\`, \`gradlew\`).
    - **Usage Pattern**: \`standard\`, \`workaround\`, \`exploration\`, or \`verification\`.
    - **Effectiveness**: \`high\`, \`medium\`, \`low\`, or \`failed\`.
    - **Gap Identified**: \`true\` if the agent had to *write* a custom script (Python/Bash) because a standard tool didn't exist, or run >3 commands to do 1 simple thing.
</instructions>

<constraints>
- Output must be valid JSON matching the provided schema, containing both \`friction_points\` and \`tools\` arrays.
- Capture significant "read" operations as tools.
- Be specific in details and notes.
</constraints>

<log_excerpt>
${transcript}
</log_excerpt>
`;

  const result = await genAI.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          friction_points: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task_description: { type: Type.STRING },
                friction_type: {
                  type: Type.STRING,
                  enum: [
                    "autonomous_retry",
                    "user_intervention",
                    "hunting",
                    "repetition",
                    "tool_failure",
                    "other"
                  ]
                },
                root_cause: {
                  type: Type.STRING,
                  enum: [
                    "environment_issue",
                    "model_hallucination",
                    "tool_limitation",
                    "user_ambiguity",
                    "complex_task",
                    "unknown"
                  ]
                },
                user_sentiment: {
                  type: Type.STRING,
                  enum: ["frustrated", "helpful", "neutral", "absent"]
                },
                severity: {
                  type: Type.STRING,
                  enum: ["low", "medium", "high"]
                },
                resolution: {
                  type: Type.STRING,
                  enum: ["success", "failure", "partial"]
                },
                details: { type: Type.STRING },
                user_quote: { type: Type.STRING }
              },
              required: [
                "task_description",
                "friction_type",
                "root_cause",
                "user_sentiment",
                "severity",
                "resolution",
                "details"
              ]
            }
          },
          tools: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                specific_tool: { type: Type.STRING },
                params: { type: Type.STRING },
                usage_pattern: {
                  type: Type.STRING,
                  enum: [
                    "standard",
                    "workaround",
                    "exploration",
                    "verification",
                    "other"
                  ]
                },
                effectiveness: {
                  type: Type.STRING,
                  enum: ["high", "medium", "low", "failed"]
                },
                gap_identified: { type: Type.BOOLEAN },
                human_suggested: { type: Type.BOOLEAN },
                notes: { type: Type.STRING }
              },
              required: [
                "category",
                "specific_tool",
                "usage_pattern",
                "effectiveness",
                "gap_identified",
                "human_suggested"
              ]
            }
          }
        }
      }
    }
  });

  const text = result.text;
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`Failed to parse JSON for \${path.basename(filePath)}`);
    return null;
  }

  data.sessionFile = filePath;

  return {
    insight: data,
    rawSize: rawSize,
    filteredSize: filteredSize
  };
}

async function aggregateFrictionInsights(
  insights: CombinedInsight[],
  genAI: GoogleGenAI,
  metadata: any
): Promise<string> {
  const sessionData = insights
    .map((insight) => ({
      session: insight.sessionFile
        ? path.basename(insight.sessionFile)
        : "unknown",
      friction_points: insight.friction_points || []
    }))
    .filter((s) => s.friction_points.length > 0);

  const frictionCounts: Record<string, number> = {
    autonomous_retry: 0,
    user_intervention: 0,
    hunting: 0,
    repetition: 0,
    tool_failure: 0,
    other: 0
  };
  const rootCauseCounts: Record<string, number> = {
    environment_issue: 0,
    model_hallucination: 0,
    tool_limitation: 0,
    user_ambiguity: 0,
    complex_task: 0,
    unknown: 0
  };
  let totalFrictionPoints = 0;

  for (const insight of insights) {
    if (insight.friction_points) {
      for (const point of insight.friction_points) {
        if (point.friction_type && point.friction_type in frictionCounts) {
          frictionCounts[point.friction_type]++;
        } else {
          frictionCounts["other"]++;
        }

        if (point.root_cause && point.root_cause in rootCauseCounts) {
          rootCauseCounts[point.root_cause]++;
        } else {
          rootCauseCounts["unknown"]++;
        }
        totalFrictionPoints++;
      }
    }
  }

  const inputData = JSON.stringify(sessionData, null, 2);
  const inputSize = Buffer.byteLength(inputData, "utf8");

  if (inputSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Friction input data (${inputSize} bytes) exceeds limit of ${MAX_AGGREGATION_BYTES} bytes.`
    );
  }

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const prompt = `
<role>
You are a Product Manager and UX Researcher for an "AI for Android Development" platform.
</role>

<context>
Target Directory: ${metadata.directory}
Analysis Date: ${now}
Input Statistics:
- Total Logs Found: ${metadata.totalFound}
- Logs Selected for Analysis: ${metadata.selectedCount}
- Successfully Analyzed: ${metadata.analyzedCount}
- Failed Analysis: ${metadata.failedCount}

Friction Statistics:
- Total Friction Points: ${totalFrictionPoints}
- Autonomous Retries: ${frictionCounts.autonomous_retry}
- User Interventions: ${frictionCounts.user_intervention}
- Hunting: ${frictionCounts.hunting}
- Repetition: ${frictionCounts.repetition}
- Tool Failures: ${frictionCounts.tool_failure}

Root Cause Statistics:
- Environment Issues: ${rootCauseCounts.environment_issue}
- Model Hallucinations: ${rootCauseCounts.model_hallucination}
- Tool Limitations: ${rootCauseCounts.tool_limitation}
- User Ambiguity: ${rootCauseCounts.user_ambiguity}
- Complex Tasks: ${rootCauseCounts.complex_task}
</context>

<instructions>
Synthesize the provided JSON list of "Agent Friction Points" into a comprehensive "Friction & Failure Post-Mortem".
Identify systemic patterns in *why* the agent fails and *how* users react.

**Report Structure:**

1.  **Header**:
    *   Title: "# Gemini CLI Friction Post-Mortem"
    *   Date: "Date: ${now}"
    *   Target Directory: "Target Directory: ${metadata.directory}"
2.  **Executive Summary**: Is the agent reliable? What is the dominant failure mode?
3.  **Root Cause Analysis**:
    *   Analyze the provided "Root Cause Statistics".
    *   Are failures mostly environment or model based?
4.  **Tool Reliability Analysis**:
    *   Identify top failing tools and describe their failure modes.
5.  **User Sentiment & Intervention**:
    *   Are users frustrated or helpful? What triggers frustration?
6.  **Critical Failure Categories**:
    *   Group specific incidents into logical categories. Provide log examples.
7.  **"Hunting" Patterns**:
    *   What info is blindly searched for, and why?
8.  **Action Plan**:
    *   **P0 (Critical)**: Immediate fixes.
    *   **P1 (Strategic)**: New capabilities.
    *   **P2 (UX)**: Error/recovery flow improvements.
</instructions>

<input_data>
${inputData}
</input_data>
`;

  const result = await genAI.models.generateContent({
    model: AGGREGATION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return result.text || "No report generated.";
}

async function aggregateToolInsights(
  insights: CombinedInsight[],
  genAI: GoogleGenAI,
  metadata: any
): Promise<string> {
  const sessionData = insights
    .map((insight) => ({
      session: insight.sessionFile
        ? path.basename(insight.sessionFile)
        : "unknown",
      tools: insight.tools || []
    }))
    .filter((s) => s.tools.length > 0);

  const inputData = JSON.stringify(sessionData, null, 2);
  const inputSize = Buffer.byteLength(inputData, "utf8");

  if (inputSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Tool input data (${inputSize} bytes) exceeds limit of ${MAX_AGGREGATION_BYTES} bytes.`
    );
  }

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const prompt = `
<role>
You are a Product Manager for an "AI for Android Development" platform.
</role>

<context>
Target Directory: ${metadata.directory}
Analysis Date: ${now}
Input Statistics:
- Total Logs Found: ${metadata.totalFound}
- Successfully Analyzed: ${metadata.analyzedCount}
</context>

<instructions>
Synthesize the provided JSON list of tool usages into a comprehensive "Agent Capabilities & Tooling Requirements Report".
Inform the development of a standard toolset for Android-focused AI agents.

**Report Structure:**

1.  **Header**:
    *   Title: "# Gemini CLI Tool Usage Report"
    *   Date: "Date: ${now}"
    *   Target Directory: "Target Directory: ${metadata.directory}"
2.  **Executive Summary**: Overview of workflows and tool dependencies.
3.  **Tool Effectiveness Matrix**:
    *   Most used tools and typical \`effectiveness\` rating. Highlight low/failed tools.
4.  **Usage Pattern Analysis**:
    *   % of \`standard\` vs \`workaround\`. High-value \`exploration\` workflows.
5.  **Identified Capabilities Gaps**:
    *   Analyze instances where \`gap_identified\` is true. What scripts were written? What should be first-class tools?
6.  **Advanced Debugging Workflows**:
    *   Complex, multi-step workflows. "Super-human" debugging tools.
7.  **Recommendations for Future Tooling**:
    *   Prioritized list of tools/capabilities to add to the core platform.
</instructions>

<input_data>
${inputData}
</input_data>
`;

  const result = await genAI.models.generateContent({
    model: AGGREGATION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return result.text || "No report generated.";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
