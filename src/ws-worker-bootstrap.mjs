import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  cache: true,
})
await jiti.import('./ws-worker.ts')
