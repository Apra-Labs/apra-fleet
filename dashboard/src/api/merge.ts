/**
 * Task merge API — POST /api/tasks/merge (#66)
 *
 * Merges 2+ tasks into a single task using the configured LLM.
 * On LLM failure, originals are preserved and a 502 is returned.
 */

import type { FastifyInstance } from "fastify";
import { getTasks, deleteTasks, upsertTasks, TASKS_COLUMNS, type Task } from "./json-store.js";
import { getConfig, getProviderName } from "./config.js";
import { getProvider, type LlmOptions } from "./llm.js";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildMergePrompt(tasks: Task[], userPrompt?: string): string {
  const today = new Date().toISOString().split("T")[0];

  const taskList = tasks
    .map((t, i) => {
      const lines = [
        `Task ${i + 1} (ID: ${t.id}):`,
        `  Title: ${t.item || "(none)"}`,
        `  Status: ${t.status || "(none)"}`,
        `  Priority: ${t.priority || "(none)"}`,
        `  Owner: ${t.owner || "(none)"}`,
        `  Customer: ${t.customer || "(none)"}`,
        `  Project: ${t.project || "(none)"}`,
        `  Notes: ${t.notes || "(none)"}`,
        `  Source: ${t.source || "(none)"} / ${t.workspace || ""} / ${t.channel || ""}`,
        `  Link: ${t.link || "(none)"}`,
        `  Due date: ${t.due_date || "(none)"}`,
      ];
      return lines.join("
");
    })
    .join("

");

  const pinnedAny = tasks.some((t) => t.pinned === "true");

  return `You are merging ${tasks.length} tasks into a single unified task.

TASKS TO MERGE:
${taskList}

MERGE RULES:
1. Combine information into a single coherent task
2. Status: pick most active (in_progress > pending > blocked > done > cancelled)
3. Priority: keep the highest (high > medium > low)
4. Owner: pick based on context; combine if both are relevant
5. Notes: merge intelligently — combine unique information, avoid duplication
6. Link: keep the most relevant/recent source link
7. created: use the earliest date across all tasks
8. updated: use today (${today})
9. Keep customer and project from the most specific/relevant task
10. source, workspace, channel: from the primary task (first listed)
${pinnedAny ? "11. pinned: set to "true" (one or more source tasks was pinned)" : ""}
${userPrompt ? `
ADDITIONAL GUIDANCE FROM USER: ${userPrompt}` : ""}

CRITICAL: Return ONLY a single JSON object. No prose, no markdown, no code fences.
Use the ID of the first task (${tasks[0]?.id ?? "T000"}) as the merged task's ID.

Required JSON shape (all fields must be present as strings):
{
  "id": "${tasks[0]?.id ?? "T000"}",
  "customer": "...",
  "item": "...",
  "status": "pending|in_progress|done|blocked|cancelled|note",
  "priority": "high|medium|low|",
  "owner": "...",
  "requested_by": "...",
  "project": "...",
  "source": "...",
  "workspace": "...",
  "channel": "...",
  "due_date": "...",
  "link": "...",
  "notes": "...",
  "created": "...",
  "updated": "${today}"${pinnedAny ? ',
  "pinned": "true"' : ""}
}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseMergeResponse(output: string): Task {
  let text = output.trim();

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // Extract by brace boundaries to handle trailing prose
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`LLM output is not valid JSON. First 300 chars: ${text.slice(0, 300)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM output did not produce a JSON object");
  }

  // Validate required columns
  const obj = parsed as Record<string, unknown>;
  const missing = TASKS_COLUMNS.filter((col) => !(col in obj));
  if (missing.length > 0) {
    throw new Error(`Merged task missing required fields: ${missing.join(", ")}`);
  }

  // Ensure all values are strings (coerce if needed)
  const task: Task = {};
  for (const col of TASKS_COLUMNS) {
    const val = obj[col];
    task[col] = typeof val === "string" ? val : val == null ? "" : String(val);
  }
  // Preserve optional columns present in the response
  for (const key of Object.keys(obj)) {
    if (!(key in task)) {
      const val = obj[key];
      task[key] = typeof val === "string" ? val : val == null ? "" : String(val);
    }
  }

  return task;
}

// ---------------------------------------------------------------------------
// Route handler + registration
// ---------------------------------------------------------------------------

export async function mergeRoutes(app: FastifyInstance) {
  /**
   * POST /api/tasks/merge
   * Body: { ids: string[], prompt?: string }
   *
   * Responses:
   *   200 — merged task inserted, originals deleted. Body: { task, warning? }
   *   400 — fewer than 2 IDs
   *   404 — one or more IDs not found
   *   502 — LLM failed / invalid response (originals preserved)
   *   503 — LLM command not found
   */
  app.post<{ Body: { ids: string[]; prompt?: string } }>(
    "/api/tasks/merge",
    async (request, reply) => {
      const { ids, prompt: userPrompt } = request.body ?? {};

      if (!Array.isArray(ids) || ids.length < 2) {
        return reply.status(400).send({ error: "merge requires at least 2 task IDs" });
      }

      // Validate all IDs exist
      const allTasks = getTasks();
      const taskMap = new Map(allTasks.map((t) => [t.id, t]));
      const missingIds = ids.filter((id) => !taskMap.has(id));
      if (missingIds.length > 0) {
        return reply.status(404).send({ error: `Task ID(s) not found: ${missingIds.join(", ")}` });
      }

      const sourceTasks = ids.map((id) => taskMap.get(id)!);

      // Build prompt
      const prompt = buildMergePrompt(sourceTasks, userPrompt);

      // Get LLM config
      const providerName = getProviderName();
      const provider = getProvider(providerName);
      const llmConfig = getConfig().llm || {};
      const llmOptions: LlmOptions = {
        model: llmConfig.model,
        response_format: { type: "json_object" },
      };

      let llmOutput: string;
      try {
        llmOutput = await provider.complete(prompt, llmOptions);
      } catch (err: any) {
        const isNotFound = err.message.includes("not found");
        return reply
          .status(isNotFound ? 503 : 502)
          .send({ error: err.message });
      }

      // Parse LLM response
      let mergedTask: Task;
      try {
        mergedTask = parseMergeResponse(llmOutput);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({
          error: `LLM returned an invalid response: ${msg}`,
          raw: llmOutput.slice(0, 500),
        });
      }

      // Atomic: verify originals still exist before deleting
      const currentTasks = getTasks();
      const currentMap = new Map(currentTasks.map((t) => [t.id, t]));
      const stillMissing = ids.filter((id) => !currentMap.has(id));
      if (stillMissing.length > 0) {
        return reply.status(409).send({
          error: `Conflict: task(s) modified or deleted during merge: ${stillMissing.join(", ")}`,
        });
      }

      // Delete originals, insert merged task
      // Remove originals from the list (all except id[0] — id[0] is reused as merged ID)
      await deleteTasks(ids.slice(1));
      await upsertTasks([mergedTask]);

      const response: Record<string, unknown> = { task: mergedTask };
      if (ids.length >= 10) {
        response.warning = `Large merge (${ids.length} tasks). Review merged result carefully.`;
      }

      return reply.status(200).send(response);
    }
  );
}
