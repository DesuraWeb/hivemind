import { buildApp } from './app'
import { getDb } from './db/client'
import { loadEnv } from './env'
import { createMailer } from './integrations/mailer'
import { createBoss, startBoss } from './jobs/boss'
import { createRuntimeAdapter } from './runtime/index'

const env = loadEnv()
const db = getDb()

// Construits une seule fois et partagés entre les routes HTTP et les workers
// pg-boss (voir le commentaire sur `AppDeps.adapter` dans app.ts).
const adapter = await createRuntimeAdapter(env)
const mailer = createMailer(env)
const alertTo = env.ALERT_EMAIL_TO ?? 'alerts@exemple.test'

const app = await buildApp({ db, adapter, mailer })

const boss = createBoss(env)
boss.on('error', (err) => app.log.error(err, 'pg-boss'))
await startBoss(boss, { db, adapter, mailer, alertTo })

await app.listen({ port: env.PORT, host: '0.0.0.0' })

async function shutdown(): Promise<void> {
  await boss.stop()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
