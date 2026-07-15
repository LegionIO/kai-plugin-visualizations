# Kai Visualizations Plugin

AI-driven diagram & chart authoring for Kai Desktop. Describe what you want in natural language; the agent generates and edits Mermaid or Chart.js source, rendered live in a pan/zoom canvas with full revision history.

## Features

- **Per-project chat thread** — each visualization has its own conversation with the agent
- **Two engines** — [Mermaid](https://mermaid.js.org/) for ERDs, flowcharts, sequence, class, state, C4, gantt; [Chart.js](https://www.chartjs.org/) for bar/line/pie/scatter data charts
- **Editable source** — toggle to raw source, hand-edit, save as a revision
- **Branching revision history** — every AI or manual change is a node in a revision tree. Undo/redo move a `HEAD` pointer; editing after undo forks a new branch. Check out any node on any branch from the History tab.
- **Duplicate** — clone a project (source + chat + full revision tree) from the sidebar or toolbar
- **Deep links** — click a node in one diagram to jump into another project; breadcrumbs to navigate back
- **Export** — SVG, PNG, or raw source
- **AI tools** — Kai's main assistant can list, search, create, read, update, delete, and **export** visualizations from any conversation
- **Show the AI the picture** — the `viz_export_project` tool renders a project to a real image and hands it back to the assistant inline, so it can actually *see* the rendered diagram/chart (not just the source), and/or save it to a file. Rendering happens headlessly in a hidden window — nothing is shown to the user. Exports match the workspace style by default; pass `style: "neo"` (polished dark neon) or `style: "plain"` (clean classic on light) to override.

## Deep linking

Bind a specific node to another project by adding a Mermaid `click` directive:

```mermaid
graph TD
  GW[llm-gateway]
  DB[(Postgres)]
  click GW href "viz://<project-id>" "Open networking diagram"
  click DB href "viz://<project-id>" "Open DB schema"
```

For Chart.js, add a top-level `_links` map keyed by `"<datasetIndex>.<pointIndex>"` with a `viz://` value:

```json
{
  "type": "bar",
  "data": { ... },
  "_links": { "0.2": "viz://<project-id>#<optional-node>" }
}
```

The agent knows about your other projects and will emit the correct `viz://` id when you ask it to "link the gateway box to the networking diagram."

## Install

**From marketplace / release tarball** — recommended. Kai extracts the tarball to `~/.kai/plugins/visualizations/`.

**From source:**

```bash
git clone <repo-url> kai-plugin-visualizations
cd kai-plugin-visualizations
npm install
npm run dev   # writes backend.js/frontend.js/plugin.json to ~/.kai/plugins/visualizations/
```

`npm run build` writes to `./dist/` (for packaging), not to the Kai plugins dir.

## Development

```bash
npm install
npm run dev   # watches src/, writes to ~/.kai/plugins/visualizations/
```

Restart Kai Desktop (or reload plugins) to pick up backend changes; frontend hot-reloads on state republish.

## Security notes (export)

`viz_export_project` renders diagram/chart source in a hidden window under a strict CSP (`default-src 'none'`, `connect-src 'none'`, `img-src data: blob:`) so a diagram can't fetch during rendering, and file writes reject symlinks, refuse to clobber non-matching files, and use an atomic temp-then-rename. The diagram author is normally the user; we do **not** model the mermaid/Chart.js source as a sandbox-escape adversary. The exported-SVG sanitizer scrubs the common external-reference forms (`url()`, `@import`, `image-set()`, incl. CSS-escape and quoted variants) but is not a hardened CSS parser, so a determined attacker who fully controls the source could craft an SVG that attempts a network fetch when opened in a permissive external viewer. Prefer PNG export (fully rasterized, no live references) when sharing untrusted diagrams.

## Release

Trigger the **Release Plugin** workflow in GitHub Actions with a version bump. It builds `dist/`, tags, and attaches `visualizations-vX.Y.Z.tar.gz` to a GitHub release.
