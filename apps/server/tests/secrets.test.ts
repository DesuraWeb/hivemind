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
  const tampered = `${sealed.slice(0, -4)}AAAA`

  expect(() => box.decryptJson(tampered)).toThrow(/déchiffrement/i)
})

test('une clé de mauvaise taille est refusée à la construction', async () => {
  await expect(createSecretBox('dHJvcCBjb3VydA==')).rejects.toThrow(/32 octets/)
})
