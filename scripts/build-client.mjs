/** Copy the hand-written browser bundle next to the compiled Host half. */
import { copyFile, mkdir } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
await copyFile('src/client.js', 'lib/client.js')
