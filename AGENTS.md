# LaTeX Notes

An Obsidian plugin that opens `.tex` files as rendered, editable notes. It converts LaTeX to Obsidian markdown in memory and renders it with Obsidian's own renderer, with live preview (the paragraph being edited shows as source), source mode and reading view. It doesn't compile TeX or produce PDFs, and never writes `.md` files.

## Structure

- `src/tex/` is a pure converter (LaTeX in, markdown out) with no dependency on Obsidian. Keep it that way, so it can be run and tested outside Obsidian.
- Everything Obsidian-specific (views, editor, settings, commands, the Outline integration) lives in the rest of `src/`.

## Constraints

See the principles in `CONTRIBUTING.md`. In short: no network access, treat documents as untrusted, convert rather than compile, delegate drawing to other plugins, degrade to showing the source, and keep dependencies and use of Obsidian internals to a minimum.

Open work is tracked in GitHub issues.
