# Contributing

Thanks for helping. Bug reports with a reproducible example are the most useful contribution: LaTeX documents vary a lot, and every report of something that renders wrongly makes the converter better.

## Reporting a problem

[Open an issue](../../issues/new?template=bug_report.md) with:

1. A minimal snippet of LaTeX that shows the problem.
2. The conversion report: open the file, click the ⓘ button in the view header, then **Copy report**.

## Working on the code

Run `npm install`; the scripts in `package.json` build, watch and lint the plugin. Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/latex-notes/` to try a build.

The converter in `src/tex/` turns LaTeX into Obsidian markdown and doesn't depend on Obsidian, so most converter changes can be tested on their own. The rest of `src/` is the Obsidian side: the view, live preview, settings and the Outline integration.

## Principles

Changes should keep these:

- **No network access.** The plugin never makes a request.
- **Documents are untrusted.** A `.tex` or `.bib` file from someone else must not be able to inject HTML, scripts or unsafe links. Escape what comes from a document, and keep links to safe schemes.
- **Convert, don't compile.** There is no TeX engine. LaTeX is translated into markdown that Obsidian renders natively, so it looks like the rest of the vault.
- **Delegate what we don't draw.** Diagrams go to plugins that specialise in them (TikZ to a `tikz` code block plugin) instead of being reimplemented here.
- **Degrade gracefully.** Anything that can't be converted is shown as its LaTeX source, never as a broken page.
- **Stay small.** Avoid new runtime dependencies, and use Obsidian's API rather than its internals; where an internal is unavoidable, check for it and fall back to normal behaviour if it changes.
