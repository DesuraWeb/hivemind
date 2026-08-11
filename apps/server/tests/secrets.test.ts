import { expect, test } from 'vitest'
import { createSecretBox, generateMasterKey } from '../src/crypto/secrets'

test('un aller-retour restitue la valeur d origine', async () => {
  const box = await createSecretBox(generateMasterKey())
  const secret = { ftp_host: 'ftp.acme.fr', ftp_pass: 'hunter2' }

  const sealed = box.encryptJson(secret)
  expect(box.decryptJson(sealed)).toEqual(secret)
})

test('le chiffré ne contient jamais le clair', async () => {
  const box = await createSecretBox(generateMasterKey())
  const sealed = box.encryptJson({ ftp_pass: 'hunter2' })

  expect(sealed).not.toContain('hunter2')
  expect(sealed).not.toContain('ftp_pass')
})

test('deux chiffrements de la même valeur diffèrent (nonce aléatoire)', async () => {
  const box = await createSecretBox(generateMasterKey())
  expect(box.encryptJson({ a: 1 })).not.toBe(box.encryptJson({ a: 1 }))
})

test('une autre clé ne peut pas déchiffrer', async () => {
  const a = await createSecretBox(generateMasterKey())
  const b = await createSecretBox(generateMasterKey())

  expect(() => b.decryptJson(a.encryptJson({ a: 1 }))).toThrow(/déchiffrement/i)
})

test('un chiffré altéré est rejeté', async () => {
  const box = await createSecretBox(generateMasterKey())
  const sealed = box.encryptJson({ a: 1 })

  // Altération déterministe : on flippe un bit du dernier octet des données
  // décodées. Substituer des caractères base64 serait un no-op si le chiffré
  // se terminait déjà par la valeur de remplacement.
  const raw = Buffer.from(sealed, 'base64')
  const last = raw.length - 1
  raw[last] = (raw[last] as number) ^ 0x01
  const tampered = raw.toString('base64')

  expect(tampered).not.toBe(sealed)
  expect(() => box.decryptJson(tampered)).toThrow(/déchiffrement/i)
})

test('une clé de mauvaise taille est refusée à la construction', async () => {
  await expect(createSecretBox('dHJvcCBjb3VydA==')).rejects.toThrow(/32 octets/)
})
