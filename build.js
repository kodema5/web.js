// deno cache -r mod.js
// deno run -A build.js


console.log('- building: web.js')
import { bundle } from 'https://deno.land/x/emit/mod.ts'
let result = await bundle( 'mod.js')
let { code } = result;
await Deno.writeTextFile('web.js', code)


console.log('- building: web.min.js')
import { build, stop } from "https://deno.land/x/esbuild/mod.js"
// import { httpImports } from "https://deno.land/x/esbuild_plugin_http_imports/index.ts"
// ref:
// - https://deno.land/x/esbuild@v0.17.10/mod.js?s=BuildOptions

await build({
    bundle: true,
    entryPoints: ['web.js'],
    // plugins: [httpImports()],
    write: true,
    format: 'esm',
    minify: true,
    outfile: 'web.min.js',
    // sourcemap: true,
})
stop()


console.log('- done')