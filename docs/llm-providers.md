# The LLM layer

The LLM is an **optional intelligence layer**. Turn it off and you lose natural
language and prose explanations; you keep scheduling, rescheduling, risk
analysis, diffs, the CLI and the UI.

## The port

```ts
interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}
```

`LLMRequest` carries `system`, `messages`, `maxTokens`, `temperature` and an
optional `jsonSchema`. When `jsonSchema` is present the provider must return
JSON matching it, using whatever native mechanism it has.

| Provider                                                  | Structured output mechanism                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Anthropic                                                 | a single tool plus `tool_choice`, so the response is the tool input |
| OpenAI-compatible (OpenAI, OpenRouter, Ollama, llama.cpp) | `response_format: { type: 'json_schema' }`                          |
| Gemini                                                    | `generationConfig.responseMimeType` + `responseSchema`              |

Anything else falls back to `extractJson`, which tolerates code fences and
surrounding prose.

Current Anthropic models reject sampling parameters, so `temperature` is only
sent to models that accept it.

## What the LLM may do

It produces one JSON document: a list of typed commands.

```jsonc
{
  "intent": "Create the ML project and schedule it",
  "commands": [
    {
      "type": "create_task",
      "title": "Machine learning project",
      "estimatedMinutes": 480,
      "deadline": "2026-03-12T23:59:00Z",
    },
    { "type": "schedule" },
  ],
}
```

The available commands are `create_task`, `update_task`, `complete_task`,
`delete_task`, `schedule`, `reschedule`, `block_time`, `unblock_time`,
`find_time`, `explain_schedule`, `list_risks`, `list_schedule`, `list_tasks` and
`request_clarification`.

## What it may not do

- It never picks a time. The deterministic engine does that.
- It never touches the database or a calendar API.
- It cannot emit an action outside the schema: output is validated with zod, and
  a failure is fed back once with the validation errors before being rejected.
- It cannot approve its own changes; the automation policy still applies.

## Routing: one parser answers, never both

Exactly one parser interprets a request, decided per message:

| Configured provider | Who interprets your words        |
| ------------------- | -------------------------------- |
| `none`              | the deterministic rule parser    |
| anything else       | the model, for **every** request |

There is no "fast path" that lets the rule parser pre-empt a configured model.
Two identical phrasings must not behave differently depending on which parser
happened to answer first - that is impossible to reason about, and it made
simple sentences like _"I have a meeting tomorrow at 12:30"_ resolve
inconsistently.

Turning the model on or off in Settings takes effect on the next message; no
restart is needed.

### When the model is unreachable

A configured-but-failing model is **reported**, not papered over:

```
anthropic (claude-sonnet-5) could not interpret that request: <reason>.
While a model is configured it handles every request, so nothing was guessed.
Retry, or set the provider to "none" in Settings to use the built-in rule parser.
```

Silently answering with the rule parser would give the user a different
interpretation with no signal that anything went wrong. Scheduling itself is
unaffected either way: `plan`, `risks`, `sync` and the whole CLI never touch a
model.

### What the rule parser covers

When no model is set, these phrasings are understood without one:

| You type                                             | It produces                      |
| ---------------------------------------------------- | -------------------------------- |
| "What deadlines are at risk?"                        | `list_risks`                     |
| "Schedule my algorithms assignment"                  | `schedule` with the matched task |
| "I have a meeting tomorrow at 12:30pm"               | `create_event`                   |
| "Give me two hours for research tomorrow morning"    | `find_time`                      |
| "Move my work around tomorrow so I can leave by 4pm" | `reschedule` with `mustEndBy`    |
| "I need Friday afternoon completely free"            | `block_time`                     |
| "Why is my Friday so full?"                          | `explain_schedule`               |
| "What does tomorrow look like?"                      | `list_schedule`                  |

## Explanations

`explainPlan()` always renders a deterministic explanation from the structured
facts. If an LLM is configured it is asked to rephrase _those same facts_ - it is
explicitly told not to invent times, durations or reasons. Without a model the
deterministic rendering is returned unchanged.

## Testing

Tests never call a real model. `MockLLMProvider` takes scripted responses:

```ts
const llm = new MockLLMProvider([{ commands: [{ type: 'list_risks' }] }]);
```

`NullLLMProvider` is installed when no provider is configured; it throws a clear
message pointing at the configuration rather than failing obscurely.
