import { buildApp } from './app'
import { getDb } from './db/client'
import { loadEnv } from './env'

const env = loadEnv()
const app = await buildApp({ db: getDb() })

await app.listen({ port: env.PORT, host: '0.0.0.0' })
