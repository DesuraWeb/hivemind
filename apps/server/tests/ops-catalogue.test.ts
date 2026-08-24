import { expect, test } from 'vitest'
import {
  MOTS_INTERDITS,
  NOMS_OPERATIONS,
  OPERATIONS_SCHEMAS,
  OperationInconnueError,
  estAuCatalogue,
  rendre,
  valider,
} from '../src/ops/operations'

/**
 * Le catalogue borné (Phase 6, Task 2).
 *
 * Le test qui compte n'est pas « l'agent n'a pas exécuté de commande
 * arbitraire » : une abstention ne prouve rien. C'est qu'il n'existe RIEN à
 * appeler pour ça — vérifié par énumération du catalogue, comme
 * `tool-policy.test.ts` le fait pour `bash`, et non par relecture du code.
 */

test('aucune opération n’ouvre un shell, et c’est vérifié par énumération', () => {
  for (const nom of NOMS_OPERATIONS) {
    for (const mot of MOTS_INTERDITS) {
      // Casse le jour où quelqu'un ajoute `executer_commande` au catalogue :
      // c'est exactement le geste qu'on veut rendre impossible en silence.
      expect(nom.split('_').includes(mot), `opération « ${nom} » (mot « ${mot} »)`).toBe(false)
    }
  }
  // Le catalogue reste petit : une liste qui enfle sans qu'on s'en aperçoive
  // est le premier symptôme d'un pouvoir qui s'élargit tout seul.
  expect(NOMS_OPERATIONS.length).toBeLessThanOrEqual(12)
})

test('une opération hors catalogue est refusée, jamais rendue à vide', () => {
  expect(estAuCatalogue('executer_commande')).toBe(false)
  expect(() => rendre({ nom: 'executer_commande' as never, params: { cmd: 'rm -rf /' } })).toThrow(
    OperationInconnueError,
  )

  const v = valider({ nom: 'bash' as never, params: {} })
  expect(v.ok).toBe(false)
  // Le message dit la voie légitime : sans elle, l'agent apprend à se taire.
  if (!v.ok) expect(v.raison).toMatch(/proposition hors catalogue/)
})

test('un chemin qui remonte est refusé à la validation, pas neutralisé en silence', () => {
  for (const chemin of [
    '/etc/nginx/../../root/.ssh/authorized_keys',
    '../../etc/passwd',
    'relatif',
  ]) {
    const v = valider({ nom: 'ecrire_fichier', params: { chemin, contenu: 'x' } })
    expect(v.ok, chemin).toBe(false)
  }
  expect(
    valider({ nom: 'ecrire_fichier', params: { chemin: '/etc/nginx/x', contenu: 'x' } }).ok,
  ).toBe(true)
})

test('un nom de service exotique n’atteint jamais la commande', () => {
  for (const service of ['nginx; rm -rf /', 'nginx && curl evil', '$(whoami)', '../../bin/sh']) {
    expect(valider({ nom: 'recharger_service', params: { service } }).ok, service).toBe(false)
  }
})

test('une écriture sauvegarde AVANT, et son inverse restaure la sauvegarde', () => {
  const rendu = rendre({
    nom: 'ecrire_fichier',
    params: {
      chemin: '/etc/php/8.2/fpm/conf.d/99-silithid.ini',
      contenu: 'memory_limit = 512M',
      mode: '644',
    },
  })

  // L'ordre est le point : la copie précède l'écriture dans le texte même de
  // la commande. Un retour arrière « prévu après » n'existe pas.
  const iCopie = rendu.commande.indexOf('cp -p')
  const iEcriture = rendu.commande.indexOf('cat >')
  expect(iCopie).toBeGreaterThan(-1)
  expect(iCopie).toBeLessThan(iEcriture)

  expect(rendu.sauvegarde).toContain('/var/backups/silithid')
  expect(rendu.inverse).toContain(rendu.sauvegarde as string)
  expect(rendu.commande).toContain('memory_limit = 512M')
})

test('le contenu écrit ne peut pas être réinterprété par le shell distant', () => {
  const rendu = rendre({
    nom: 'ecrire_fichier',
    params: { chemin: '/etc/x.conf', contenu: 'valeur = $(whoami)\n`id`\n${HOME}' },
  })
  // Délimiteur CITÉ : bash n'effectue aucune substitution dans le corps. Ce qui
  // est montré à Florian est octet pour octet ce qui atterrit dans le fichier.
  expect(rendu.commande).toContain("<<'SILITHID_EOF'")
  expect(rendu.commande).toContain('valeur = $(whoami)')
})

test('une opération sans retour arrière le DIT, elle ne fait pas semblant', () => {
  const install = rendre({ nom: 'installer_paquet', params: { paquet: 'php8.2-gd' } })
  // `null` est une réponse lourde de sens : « ça ne se défait pas ». Le
  // désinstaller emporterait des dépendances qu'un autre service utilise.
  expect(install.inverse).toBeNull()

  const lecture = rendre({ nom: 'lire_fichier', params: { chemin: '/etc/nginx/nginx.conf' } })
  // Distinct de `null` : une lecture n'a rien changé, il n'y a rien à défaire.
  expect(lecture.inverse).toMatch(/sans objet/)
})

test('recharger un service, jamais le redémarrer', () => {
  const rendu = rendre({ nom: 'recharger_service', params: { service: 'nginx' } })
  // Sur un serveur en service, la différence entre reload et restart se mesure
  // en requêtes perdues.
  expect(rendu.commande).toContain('systemctl reload')
  expect(rendu.commande).not.toContain('restart')
})

test('un cron posé au mauvais mode ne tournerait jamais : le mode est dans la commande', () => {
  const rendu = rendre({
    nom: 'poser_cron',
    params: {
      nom: 'silithid-backup',
      planification: '0 3 * * *',
      utilisateur: 'www-data',
      commande: '/usr/local/bin/backup.sh',
    },
  })
  expect(rendu.commande).toContain('chmod 644')
  expect(rendu.inverse).toContain('rm -f')
  expect(rendu.resume).toContain('0 3 * * *')
})

test('chaque opération du catalogue rend une commande, un résumé, et se prononce sur son inverse', () => {
  const echantillons: Record<string, Record<string, unknown>> = {
    lire_fichier: { chemin: '/etc/hosts' },
    ecrire_fichier: { chemin: '/etc/x', contenu: 'y' },
    installer_paquet: { paquet: 'curl' },
    activer_extension_php: { extension: 'gd' },
    recharger_service: { service: 'nginx' },
    poser_cron: {
      nom: 'x',
      planification: '* * * * *',
      utilisateur: 'root',
      commande: '/bin/true',
    },
  }

  // Le test garde le catalogue honnête en grandissant : ajouter une opération
  // sans lui donner d'échantillon ici fait tomber cette ligne.
  expect(Object.keys(echantillons).sort()).toEqual([...NOMS_OPERATIONS].sort())

  for (const nom of NOMS_OPERATIONS) {
    const rendu = rendre({ nom, params: echantillons[nom] as Record<string, unknown> })
    expect(rendu.commande.length, nom).toBeGreaterThan(0)
    expect(rendu.resume.length, nom).toBeGreaterThan(0)
    // `inverse` peut être `null` — mais jamais une chaîne vide, qui laisserait
    // croire à un retour arrière inexistant.
    expect(rendu.inverse === null || rendu.inverse.length > 0, nom).toBe(true)
    expect(OPERATIONS_SCHEMAS[nom]).toBeDefined()
  }
})
