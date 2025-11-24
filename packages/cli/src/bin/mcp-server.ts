/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ShellExecutionService,
  stripShellWrapper,
} from '@google/gemini-cli-core';
import path from 'node:path';
import process from 'node:process';

const server = new McpServer({
  name: 'gemini-cli-mcp',
  version: '1.0.0',
});

server.registerTool(
  'run_shell_command',
  {
    description: 'Executes a shell command',
    inputSchema: {
      command: z.string().describe('The command to execute'),
      description: z.string().optional().describe('Description of the command'),
      dir_path: z.string().optional().describe('Directory to execute in'),
    },
  },
  async ({ command, dir_path }) => {
    const cwd = dir_path
      ? path.resolve(process.cwd(), dir_path)
      : process.cwd();
    const cleanCommand = stripShellWrapper(command);

    // We use a fresh AbortController for each request.
    // In a future iteration, we could wire this up to MCP cancellation tokens.
    const abortController = new AbortController();

    // Execute the command. We don't use PTY for this headless MCP server to ensure
    // clean output capture and avoid terminal control codes complicating the response,
    // unless specifically requested or needed. Defaulting to false for safety.
    const { result } = await ShellExecutionService.execute(
      cleanCommand,
      cwd,
      () => {
        // We rely on the final accumulated result for now.
        // Streaming support could be added later via MCP notifications if the protocol supports it.
      },
      abortController.signal,
      false, // shouldUseNodePty
      {},
    );

    const executionResult = await result;

    // Format output to match the textual representation used in ShellTool
    const finalError = executionResult.error
      ? executionResult.error.message
      : '(none)';

    // Reconstruct what ShellTool would output
    const output = [
      `Command: ${command}`,
      `Directory: ${dir_path || '(root)'}`,
      `Output: ${executionResult.output || '(empty)'}`,
      `Error: ${finalError}`,
      `Exit Code: ${executionResult.exitCode ?? '(none)'}`,
      `Signal: ${executionResult.signal ?? '(none)'}`,
    ].join('\n');

    return {
      content: [{ type: 'text', text: output }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
