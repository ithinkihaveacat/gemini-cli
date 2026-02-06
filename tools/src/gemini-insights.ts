/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getProjectHash } from "@google/gemini-cli-core/dist/src/utils/paths.js";
import { partListUnionToString } from "@google/gemini-cli-core/dist/src/core/geminiRequest.js";
import type {
  ConversationRecord,
  MessageRecord
} from "@google/gemini-cli-core/dist/src/services/chatRecordingService.js";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const ANALYSIS_MODEL = "gemini-3-flash-preview";

interface SessionInsight {
  tools?: Array<{
    category: string;
    specific_tool: string;
    params?: string;
    is_edge_case: boolean;
    human_suggested: boolean;
    notes?: string;
  }>;
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY

Extracts tool usage insights from Gemini CLI logs for a given directory.

Arguments:
  DIRECTORY         The directory to look up history for.

Options:
  -h, --help        Display this help message and exit

Environment:
  GEMINI_API_KEY    Required. Your Gemini API key.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: {
        type: "boolean",
        short: "h"
      }
    },
    allowPositionals: true
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  if (positionals.length === 0) {
    usage();
    process.exit(1);
  }

  const targetDirArg = positionals[0];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  const genAI = new GoogleGenAI({ apiKey });

  // Check if the target directory itself exists
  const resolvedTargetDir = path.resolve(targetDirArg);
  if (
    !fs.existsSync(resolvedTargetDir) ||
    !fs.statSync(resolvedTargetDir).isDirectory()
  ) {
    console.error(`Error: Directory '${resolvedTargetDir}' does not exist.`);
    process.exit(1);
  }

  const hash = getProjectHash(resolvedTargetDir);
  const geminiTmp = path.join(os.homedir(), ".gemini/tmp", hash);
  const chatsDir = path.join(geminiTmp, "chats");

  if (!fs.existsSync(chatsDir)) {
    console.error(`Error: No 'chats' subdirectory found in: ${geminiTmp}`);
    // It's possible there are no chats yet.
    process.exit(0);
  }

  const chatFiles = fs
    .readdirSync(chatsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(chatsDir, f));

  if (chatFiles.length === 0) {
    console.log("No chat logs found.");
    process.exit(0);
  }

  console.error(`Found ${chatFiles.length} log files. Analyzing...`);

  const sessionInsights: SessionInsight[] = [];

  // Limit concurrency to avoid rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < chatFiles.length; i += BATCH_SIZE) {
    const batch = chatFiles.slice(i, i + BATCH_SIZE);
    const promises = batch.map((file) => processLogFile(file, genAI));
    const results = await Promise.all(promises);
    sessionInsights.push(
      ...results.filter((r): r is SessionInsight => r !== null)
    );
    console.error(
      `Processed ${Math.min(i + BATCH_SIZE, chatFiles.length)}/${chatFiles.length}...`
    );
  }

  if (sessionInsights.length === 0) {
    console.log("No insights extracted.");
    process.exit(0);
  }

  console.error("Aggregating insights...");
  const finalReport = await aggregateInsights(sessionInsights, genAI);
  console.log(finalReport);
}

async function processLogFile(
  filePath: string,
  genAI: GoogleGenAI
): Promise<SessionInsight | null> {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const session: ConversationRecord = JSON.parse(content);

    // Extract text representation
    const transcript = session.messages
      .map((m: MessageRecord) => {
        const role = m.type.toUpperCase();
        const text = partListUnionToString(m.content);
        return `${role}: ${text}`;
      })
      .join("\n\n");

    if (!transcript.trim()) return null;

    // Use Gemini to extract insights
    const prompt = `
Analyze the following AI agent log and extract insights about the TOOLS used.
Focus on:
1. Broad tool categories (e.g. 'Android Emulator', 'File System', 'Source Code Search').
2. Specific tools/commands used (e.g. 'emumanager start', 'grep', 'adb shell').
3. Parameters and constraints (e.g. 'API level 30', 'androidx.lifecycle').
4. Edge cases: Unusual tools, or efficient use of specific tools.
5. Human intervention: Did the human suggest a tool?
6. Alternatives: Was a better tool chosen over a worse one?

Return a JSON object with this structure:
{
  "tools": [
    {
      "category": "string",
      "specific_tool": "string",
      "params": "string (summary of params)",
      "is_edge_case": boolean,
      "human_suggested": boolean,
      "notes": "string (why used, alternatives, etc)"
    }
  ]
}

LOG:
${transcript.slice(0, 50000)} 
`;

    const result = await genAI.models.generateContent({
      model: ANALYSIS_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tools: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  specific_tool: { type: Type.STRING },
                  params: { type: Type.STRING },
                  is_edge_case: { type: Type.BOOLEAN },
                  human_suggested: { type: Type.BOOLEAN },
                  notes: { type: Type.STRING }
                },
                required: [
                  "category",
                  "specific_tool",
                  "is_edge_case",
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
    return JSON.parse(text);
  } catch (e) {
    console.error(`Failed to process ${path.basename(filePath)}:`, e);
    return null;
  }
}

async function aggregateInsights(
  insights: SessionInsight[],
  genAI: GoogleGenAI
): Promise<string> {
  const allTools = insights.flatMap((i) => i.tools || []);

  const prompt = `
You are aggregating tool usage reports from multiple AI sessions.
Input: A JSON list of tool usages.

Task:
Create a comprehensive report with:
1. **Categories**: 5-10 broad categories of tools used.
2. **Detailed Breakdown**: Under each category, list specific tools and how they were used.
3. **Edge Cases & Highlights**: Specifically highlight unusual tools, efficient alternatives (e.g. adb-screenshot vs screencap), and complex constraints (e.g. specific versions).
4. **Human-AI Collaboration**: Highlight cases where humans suggested tools.

Format the output as a clean, readable Markdown report.

INPUT DATA:
${JSON.stringify(allTools, null, 2).slice(0, 100000)}
`;

  const result = await genAI.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return result.text || "No report generated.";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
