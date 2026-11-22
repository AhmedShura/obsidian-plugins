import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],bundle:true,format:'cjs',platform:'browser',target:'es2022',external:['obsidian','@codemirror/state','@codemirror/view','@codemirror/commands'],outfile:'main.js'});
