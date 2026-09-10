# Optional local semantic search with LM Studio

**Start with standard search.** An embedding model is not required to connect Obsidian, read notes, search keywords, inspect links, or edit notes.

Your chat model writes answers from retrieved evidence. An embedding model helps retrieve notes whose wording differs from your question. For example, “burnout” can retrieve a note about “exhaustion from work.”

## Setup

1. Complete the [basic connection](../README.md#quick-start).
2. In LM Studio, load an embedding model and start its local server. Nothing is downloaded by this plugin.
3. Open **MCP Vault Bridge → MCP clients → Search → Set up search by meaning…**.
4. Enter the base URL, normally `http://127.0.0.1:1234/v1`, and the exact embedding model identifier from your LM Studio installation. A chat-model identifier may not support embeddings.
5. Select **Test embedding request**. This sends only a synthetic “Connection test” string, not vault content. A successful response confirms the endpoint returns vectors; it is not a retrieval-quality benchmark.
6. Enable **Search by meaning** and reload your client's MCP servers. The adapter reads these saved settings automatically. Existing environment variables override matching settings.
7. Watch `index_status` or **Setup → Refresh status**. Standard search works while embeddings build.

If the endpoint needs a key, use the optional API-key field. It uses the plugin's secret-storage approach; older hosts may use the labeled plugin-data fallback.

## A tested local example

A synthetic-vault smoke test on 2026-09-09 used LM Studio **0.4.20+1**, base URL `http://127.0.0.1:1234/v1`, and model identifier **`text-embedding-nomic-embed-text-v1.5@f32`**. Semantic search for “burnout and fatigue” ranked the sample wellbeing note first, despite different wording. Identifiers vary by installation; do not assume this exact one exists on yours.

The [Nomic model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) specifies task prefixes. The adapter adds `search_document: ` for note passages and `search_query: ` for questions when the model identifier contains `nomic-embed-text`. If your endpoint already applies them, use the [prefix overrides](reference.md#environment-variables) to avoid doubling them. No dimensionality reduction is requested.

This verifies one local setup, not every model or quantization. For another model, test both the endpoint and several questions whose correct source notes you know.

## What happens if something fails?

| Situation | Behavior |
|---|---|
| No embedding configuration | Standard search; no embedding requests. |
| Model is still indexing | Standard search plus any available semantic candidates; coverage may be incomplete. |
| Endpoint stopped, model missing, or request failed | Keyword fallback, with the actual mode and reason in the result. |
| Model/endpoint/prefix changed | Separate vector identity; rebuild in the background after client reload. |
| Invalid response ordering or dimensions | Reject invalid vectors; keep standard search available. |

A full text refresh is available in Settings for recovery. You normally do not need to ask the assistant to refresh after editing notes.

## Privacy

Enabled embeddings send included passages and search queries to the configured endpoint. Use a loopback URL for a model on your own machine. Cloud endpoints receive that text. The chat model is configured separately by your client and can independently be local or cloud-hosted.

See [LM Studio MCP documentation](https://lmstudio.ai/docs/app/mcp), [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), and the [complete configuration reference](reference.md).
