import { seed } from '../src/seed/index.js'
import { db } from '../src/db/client.js'

const reset = !process.argv.includes('--keep')

try {
  const stats = await seed({ reset })
  console.log('[seed] done')
  console.table(stats)
} catch (err) {
  console.error('[seed] failed:', err)
  process.exitCode = 1
} finally {
  await db.close()
}
