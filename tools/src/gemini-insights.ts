/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agentic Loop Friction Report Tool
 *
 * Based on the "Legible Loop" concept:
 * The goal of the agentic loop is zero human intervention.
 * This tool identifies two main categories of failure:
 * 1. Absolute Tooling Failure (Missing Capabilities): The agent lacks the "senses" or "actuators" to complete the loop.
 * 2. Inefficient Tooling (Friction): Tools exist but are illegible, flaky, or slow, causing the agent to spiral.
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
import { DEFAULT_LEGACY_SET } from "@google/gemini-cli-core/dist/src/tools/definitions/model-family-sets/default-legacy.js";

const ANALYSIS_MODEL = "gemini-3-flash-preview";
const AGGREGATION_MODEL = "gemini-3-pro-preview";
const MAX_TOTAL_RETRIES = 10;
const MAX_RETRIES_PER_REQUEST = 3;
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills");
const MAX_CUSTOM_CONTEXT_BYTES = 100000;

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface MissingCapability {
  task_attempted: string;
  missing_sense_or_actuator: string;
  agent_response: "failed" | "hallucinated_success" | "asked_user";
  details: string;
}

interface IllegibleEnvironment {
  tool_used: string;
  tool_type: "system" | "custom";
  issue_type:
    | "truncated_output"
    | "cryptic_error"
    | "massive_trace"
    | "silent_failure"
    | "other";
  impact: "context_destroyed" | "confusion" | "false_positive";
  details: string;
}

interface FlakyOrSlowTool {
  tool_used: string;
  tool_type: "system" | "custom";
  issue_type: "flaky" | "slow";
  impact_on_loop: string;
  details: string;
}

interface StubbornWorkaround {
  goal: string;
  workaround_sequence: string[];
  custom_script_written: boolean;
  success: boolean;
  details: string;
}

interface LoopAnalysisInsight {
  sessionFile?: string;
  primary_goal?: string; // New field for session goal
  missing_capabilities?: MissingCapability[];
  illegible_environments?: IllegibleEnvironment[];
  flaky_or_slow_tools?: FlakyOrSlowTool[];
  stubborn_workarounds?: StubbornWorkaround[];
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY OUTPUT_FILE

Analyzes Gemini CLI logs to identify mechanical loop failures, tooling gaps, and environmental friction.
Produces an 'Agentic Loop Friction Report' Markdown report at the specified OUTPUT_FILE.

Arguments:
  DIRECTORY         The directory to look up history for.
  OUTPUT_FILE       The path to write the Markdown report to.

Options:
  --limit NUMBER        Limit analysis to the N most recent conversations (default: all).
  --skills-dir DIR      Directory containing agent skills (default: ~/.agents/skills).
  --dump-analysis FILE  Output intermediate analysis data to FILE (JSON format).
  -h, --help            Display this help message and exit

Environment:
  GEMINI_API_KEY    Required. Your Gemini API key.
`);
}

function loadSkillsDocumentation(skillsDir: string): string {
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    console.warn(
      `Warning: Skills directory not found at ${skillsDir}. Proceeding without custom tool context.`
    );
    return "No custom tool documentation available.";
  }

  let documentation = "";
  let validSkillCount = 0;
  const skillFolders = fs
    .readdirSync(skillsDir)
    .filter((f) => fs.statSync(path.join(skillsDir, f)).isDirectory());

  for (const skill of skillFolders) {
    const skillPath = path.join(skillsDir, skill);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    const commandIndexPath = path.join(
      skillPath,
      "references",
      "command-index.md"
    );

    if (fs.existsSync(skillMdPath)) {
      validSkillCount++;
      documentation += `\n--- Skill: ${skill} ---\n`;
      documentation += fs.readFileSync(skillMdPath, "utf8");
    }

    if (fs.existsSync(commandIndexPath)) {
      documentation += `\n--- Skill Reference: ${skill}/command-index ---\n`;
      documentation += fs.readFileSync(commandIndexPath, "utf8");
    }
  }

  if (validSkillCount === 0) {
    console.warn(
      `Warning: No valid skills (SKILL.md) found in ${skillsDir}. Analysis will lack custom tool context.`
    );
    return "No valid SKILL.md files found in skills directory.";
  }

  console.error(
    `Info: Loaded ${validSkillCount} custom skills from ${skillsDir}`
  );
  return documentation;
}

function loadSystemToolsDocumentation(): string {
  let documentation = "";
  for (const [key, tool] of Object.entries(DEFAULT_LEGACY_SET)) {
    if (typeof tool === "function") continue; // Skip dynamic tool factories
    documentation += `\n--- System Tool: ${tool.name} (id: ${key}) ---\n`;
    documentation += `Description: ${tool.description}\n`;
  }
  return documentation;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      "skills-dir": { type: "string" },
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
  const outputFileArg = positionals[1];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  const skillsDir = values["skills-dir"] || DEFAULT_SKILLS_DIR;
  const customToolContext = loadSkillsDocumentation(skillsDir);
  const systemToolContext = loadSystemToolsDocumentation();

  if (customToolContext.length > MAX_CUSTOM_CONTEXT_BYTES) {
    console.warn(
      `Warning: Custom tool context is very large (${formatBytes(Buffer.byteLength(customToolContext))} bytes). Truncating to ${formatBytes(MAX_CUSTOM_CONTEXT_BYTES)} to preserve context window.`
    );
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

  const outputDir = path.dirname(path.resolve(outputFileArg));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const projectsJsonPath = path.join(os.homedir(), ".gemini/projects.json");
  let hash = getProjectHash(resolvedTargetDir);
  if (fs.existsSync(projectsJsonPath)) {
    try {
      const projectsData = JSON.parse(
        fs.readFileSync(projectsJsonPath, "utf8")
      );
      if (projectsData.projects && projectsData.projects[resolvedTargetDir]) {
        hash = projectsData.projects[resolvedTargetDir];
      }
    } catch (e) {
      console.warn("Failed to read ~/.gemini/projects.json", e);
    }
  }

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
  ): Promise<BaseProcessResult<LoopAnalysisInsight> | null> => {
    return runWithRetry(
      () =>
        processLogFile(filePath, genAI, customToolContext, systemToolContext),
      {
        maxRetries: MAX_RETRIES_PER_REQUEST,
        onRetry: () => {
          totalRetries++;
          if (totalRetries > MAX_TOTAL_RETRIES) {
            console.error(
              `\nMax total retries (${MAX_TOTAL_RETRIES}) exceeded. Skipping ${path.basename(filePath)}.`
            );
            return false; // Stop retrying
          }
          return true; // Continue retrying
        }
      }
    );
  };

  const {
    results: insights,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes,
    failedCount,
    skippedCount
  } = await analyzeInParallel(
    chatFiles.map((f) => f.path),
    processLogFileWrapper
  );

  if (insights.length === 0) {
    console.log(
      "No insights extracted. All analysis attempts failed or returned empty."
    );
    process.exit(0);
  }

  if (values["dump-analysis"]) {
    fs.writeFileSync(
      values["dump-analysis"],
      JSON.stringify(insights, null, 2)
    );
    console.error(`Raw combined output written to: ${values["dump-analysis"]}`);
  }

  console.error("\nSynthesizing Agentic Loop Friction Report...");
  const metadata = {
    directory: resolvedTargetDir,
    totalFound: totalFoundCount,
    selectedCount: selectedCount,
    analyzedCount: insights.length,
    failedCount: failedCount,
    skippedCount: skippedCount,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes,
    startTime: chatFiles[chatFiles.length - 1]?.time
      ? new Date(chatFiles[chatFiles.length - 1].time).toISOString()
      : "Unknown",
    endTime: chatFiles[0]?.time
      ? new Date(chatFiles[0].time).toISOString()
      : "Unknown"
  };

  const report = await aggregateToolingGapAnalysis(
    insights,
    genAI,
    metadata,
    customToolContext,
    systemToolContext
  );

  if (!report) {
    console.error("Aggregation failed to produce a report.");
    process.exit(1);
  }

  fs.writeFileSync(outputFileArg, report);

  console.log(`\nSpec sheet written to: ${outputFileArg}`);
}

async function processLogFile(
  filePath: string,
  genAI: GoogleGenAI,
  customToolContext: string,
  systemToolContext: string
): Promise<BaseProcessResult<LoopAnalysisInsight> | null> {
  const resultData = readAndFormatChatLog(filePath);
  if (!resultData) return null;

  const { content: transcript, rawSize, filteredSize } = resultData;

  if (filteredSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Transcript for ${path.basename(filePath)} (${formatBytes(filteredSize)}) exceeds limit. This may consume excessive context.`
    );
  }

  const prompt = `
<role>
You are an expert Platform Engineer specializing in the design of agentic execution loops. Your goal is to make the environment "legible" to AI agents and eliminate friction, ensuring a "Legible Loop" where the agent can observe every state and act deterministically.
</role>

<system_tool_context>
The agent has access to the following built-in system tools.
${escapeHtml(systemToolContext)}
</system_tool_context>

<custom_tool_context>
The agent has access to the following custom skills/tools.
NOTE: These skills may have changed since the logs were generated. Treat this as reference context.

${escapeHtml(customToolContext.slice(0, MAX_CUSTOM_CONTEXT_BYTES))}
</custom_tool_context>

<instructions>
1. **Analyze the Loop**: Read the provided log excerpt to observe the agent's mechanical execution loop.
2. **Identify Primary Goal**: Summarize the agent's main objective in this session in 1 sentence (e.g., "Debugging a UI rendering issue in Wear OS tile").
3. **FILTER OUT Context Failures**: Ignore failures caused by vague user prompts, changing requirements, or business logic misunderstandings. Focus EXCLUSIVELY on the mechanical execution loop: tools, environment, legibility, and execution speed.
4. **Review Tool Usage**: Compare the agent's actions against the tool contexts.
    - **System Tools**: Evaluate built-in tools like 'read_file', 'replace', 'run_shell_command'. Are they efficient? Do they fail often?
    - **Custom Tools**: Evaluate custom skills like 'jetpack', 'adb'.
    - If the agent struggles to use a tool correctly, or gets confused by its output, log this as an **Inefficient Tooling (Friction)** (mapped to 'illegible_environments').
    - If the agent bypasses a tool to use raw shell commands (like 'curl' instead of 'jetpack source'), log this as a **Stubborn Workaround**.
5. **Extract Mechanical Breakdowns**: Populate the JSON schema identifying specific mechanical issues, categorized by "The Legible Loop" taxonomy:
    - **Missing Capabilities (Absolute Tooling Failure)**: The agent hit a wall because it lacked a "sense" or actuator. It physically could not observe the state or effect a change.
    - **Illegible Environments (Inefficient Tooling)**: The tool existed, but actively hindered the loop. Output was truncated, cryptic, massive, or silent. **CRITICAL**: Identify if the tool is 'system' or 'custom'.
    - **Flaky or Slow Tools (Inefficient Tooling)**: Tools that broke the tight iteration loop by taking too long or failing randomly.
    - **Stubborn Workarounds**: Look for loud alarms! Did the agent write a custom script (Python/Bash) to parse a log? Did it chain 5 \`grep\`/\`sed\` commands together because a default tool output was bad?

**IMPORTANT EXCLUSION:**
If you see the text \`[ANALYSIS_SCRIPT_TRUNCATED_THIS_LOG_FOR_BREVITY_THE_AGENT_SAW_FULL_CONTENT]\`, this was inserted by the analysis script you are currently running. The original agent **SAW THE FULL CONTENT**. Do NOT report this as a truncation failure or illegible environment. Only report truncation if the *tool output itself* says "Output truncated" or similar.
</instructions>

<constraints>
- Output must be valid JSON matching the provided schema.
- Be extremely specific in 'details'.
- If a category has no instances in this log, return an empty array for that category.
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
          primary_goal: {
            type: Type.STRING,
            description: "1-sentence summary of the session's objective."
          },
          missing_capabilities: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task_attempted: { type: Type.STRING },
                missing_sense_or_actuator: { type: Type.STRING },
                agent_response: {
                  type: Type.STRING,
                  enum: ["failed", "hallucinated_success", "asked_user"]
                },
                details: { type: Type.STRING }
              },
              required: [
                "task_attempted",
                "missing_sense_or_actuator",
                "agent_response",
                "details"
              ]
            }
          },
          illegible_environments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tool_used: { type: Type.STRING },
                tool_type: { type: Type.STRING, enum: ["system", "custom"] },
                issue_type: {
                  type: Type.STRING,
                  enum: [
                    "truncated_output",
                    "cryptic_error",
                    "massive_trace",
                    "silent_failure",
                    "other"
                  ]
                },
                impact: {
                  type: Type.STRING,
                  enum: ["context_destroyed", "confusion", "false_positive"]
                },
                details: { type: Type.STRING }
              },
              required: [
                "tool_used",
                "tool_type",
                "issue_type",
                "impact",
                "details"
              ]
            }
          },
          flaky_or_slow_tools: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tool_used: { type: Type.STRING },
                tool_type: { type: Type.STRING, enum: ["system", "custom"] },
                issue_type: {
                  type: Type.STRING,
                  enum: ["flaky", "slow"]
                },
                impact_on_loop: { type: Type.STRING },
                details: { type: Type.STRING }
              },
              required: [
                "tool_used",
                "tool_type",
                "issue_type",
                "impact_on_loop",
                "details"
              ]
            }
          },
          stubborn_workarounds: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                goal: { type: Type.STRING },
                workaround_sequence: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                custom_script_written: { type: Type.BOOLEAN },
                success: { type: Type.BOOLEAN },
                details: { type: Type.STRING }
              },
              required: [
                "goal",
                "workaround_sequence",
                "custom_script_written",
                "success",
                "details"
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
    console.error(`Failed to parse JSON for ${path.basename(filePath)}`);
    return null;
  }

  data.sessionFile = filePath;

  return {
    insight: data,
    rawSize: rawSize,
    filteredSize: filteredSize
  };
}

async function aggregateToolingGapAnalysis(
  insights: LoopAnalysisInsight[],
  genAI: GoogleGenAI,
  metadata: {
    directory: string;
    totalFound: number;
    selectedCount: number;
    analyzedCount: number;
    failedCount: number;
    skippedCount: number;
    totalRawBytes: number;
    totalFilteredBytes: number;
    totalSummarizedBytes: number;
    startTime: string;
    endTime: string;
  },
  customToolContext: string,
  systemToolContext: string
): Promise<string | null> {
  // Filter out empty sessions to save context
  const sessionData = insights
    .map((insight) => ({
      session: insight.sessionFile
        ? path.basename(insight.sessionFile)
        : "unknown",
      primary_goal: insight.primary_goal || "Unknown",
      missing_capabilities: insight.missing_capabilities || [],
      illegible_environments: insight.illegible_environments || [],
      flaky_or_slow_tools: insight.flaky_or_slow_tools || [],
      stubborn_workarounds: insight.stubborn_workarounds || []
    }))
    .filter(
      (s) =>
        s.missing_capabilities.length > 0 ||
        s.illegible_environments.length > 0 ||
        s.flaky_or_slow_tools.length > 0 ||
        s.stubborn_workarounds.length > 0
    );

  const goalSummary = insights
    .map((i) => `- ${i.primary_goal}`)
    .slice(0, 50)
    .join("\n"); // Sample top 50 goals for context

  if (sessionData.length === 0) {
    console.warn(
      "No mechanical friction points found in the processed logs. Nothing to aggregate."
    );
    return "# Agentic Loop Friction Report\n\nNo significant mechanical friction or tooling gaps detected in this dataset.";
  }

  const inputData = JSON.stringify(sessionData, null, 2);
  const inputSize = Buffer.byteLength(inputData, "utf8");

  if (inputSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Extracted JSON data (${formatBytes(inputSize)}) exceeds limit of ${formatBytes(MAX_AGGREGATION_BYTES)}.` +
        ` The LLM may drop context or reject the request.`
    );
  }

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const prompt = `
<role>
You are a Staff Platform Engineer responsible for building the foundational environment for autonomous coding agents.
</role>

<context>
Target Directory: ${metadata.directory}
Analysis Date: ${now}
Data Span: ${metadata.startTime} to ${metadata.endTime}
Logs Analyzed: ${metadata.analyzedCount}
Logs with Detected Friction: ${sessionData.length}
</context>

<session_goals_sample>
${goalSummary}
</session_goals_sample>

<system_tool_context>
The agent had access to the following system tools.
${escapeHtml(systemToolContext)}
</system_tool_context>

<custom_tool_context>
The agent had access to the following custom tools.
${escapeHtml(customToolContext.slice(0, MAX_CUSTOM_CONTEXT_BYTES))}
</custom_tool_context>

<concept_context>
**The Legible Loop**: The ideal agentic loop is a straight line where the agent observes, acts, and verifies without friction.
Failures fall into two buckets:
1. **Absolute Tooling Failure (Missing Capabilities)**: The agent physically cannot "see" or "act" (e.g., cannot inspect a UI hierarchy).
2. **Inefficient Tooling (Friction)**: The tool exists but is illegible (cryptic errors, massive logs) or slow, causing the agent to spiral or invent workarounds.
</concept_context>

<instructions>
Synthesize the provided JSON telemetry of mechanical loop failures into a highly focused, actionable spec sheet.
Your goal is to identify exactly what tools need to be built or fixed to enable a frictionless, straight-line execution loop ("The Legible Loop").

**Report Structure:**

1.  **Header**:
    *   Title: "# Agentic Loop Friction Report: Tooling Gaps & Legibility"
    *   Date & Target Directory.
2.  **Executive Summary & Velocity Analysis**: 
    *   Briefly assess the mechanical environment's legibility.
    *   Analyze the **Session Density**: How intense was the debugging activity over the ${metadata.startTime} to ${metadata.endTime} period? Does high density correlate with specific friction types?
3.  **Absolute Tooling Failures (Missing Capabilities)**:
    *   Analyze the \`missing_capabilities\` array.
    *   Identify exactly what new tools, "senses", or MCP servers MUST be built because the agent fundamentally cannot observe or act on specific states (e.g. "Agent blindly guessing UI state because it cannot see the screen").
4. **Inefficient Tooling (Friction Overview)**:
    *   Analyze \`illegible_environments\` and \`flaky_or_slow_tools\`.
    *   Identify tools that exist but actively fight the agent's loop (e.g., massive logs, cryptic errors, slow builds).
5.  **System Tool Feedback (Built-in)**:
    *   Focus SPECIFICALLY on built-in tools like 'read_file', 'replace', 'run_shell_command'.
    *   Critique their "Legibility": Do they output clear, parseable text? Are they brittle?
    *   Recommend specific improvements (e.g., "Replace 'replace' with a unified diff tool").
6.  **Custom Tool Feedback (Domain Specific)**:
    *   Focus SPECIFICALLY on custom tools (e.g., 'jetpack', 'adb').
    *   Critique their CLI interface: Is the output designed for a human or an agent?
    *   Recommend specific modifications (e.g., "Add a --json flag to the 'jetpack' tool").
7.  **Missed Opportunities (Tool Usage vs. Goals)**:
    *   Review the <session_goals_sample>. The agent was engaged in specific types of work (e.g. UI debugging, refactoring).
    *   Compare this against the <custom_tool_context>. **Are there available tools that perfectly matched these goals but were IGNORED or BYPASSED by the agent?**
    *   *Example:* "The agent spent 3 days debugging Widgets but never called the available \`widget-switch\` tool."
    *   Critique the tool discovery: Why did the agent miss it? (Description too vague? Too hard to invoke?)
8. **Emergent Tools (Actionable Workarounds)**:
    *   Analyze \`stubborn_workarounds\`.
    *   List the clever, brittle scripts or massive command chains the agent invented.
    *   **Recommendation**: Specify which of these workarounds we should immediately formalize into reliable, permanent tools.
</instructions>

<input_data>
${inputData}
</input_data>
`;

  const result = await genAI.models.generateContent({
    model: AGGREGATION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });

  return result.text || null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
