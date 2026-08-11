import { hash, verify } from '@node-rs/argon2'

// Paramètres OWASP 2024 pour argon2id.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS)
  } catch {
    // Un hash mal formé en base ne doit pas faire tomber la route de login.
    return false
  }
}
