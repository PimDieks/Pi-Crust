# Figma picker (small version)

Setup and status: the Figma status pill and panel in the Design tab (phase 4) show what is missing and hold the file link per project.

Pick an element in localhost (existing 🎯) and a layer in **Figma desktop** (new Figma-logo button). Type the request; Pi checks tokens and spacing (using whatever design-check instructions the repo has).

## Pi Crust
1. **Figma-logo button + ⌘⇧F + palette action.** Main process calls the Figma desktop MCP (`http://127.0.0.1:3845/mcp`, JSON-RPC over HTTP):
   - `get_design_context` (no node id = current selection) → root `data-node-id` + `data-name`, and per property which variable is bound (`bg-[var(--color/accent)]`); raw values mean "not a token in Figma"
   - `get_variable_defs` (selection) → variable names and values, e.g. `Color/Accent: #3366ff`, `spacing/2XS: 4`
   - file key: not exposed by the MCP; setting `figmaFileKey` (no default), overridable by pasting a Figma link once
   - verified 2025-10-28 against Figma desktop 126.10
2. **Pill** in the chat input (nothing sent):
   ```
   <figma-node url="https://www.figma.com/design/KEY/File?node-id=1-2" node-id="1:2" name="Header" type="FRAME">
   variables: Color/Accent = #3366ff, spacing/2XS = 4, ...
   bound: background → Color/Accent; padding-left → spacing/2XS; padding-right → 4px (no token)
   </figma-node>
   ```
3. **Clear errors:** Figma desktop not running, MCP off, active tab is not a design file, nothing selected.

## Not changed
The repo's own instructions stay as they are, and the pill carries no instructions. You ask Pi what to compare.

## Out of scope
Embedded Figma pane, automatic measuring and checking, dark-mode measuring.
