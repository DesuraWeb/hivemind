/**
 * État de démonstration pour l'écran Inbox (Phase 3, Task 7). Sans lui,
 * `/inbox` est vide et Florian ne peut rien juger sur le rendu réel des 5
 * panneaux de traitement.
 *
 * Crée un globe, quatre projets (repris de `docs/design/data.js` : Le Koin,
 * Reparea, Bastide, Calanques — mêmes tint/stack/synth, pour que l'audit
 * pixel compare des données comparables) et un item d'inbox par type couvert
 * par la Task 7 :
 *
 *   - demo-bastide : une VRAIE question bloquante, posée via `applyEvent`
 *     (le même chemin que l'orchestrateur en production) — le run passe
 *     `awaiting_human`, exactement le scénario du critère de fin J7. Un
 *     verdict est ajouté sur le même projet (payload démonstratif, cf.
 *     `createInboxItem` : items qui ne naissent pas d'un `Effect`).
 *   - demo-koin : une approbation de mise en prod (sub "prod").
 *   - demo-reparea : une approbation d'email (sub "email").
 *   - demo-calanques : une alerte (max_iterations atteint).
 *
 * Aucun item `approval · savoir` n'est créé : ce sous-type est accepté par le
 * schéma et rendu par le front, mais personne ne le produit dans cette phase
 * (la conscience collective est hors périmètre, plan Phase 3 §"Décision de
 * périmètre").
 *
 * Idempotent et rejouable : tout est identifié par le globe `slug=demo` et
 * des projets `slug` préfixés `demo-` — chaque exécution nettoie d'abord ce
 * qu'une exécution précédente avait laissé, avant de recréer à l'identique.
 * Ne touche à aucune donnée hors de ce périmètre (jamais le globe "desura"
 * du setup initial, jamais l'utilisateur "florian").
 *
 *   pnpm --filter @silithid/server exec tsx scripts/seed-demo.ts
 *   pnpm --filter @silithid/server exec tsx scripts/seed-demo.ts --clean
 */

import type { Kysely } from 'kysely'
import { closeDb, getDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import type { Database } from '../src/db/types'
import { createInboxItem } from '../src/inbox/repo'
import { applyEvent } from '../src/loop/orchestrator'

const DEMO_GLOBE_SLUG = 'demo'
const DEMO_PROJECT_PREFIX = 'demo-'

interface DemoProjectSpec {
  slug: string
  name: string
  client: string
  stack: string
  tint: string
  synth: string
  stagingUrl: string
}

// Repris tel quel de docs/design/data.js (PROJECTS[]) pour que la comparaison
// visuelle prototype ↔ app porte sur les mêmes teintes et les mêmes noms.
const PROJECT_SPECS: DemoProjectSpec[] = [
  {
    slug: 'demo-koin',
    name: 'Le Koin',
    client: 'Démo · Annuaire local',
    stack: 'Laravel',
    tint: '#7FD9CF',
    synth: 'Le dev itère sereinement · prod du step 3 à valider.',
    stagingUrl: 'stg.lekoin.fr',
  },
  {
    slug: 'demo-reparea',
    name: 'Reparea',
    client: 'Démo · SaaS QualiRépar',
    stack: 'Laravel',
    tint: '#7FB8E8',
    synth: 'Boucle suspendue · une réponse suffit pour repartir.',
    stagingUrl: 'stg.reparea.fr',
  },
  {
    slug: 'demo-bastide',
    name: 'Client Bastide',
    client: 'Démo · PrestaShop',
    stack: 'PrestaShop',
    tint: '#B49FE0',
    synth: 'Verdict rendu : 2 écarts mineurs · validation attendue.',
    stagingUrl: 'stg.bastide.fr',
  },
  {
    slug: 'demo-calanques',
    name: 'Client Calanques',
    client: 'Démo · PrestaShop',
    stack: 'PrestaShop',
    tint: '#E8907B',
    synth: 'Boucle stoppée : max_iterations atteint, FTP legacy manquant.',
    stagingUrl: 'stg.calanques.fr',
  },
]

async function clean(db: Kysely<Database>): Promise<void> {
  const globe = await db
    .selectFrom('globes')
    .select('id')
    .where('slug', '=', DEMO_GLOBE_SLUG)
    .executeTakeFirst()

  if (globe) {
    // Cascade FK (projects -> steps -> runs -> messages/inbox_items/roles/...)
    // : supprimer chaque projet suffit à tout nettoyer sous lui.
    const projects = await db
      .selectFrom('projects')
      .select('id')
      .where('globe_id', '=', globe.id)
      .execute()
    for (const p of projects) {
      await db.deleteFrom('projects').where('id', '=', p.id).execute()
    }
    await db.deleteFrom('globes').where('id', '=', globe.id).execute()
  }

  // Les clients ne sont référencés que par les projets démo qu'on vient de
  // supprimer (FK déjà coupée) : sûr de les enlever à part.
  await db.deleteFrom('clients').where('name', 'like', 'Démo ·%').execute()
}

async function seed(db: Kysely<Database>): Promise<void> {
  const globe = await db
    .insertInto('globes')
    .values({ name: 'Démo J7', slug: DEMO_GLOBE_SLUG, position: 99 })
    .returning('id')
    .executeTakeFirstOrThrow()

  const projects = new Map<string, { id: string }>()
  for (const spec of PROJECT_SPECS) {
    const client = await db
      .insertInto('clients')
      .values({ name: spec.client, tone: 'direct, cordial' })
      .returning('id')
      .executeTakeFirstOrThrow()

    const project = await db
      .insertInto('projects')
      .values({
        globe_id: globe.id,
        client_id: client.id,
        name: spec.name,
        slug: spec.slug,
        repo_full_name: `desura/${spec.slug}`,
        staging_url: spec.stagingUrl,
        stack: spec.stack,
        tint: spec.tint,
        synth: spec.synth,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    projects.set(spec.slug, { id: project.id })
  }

  const koin = projects.get('demo-koin')?.id
  const reparea = projects.get('demo-reparea')?.id
  const bastide = projects.get('demo-bastide')?.id
  const calanques = projects.get('demo-calanques')?.id
  if (!koin || !reparea || !bastide || !calanques) {
    throw new Error('un des 4 projets démo est introuvable après insertion')
  }

  // --- demo-bastide : la VRAIE question bloquante (critère J7) ---
  //
  // Un step + un run comme n'importe quel autre, puis le même événement que
  // l'orchestrateur émettrait depuis un handler de step réel (framing.ts) —
  // `applyEvent` fait passer le run en `awaiting_human`, ouvre l'item
  // `question` et diffuse `run.state` + `inbox.new` sur le bus SSE. Rien
  // n'est simulé : résoudre cet item via l'API fera vraiment repartir ce run.
  const bastideStep = await db
    .insertInto('steps')
    .values({
      project_id: bastide,
      position: 1,
      title: 'Mentions légales et page contact',
      specs: '## Cadrer la page contact et les mentions légales du site Bastide',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const bastideRun = await db
    .insertInto('runs')
    .values({ step_id: bastideStep.id, state: 'coding' })
    .returning('id')
    .executeTakeFirstOrThrow()
  await applyEvent(db, bastideRun.id, { type: 'question', blocking: true, fromRole: 'garant' })

  // Deuxième item sur le même projet (data.js : Bastide porte à la fois une
  // question ET un verdict en attente) — item autonome, pas lié à un run,
  // via `createInboxItem` (repo.ts : « items qui ne naissent pas d'un Effect »).
  await createInboxItem(db, {
    type: 'verdict',
    projectId: bastide,
    title: 'Rapport du juge · step 1, deux écarts mineurs',
    fromRole: 'juge',
    payload: {
      summary:
        'Rendu conforme aux specs à deux écarts mineurs près. Correctifs estimés : 1 itération du dev, sans re-passage complet du reviewer.',
      ecarts: [
        {
          sev: 'MINEUR',
          txt: 'Espacement sous la fiche produit : 24 px specs / 31 px rendu (section avis).',
        },
        { sev: 'MINEUR', txt: 'Contraste du bouton « Retour » sous AA sur fond image (3,9:1).' },
      ],
    },
  })

  // --- demo-koin : approbation de mise en prod ---
  await createInboxItem(db, {
    type: 'approval',
    subtype: 'prod',
    projectId: koin,
    title: 'Mise en prod · Le Koin, step 3',
    fromRole: 'juge',
    payload: {
      ctx: 'le juge a validé le step en itération 4/4 · rien à corriger',
      prod: {
        step: 'Step 3/7 · Fiche établissement',
        iters: '4 itérations · 2 corrections juge',
        verdict: 'conforme, 0 écart bloquant',
        pr: 'PR #142 · +2 340 −118 · 14 fichiers',
      },
    },
  })

  // --- demo-reparea : approbation d'un brouillon d'email ---
  await createInboxItem(db, {
    type: 'approval',
    subtype: 'email',
    projectId: reparea,
    title: 'Relance client · brouillon prêt à envoyer',
    fromRole: 'communicant',
    archiveToClient: false,
    payload: {
      ctx: 'rédigé par le communicant · 6 j sans réponse client · ton fiche client : direct, cordial',
      email: {
        from: 'contact@exemple.test',
        to: 'contact@reparea.fr',
        subject: 'Reparea · avancement & accès API QualiRépar',
        body: 'Bonjour Julien,\n\nLe step 2 (parcours de dépôt) est prêt côté staging. Pour brancher la certification, il nous manque l’accès API QualiRépar (clé sandbox).\n\nPouvez-vous nous la transmettre cette semaine ? Le planning reste tenu.\n\nBien à vous,\nFlorian · Desura',
      },
    },
  })

  // --- demo-calanques : alerte (boucle dev↔reviewer stoppée) ---
  await createInboxItem(db, {
    type: 'alert',
    projectId: calanques,
    title: 'max_iterations atteint (4/4) · boucle stoppée',
    fromRole: 'system',
    payload: {
      cause: 'max_iterations atteint (4/4) sur le step 1 · le dev boucle sans accès FTP legacy.',
      ctx: 'boucle stoppée, aucun coût en cours.',
    },
  })
}

async function main(): Promise<void> {
  const cleanOnly = process.argv.includes('--clean')
  const db = getDb()
  await runMigrations(db) // idempotent (schema_migrations), sans danger sur une base déjà à jour

  await clean(db)
  console.log('Fixtures démo précédentes nettoyées (globe "demo", clients "Démo · …").')

  if (!cleanOnly) {
    await seed(db)
    console.log(
      `4 projets démo créés (${PROJECT_SPECS.map((p) => p.slug).join(', ')}) avec 5 items d'inbox :`,
    )
    console.log('  - demo-bastide : question bloquante (run réellement en awaiting_human)')
    console.log('  - demo-bastide : verdict (2 écarts mineurs)')
    console.log('  - demo-koin    : approbation · prod')
    console.log('  - demo-reparea : approbation · email')
    console.log('  - demo-calanques : alerte (max_iterations)')
    console.log('')
    console.log('→ ouvrir /inbox : la question bloquante de demo-bastide est le critère de fin J7.')
  }

  // `buildApp`/`getDb` ouvrent une connexion pool ; on la ferme explicitement
  // pour que le process sorte sans qu'il faille Ctrl+C (comme create-user.ts).
  await closeDb()
}

// Point d'entrée CLI uniquement — jamais exécuté si ce module est importé.
// Ce script suppose un serveur déjà démarré à côté (pnpm dev) : c'est lui qui
// détient l'instance pg-boss capable de ré-enfiler le job `run.step` quand la
// question bloquante est résolue via l'UI — ce script, lui, ne fait qu'écrire
// l'état initial en base.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
