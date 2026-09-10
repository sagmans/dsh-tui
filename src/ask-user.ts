/**
 * The official `ask_user_question` tool, re-exported under this package's own
 * specifier.
 *
 * dsh-base mounts the user-questions service but no tool that consumes it: the
 * Web profile gets the tool from agent presets, and a single-session terminal
 * composition has no presets. The bundle patch therefore mounts this subpath
 * instead of naming the official package in its own row, which keeps every row
 * in the patch owned by this plugin.
 */
export * from '@deepseek-ai/dsh-tool-ask-user'
