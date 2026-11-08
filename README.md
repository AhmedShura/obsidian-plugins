# Obsidian Plugins

A collection of personal Obsidian plugins.

## Checked to Bottom

When you check off a Markdown task in the editor, it moves below the unchecked tasks in its list. Completed tasks can be collapsed in Live Preview.

### Install on desktop

1. Download [Checked to Bottom v0.1.0](https://github.com/AhmedShura/obsidian-plugins/releases/download/checked-to-bottom-v0.1.0/checked-to-bottom-0.1.0.zip).
2. Unzip it and copy the `checked-to-bottom` folder into your vault’s `.obsidian/plugins/` folder. Create `plugins` if it’s missing.
3. Restart Obsidian. In **Settings → Community plugins**, turn on community plugins if needed, then enable **Checked to Bottom**.

### Build from source

From `plugins/checked-to-bottom/`, run `npm ci`, `npm test`, and `npm run build`. Node.js 26 is compatible with the locked development dependencies. The build writes `main.js` next to the manifest and stylesheet.

## License

[MIT](LICENSE)
