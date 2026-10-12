// Copy the browser-side telemetry panel into the build output.
// The file is plain JavaScript (no TypeScript compilation needed); tsc's
// `include: ["src"]` with default `allowJs: false` skips it, so the build
// script copies it alongside the compiled modules.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

mkdirSync(dirname('lib/client.js'), { recursive: true })
copyFileSync('src/client.js', 'lib/client.js')
console.log('copied src/client.js -> lib/client.js')
