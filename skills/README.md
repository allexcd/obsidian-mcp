# Optional MCP Vault Bridge skill

[obsidian-vault-bridge/SKILL.md](obsidian-vault-bridge/SKILL.md) contains reusable guidance for choosing tools, retrieving evidence, making safe edits, and completing the current request. The folder is a standalone Agent Skill; copy the entire `obsidian-vault-bridge` folder when installing it.

This instruction file is separate from the Obsidian plugin ZIP. It requires the MCP connection and does not grant vault access, enable writes, install models, or change the MCP configuration.

## LM Studio chat interface

1. Open the [dirty-data/skills community plugin](https://lmstudio.ai/dirty-data/skills) and choose **Run in LM Studio**. Install and enable it in the chat alongside the Obsidian MCP integration. This is a third-party loader; compatibility has not been live-verified here.
2. Copy `obsidian-vault-bridge/` into `~/.lmstudio/skills/`. The resulting file must be `~/.lmstudio/skills/obsidian-vault-bridge/SKILL.md`. The directory is `.lmstudio`, without a hyphen.
3. Set the loader's **Skills Paths** to the absolute path of `~/.lmstudio/skills`, using your actual username. Alternatively, point it at this repository's `skills` directory. On macOS use the native/host filesystem mode, not WSL, and do not prefix the path with `WSL:`.
4. Leave command execution disabled; this skill uses MCP tools, not shell scripts. Reload the loader or start a new chat and ask it to list skills. Confirm `obsidian-vault-bridge` appears.
5. Test explicit activation: `$obsidian-vault-bridge Find my notes about reading habits.`

A dollar-prefixed name works only when the loader is enabled. Copying files alone does not make them available to the model. See the loader's [README](https://lmstudio.ai/dirty-data/skills/files/README.md) for settings and activation details; UI labels vary by version.

## Other skill-capable clients

Install the folder using the client's Agent Skills mechanism, then connect MCP Vault Bridge separately. For Bionic, its [native skills documentation](https://lmstudio.ai/docs/bionic/agent/skills) describes **Settings → Skills** and `@` selection. This does not establish Bionic compatibility with the bridge; verify MCP tool discovery and `vault_status` first.

## Verify behavior

Inspect the actual tool calls and source paths for a read-only request. For a write test, enable **Allow creating and editing notes** and request an empty test folder. The assistant should use `create_folder` without a placeholder note, then stop. A subsequent unrelated question should not repeat that action.

The skill's frontmatter and instructions were checked against the current MCP schemas. Model behavior still requires live testing. A skill cannot guarantee correction of a model or host conversation-history bug.
