import { build } from 'esbuild';
import fs from 'node:fs';
await build({
  entryPoints: ['src/main.cjs'], outfile: 'main.js', bundle: true, platform: 'browser',
  format: 'cjs', target: 'es2020', minify: false, legalComments: 'inline',
  external: ['obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/commands'],
  banner: { js: '/* Heading Status Tracker | MIT\n' + fs.readFileSync('THIRD-PARTY-NOTICES.md', 'utf8').replace(/\*\//g, '* /') + '\n*/' }
});
fs.mkdirSync('dist', { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) fs.copyFileSync(file, `dist/${file}`);
