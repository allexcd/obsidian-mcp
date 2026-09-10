# Optional LM Studio skills

These are instruction files, separate from the Obsidian plugin ZIP. They do not grant vault access, enable writes, install models, or change the MCP configuration. Both require MCP Vault Bridge to be connected. The quote skill reads the vault's current template rather than bundling a stale copy.

- `obsidian-vault-bridge/SKILL.md`: choose the appropriate tool and finish the current request.
- `save-book-quote/SKILL.md`: save supplied quotes with `Templates/Quotes Template.md` in `Books/Quotes`.

## Existing LM Studio chat interface

1. Open the [dirty-data/skills community plugin](https://lmstudio.ai/dirty-data/skills) and choose **Run in LM Studio**. Install and enable the plugin in the chat alongside the Obsidian MCP integration. This is a third-party skill loader; these files have not been live-tested with it.
2. Put both skill folders inside `~/.lmstudio/skills/`, keeping each `SKILL.md` inside its named folder. Alternatively, set the loader's **Skills Paths** to the absolute path of this repository's `skills` directory.
3. Leave command execution disabled: these skills use MCP tools, not shell scripts. Use the host/native filesystem mode for your OS, not WSL on macOS.
4. Reload the skills plugin or start a fresh chat. Ask it to list the available skills to confirm both names are discovered.
5. Invoke explicitly while testing:

   `$obsidian-vault-bridge Create an empty folder called Books in my vault.`

   `$save-book-quote Save this quote from [book], by [author], published in [year]: “[your quote]”`

Replace bracketed example values with your information. The quote skill works on its own; loading both is not required. A dollar-prefixed name works only when the skill loader is enabled. Without a loader, placing files in a folder does not make them available to the model.

See the loader's [README](https://lmstudio.ai/dirty-data/skills/files/README.md) for Skills Paths and `$skill-name` activation. UI labels and compatibility may differ by plugin version.

## LM Studio Bionic

If using Bionic's native skills support, add each skill through **Settings → Skills**. Use `@` in the composer to select it explicitly. Keep the MCP connection enabled. See [official Bionic skills instructions](https://lmstudio.ai/docs/bionic/agent/skills).

## Verify with one quote

Enable **Allow creating and editing notes** in Obsidian. Use a quote and book details you know. Inspect the tool calls and saved file: the template should be read first, the quote should be verbatim, unknown metadata should stay empty, and the file should be inside `Books/Quotes`. Repeating the same save should identify the existing candidate; asking a different question afterward should not repeat the save.

Validated as Agent Skills documents and reviewed against the current MCP schemas and actual template. Model behavior and LM Studio skill-loader compatibility still require this live check. Skills cannot guarantee correction of a model or host conversation-history bug.
