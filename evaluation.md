# Evaluation of `packages/cli/src/bin/mcp-run-shell-command.ts`

## Overview
The file implements a Model Context Protocol (MCP) server that exposes a single tool: `run_shell_command`. It uses the `@modelcontextprotocol/sdk` and leverages the internal `ShellExecutionService` from `@google/gemini-cli-core`.

## Quality
*   **Code Style**: The code is clean, well-formatted, and uses standard imports. It follows the project's coding conventions.
*   **Simplicity**: It effectively reuses existing logic (`ShellExecutionService`) rather than reinventing the wheel.
*   **Documentation**: The tool description is comprehensive, providing good examples for the LLM.

## Correctness
*   **Functionality**: It correctly sets up the MCP server, registers the tool, and connects via stdio.
*   **Path Handling**: It correctly handles `dir_path` resolution relative to the current working directory.
*   **Command sanitization**: It uses `stripShellWrapper` to clean inputs, which is a good practice.
*   **Async/Await**: Proper usage of async/await ensures non-blocking execution.

## Robustness
*   **Error Handling**: It has a top-level `main().catch()` block to handle server startup failures. The tool execution itself catches errors within `ShellExecutionService` (returning them in the result object), but the MCP handler itself relies on `await result` which might throw if the promise rejects. However, `ShellExecutionService` typically resolves with an error object rather than rejecting.
*   **Stream Handling**: The implementation merges `stdout` and `stderr` into a single string.
    *   *Critique*: This loses the distinction between output streams, which can be important for some tools or debugging. The `stderr` field in the output schema is explicitly set to empty string.
*   **Concurrency**: It creates a new `AbortController` for each request.
    *   *Critique*: It does not seem to hook into any MCP-provided cancellation token. If the client cancels the request, the shell command might continue running until completion.
*   **Interactive Commands**: `shouldUseNodePty` is set to `false`. This means interactive commands (like prompts) or those requiring a TTY might fail or hang. This is generally safer for an API but limits functionality compared to a full shell.

## Recommendations
1.  **Cancellation Support**: Investigate if MCP passes a cancellation signal and wire it to the `AbortController`.
2.  **Stream Separation**: if `ShellExecutionService` supports it, return distinct `stdout` and `stderr`.
3.  **Security**: While it "inherits the host environment", exposing a raw shell is inherently dangerous. It should ideally be sandboxed or heavily restricted, though that might be outside the scope of this specific file (it relies on the service).

---

# Feasibility of a Generic MCP System

## Feasibility: High
It is highly feasible to create a generic system to expose the core tools as MCP servers. The tools in `@packages/core/src/tools` follow a declarative pattern (`DeclarativeTool`) that maps well to MCP's tool definition.

## Strategy
1.  **Tool Adapter**: Create a generic adapter function that takes a `DeclarativeTool` instance and registers it with the `McpServer`.
    *   **Schema**: The `DeclarativeTool` provides a JSON Schema (`parametersJsonSchema`). The MCP SDK accepts this (either directly or wrapped in Zod).
    *   **Execution**: The adapter invokes `tool.buildAndExecute(params, signal)`.
    *   **Output**: The adapter converts `ToolResult` (text/markdown) into MCP's content format.

2.  **Configuration**: The main challenge is the `Config` object required by all core tools.
    *   We need to instantiate a `Config` object with appropriate defaults (cwd, storage paths, etc.).
    *   For `CodebaseInvestigator`, which is an Agent, we need to ensure the `AgentRegistry` is initialized. This requires `Config` to have a valid `GeminiClient` (or similar LLM client) set up, which implies authentication is available in the environment.

3.  **Target Tools**:
    *   All requested tools (Codebase Investigator, Edit, FindFiles, etc.) are available in `packages/core`.
    *   `CodebaseInvestigator` is available via `AgentRegistry` and wrapped as a tool.

## Plan
We will implement `packages/cli/src/bin/mcp-server.ts` which:
1.  Initializes a `Config` based on CLI arguments (or defaults).
2.  Creates a `ToolRegistry` (which instantiates all core tools).
3.  Iterates through the requested tools (or all available tools).
4.  Registers each one using the generic adapter.
