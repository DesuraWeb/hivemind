import sodium from 'libsodium-wrappers'

export interface SecretBox {
  encryptJson(value: unknown): string
  decryptJson<T = unknown>(sealed: string): T
}

/** Génère une clé maître de 32 octets en base64, à mettre dans MASTER_KEY. */
export function generateMasterKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

/**
 * Construit un chiffreur XSalsa20-Poly1305 (crypto_secretbox).
 * Le nonce est tiré au hasard à chaque chiffrement et préfixé au message ;
 * le tout est encodé en base64. Le chiffré est authentifié : toute altération
 * fait échouer le déchiffrement.
 */
export async function createSecretBox(masterKeyBase64: string): Promise<SecretBox> {
  await sodium.ready

  const key = Buffer.from(masterKeyBase64, 'base64')
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `MASTER_KEY doit faire 32 octets une fois décodée en base64 (reçu : ${key.length}).`,
    )
  }

  return {
    encryptJson(value) {
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
      const cipher = sodium.crypto_secretbox_easy(
        Buffer.from(JSON.stringify(value), 'utf8'),
        nonce,
        key,
      )
      return Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]).toString('base64')
    },

    decryptJson<T>(sealed: string): T {
      const raw = Buffer.from(sealed, 'base64')
      const nonce = raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
      const cipher = raw.subarray(sodium.crypto_secretbox_NONCEBYTES)
      let plain: Uint8Array
      try {
        plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key)
      } catch {
        // Ne jamais laisser fuiter le chiffré ou la clé dans le message d'erreur.
        throw new Error('Échec du déchiffrement : clé invalide ou données altérées.')
      }
      return JSON.parse(Buffer.from(plain).toString('utf8')) as T
    },
  }
}
