import { readFile } from 'node:fs/promises'
import { replayStudio } from './lib/replay.mjs'

const fixture = process.argv[2] ?? new URL('../tests/fixtures/studio-replay.json', import.meta.url)
const input = JSON.parse(await readFile(fixture, 'utf8'))
const catalog = JSON.parse(await readFile(new URL('../src/shared/tool-package-map.json', import.meta.url), 'utf8'))
console.log(JSON.stringify(replayStudio({ ...input, catalog }), null, 2))
