import { Link } from '@tanstack/react-router'
import { SectionHeader } from '../components/SectionHeader'
import {
  Code,
  Evidence,
  Mockup,
  MockupActions,
  SpecBody,
  SpecCard,
  type SpecCardProps,
  SpecHeader,
  SpecRow,
  type SpecRowProps,
  SpecScore,
  SpecSection,
  type SpecStatus,
} from '../components/spec/kit'

/**
 * `/conscience` · reprise de `docs/design/Conscience collective.dc.html`.
 *
 * Le prototype n'a pas de `state` : c'est un document, et cette page en est
 * un aussi. Ce qu'elle change par rapport au pack tient en une phrase : **la
 * conscience collective n'existe pas**. Aucune table de savoirs, aucun
 * embedding, aucun rappel compté, aucun emprunt inter-globes. Rendre ces cinq
 * sections au présent, comme le fait le prototype, ferait croire à un
 * mécanisme qui ne tourne pas — la même faute que « Suivi budgétaire prévu en
 * J12 » ou que le bloc « Connexions » des réglages.
 *
 * Chaque bloc porte donc son état et sa preuve (`components/spec/kit.tsx` en
 * explique la forme et pourquoi il n'y a que deux états). Le compteur de tête
 * est dérivé de ce tableau : requalifier un bloc le déplace tout seul.
 *
 * Les deux extraits d'interface du pack (l'item « validation · savoir » et la
 * demande d'emprunt) sont rendus en maquettes inertes : leurs pastilles
 * d'action seraient, ici, des boutons qui ne font rien sur une donnée qui
 * n'existe pas.
 */

const CIRCLES: SpecCardProps[] = [
  {
    status: 'spec',
    title: 'Globe',
    meta: 'partagé par tous les projets du globe',
    body: "Conventions de l'agence, stack préférée, patterns récurrents, ton par défaut, erreurs à ne pas répéter.",
    evidence: (
      <>
        la table <Code>globes</Code> (migration 0002) porte un nom, une teinte, une position et les
        projets qui s’y rattachent · aucune colonne de mémoire, aucune convention stockée
      </>
    ),
  },
  {
    status: 'built',
    title: 'Client',
    meta: 'suit le client à travers ses projets',
    body: 'Coordonnées, SIRET, ton de communication, accès (chiffrés, dans le coffre), réponses archivées depuis l’inbox.',
    evidence: (
      <>
        table <Code>clients</Code> · <Code>contacts</Code>, <Code>siret</Code>, <Code>tone</Code>,{' '}
        <Code>secrets</Code> chiffrés, et <Code>notes</Code> — chaque question résolue dans l’inbox
        y est archivée (<Code>inbox/resolve.ts</Code>), rendue par la fiche client
      </>
    ),
  },
  {
    status: 'spec',
    title: 'Projet',
    meta: 'meurt avec le projet, archivable',
    body: 'Décisions de specs, contraintes techniques découvertes, historique des verdicts et correctifs.',
    evidence: (
      <>
        <Code>projects.context</Code> et <Code>steps.specs</Code> sont injectés au cadrage ; les
        verdicts et correctifs vivent dans <Code>messages</Code>, lus à l’intérieur du run et jamais
        au-delà · rien ne survit au run sous forme de savoir
      </>
    ),
  },
  {
    status: 'spec',
    title: 'Rappel en cascade',
    meta: 'projet → client → globe → conscience de Hive · le plus spécifique gagne',
    body: 'Un agent consulte les quatre cercles AVANT de poser une question dans l’inbox.',
    evidence: (
      <>
        un seul cercle est consulté, une seule fois : <Code>framing.ts</Code> colle un résumé de la
        fiche client dans le préambule du garant (<Code>clientSummary</Code>, les 5 dernières
        questions résolues) · ni cascade, ni arbitrage, et le dev comme le reviewer n’y ont pas
        accès
      </>
    ),
  },
]

const CYCLE: SpecRowProps[] = [
  {
    status: 'spec',
    k: '1 · trouvaille',
    v: 'Un agent découvre en travaillant · en fin de run, le reviewer extrait les candidats.',
    evidence: (
      <>
        aucun rôle n’extrait de candidat · le reviewer rend un rapport sur la PR et rien d’autre (
        <Code>reviewing.ts</Code>)
      </>
    ),
  },
  {
    status: 'spec',
    k: '2 · proposition',
    v: 'Un item « validation · savoir » apparaît dans l’inbox, avec sa source (run, diff) et le cercle visé.',
    evidence: (
      <>
        le sous-type est accepté par l’inbox et son panneau existe, boutons désactivés (
        <Code>SavoirPanel</Code>) · aucun code ne produit d’item de ce sous-type, la liste est vide
        par construction
      </>
    ),
  },
  {
    status: 'spec',
    k: '3 · correction',
    v: 'Vous corrigez ou refusez · votre formulation fait foi.',
    evidence: (
      <>
        le principe est déjà en place, mais pour les réponses d’inbox seulement : « Optimiser »
        propose, vous gardez la main (<Code>inbox/optimize.ts</Code>) · rien d’équivalent pour un
        savoir, faute de savoir
      </>
    ),
  },
  {
    status: 'spec',
    k: '4 · archivage',
    v: 'Versionné dans le bon cercle · globe, client ou projet · horodaté et signé.',
    evidence: (
      <>
        seul l’archivage vers la fiche client existe (<Code>archive_to_client</Code> sur l’item →{' '}
        <Code>clients.notes</Code>) · ni version, ni cercle visé, ni signature
      </>
    ),
  },
  {
    status: 'spec',
    k: '5 · rappel',
    v: 'Consulté avant toute question, avec un compteur d’utilité incrémenté à chaque rappel.',
    evidence: (
      <>
        rien n’est compté · les prompts du garant et du dev leur disent bien de consulter la fiche
        avant de poser une question, mais c’est une consigne, pas une mesure
      </>
    ),
  },
]

const STORAGE: SpecRowProps[] = [
  {
    status: 'spec',
    k: 'base par globe',
    v: 'Un schéma Postgres par globe (isolation stricte) · supprimer un globe emporte toute sa mémoire.',
    evidence: (
      <>
        un seul schéma pour toute l’instance · <Code>globes</Code> est une table parmi les autres et{' '}
        <Code>projects.globe_id</Code> la référence · il n’y a aucune mémoire à emporter
      </>
    ),
  },
  {
    status: 'spec',
    k: 'rappel sémantique',
    v: 'Entrées embarquées (pgvector) : les agents cherchent par sens, pas par mot-clé.',
    evidence: (
      <>
        aucune extension vectorielle, aucun embedding, aucune table à indexer · la seule
        {' « recherche » '}
        du système est le résumé de fiche client recopié dans le préambule
      </>
    ),
  },
  {
    status: 'built',
    k: 'secrets',
    v: 'Accès FTP, clés API : jamais en clair · coffre chiffré, seule la référence circule.',
    evidence: (
      <>
        <Code>clients.secrets</Code> est chiffrée applicativement (libsodium,{' '}
        <Code>crypto/secrets.ts</Code>) et l’API ne rend que les NOMS des accès (
        <Code>clients/repo.ts</Code>, <Code>GET /api/vault</Code>) · l’inventaire du coffre se lit
        dans les réglages
      </>
    ),
  },
  {
    status: 'spec',
    k: 'accès agents',
    v: 'Un outil MCP « memory » exposé aux rôles : search(cercle, requête) et propose(entrée) · proposer est leur seul droit d’écriture.',
    evidence: (
      <>
        <Code>client_kb</Code> figure bien dans la politique d’outils du garant, du dev et du
        communicant (<Code>db/seed.ts</Code>), et leurs prompts leur disent de l’appeler — mais
        aucun serveur MCP n’est câblé : <Code>resolveToolPolicy</Code> passe{' '}
        <Code>mcpServers: {'{}'}</Code> et <Code>strictMcpConfig: true</Code> (
        <Code>runtime/tools.ts</Code>). L’outil n’existe pas ; la fiche est collée dans le préambule
        à la place
      </>
    ),
  },
  {
    status: 'spec',
    k: 'traçabilité',
    v: 'Chaque entrée garde sa provenance : run d’origine, agent, validation humaine, versions successives.',
    evidence: (
      <>
        la provenance existe pour les passations (<Code>messages</Code>, timeline du run) et pour
        une réponse archivée (<Code>source_item_id</Code> dans <Code>clients.notes</Code>) · aucune
        entrée de savoir n’a de version ni de chaîne de validation
      </>
    ),
  },
]

const EVOLVE: SpecCardProps[] = [
  {
    status: 'spec',
    title: 'Péremption douce',
    body: 'Chaque entrée a une durée de confiance ; passée la date, Hive propose de confirmer ou d’archiver.',
    evidence:
      'rien ne porte de durée de confiance · la revue trimestrielle du pack (« Revue des savoirs ») n’a ni écran ni route dans l’application',
  },
  {
    status: 'spec',
    title: 'Score d’utilité',
    body: 'Rappels comptés : les entrées jamais consultées remontent dans une revue de nettoyage.',
    evidence: (
      <>
        aucun rappel n’est compté · la fiche client rend ses entrées sans compteur, exprès, plutôt
        qu’un zéro qui ferait croire qu’elles n’ont jamais servi (<Code>clients/repo.ts</Code>)
      </>
    ),
  },
  {
    status: 'spec',
    title: 'Déduplication',
    body: 'À la proposition, recherche des quasi-doublons · fusion suggérée plutôt qu’empilement.',
    evidence: 'aucune recherche de doublon · il n’y a pas de corpus où chercher',
  },
  {
    status: 'spec',
    title: 'Export & portabilité',
    body: 'Un globe s’exporte en JSON lisible (mémoire + fiches) · la conscience vous appartient.',
    evidence: (
      <>
        aucune route d’export · <Code>GET /api/globes</Code> rend le nom, la teinte et les projets,
        rien de plus
      </>
    ),
  },
]

const METRIC: SpecRowProps = {
  status: 'spec',
  k: 'questions évitées',
  v: 'Le compteur de la fiche client devient la métrique du globe : la conscience se mesure.',
  evidence: (
    <>
      ce compteur n’existe nulle part · ni la fiche client ni <Code>/api/analytics</Code> (qui
      mesure des tokens et des runs) ne le calculent
    </>
  ),
}

const EXCHANGE: SpecCardProps = {
  status: 'spec',
  title: 'L’emprunt, jamais la fuite',
  meta: 'globe → globe, par votre inbox',
  body: 'Les globes sont étanches par défaut. Quand un agent a besoin d’un savoir d’un autre globe, il ne le lit pas : il demande un emprunt, tracé et révocable, et les fiches clients ne sont jamais empruntables.',
  evidence:
    'aucune route, aucun type d’item, aucun mécanisme de portée · les globes ne partagent rien parce qu’ils ne portent rien à partager',
}

const ALL: readonly SpecStatus[] = [
  ...CIRCLES.map((c) => c.status),
  ...CYCLE.map((c) => c.status),
  ...STORAGE.map((s) => s.status),
  ...EVOLVE.map((e) => e.status),
  METRIC.status,
  EXCHANGE.status,
]

export function Conscience() {
  return (
    <>
      <SectionHeader label="Conscience collective" meta="spécification · mémoire des globes" />

      <SpecBody>
        <SpecHeader
          title="Comment un globe apprendra"
          intro={
            <>
              Un globe est un <span style={{ color: 'var(--text-hi)' }}>espace de conscience</span>{' '}
              : ses projets, ses clients et sa mémoire partagée. Tout ce que les agents apprennent
              doit y rester, s’y consulter, et s’y périmer proprement. Le titre du pack dit «
              comment un globe apprend » ; il n’apprend pas encore.
            </>
          }
        />

        <SpecScore statuses={ALL} />

        <SpecSection label="01 · Trois cercles de mémoire">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {CIRCLES.map((c) => (
              <SpecCard key={c.title} {...c} />
            ))}
          </div>
        </SpecSection>

        <SpecSection label="02 · Le cycle d’apprentissage">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {CYCLE.map((c) => (
              <SpecRow key={String(c.k)} {...c} />
            ))}
          </div>

          <Mockup caption="l’item d’inbox visé · aucun item de ce sous-type n’existe en base">
            <div
              style={{
                borderLeft: '3px solid var(--sem-approval)',
                padding: '4px 0 4px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <span
                style={{
                  font: '600 10px var(--font-mono)',
                  letterSpacing: '0.12em',
                  color: 'var(--sem-approval)',
                }}
              >
                VALIDATION · SAVOIR
              </span>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-mid)' }}>
                « Les PrestaShop de Desura tournent en PHP 8.1 max · vérifier avant toute mise à
                jour de module »
              </span>
              <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
                Desura · dev · proposé pour : mémoire du globe
              </span>
              <MockupActions actions={['Archiver tel quel', 'Corriger puis archiver', 'Refuser']} />
            </div>
          </Mockup>
          <Evidence status="spec">
            l’<Link to="/inbox">inbox</Link> rend déjà le panneau de ce sous-type, actions
            désactivées · il attend d’être alimenté, il n’est pas silencieux par choix
          </Evidence>
        </SpecSection>

        <SpecSection label="03 · Stockage & rappel (self-hosté)">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {STORAGE.map((s) => (
              <SpecRow key={String(s.k)} {...s} />
            ))}
          </div>
        </SpecSection>

        <SpecSection label="04 · Pour que ça reste vivant">
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}
          >
            {EVOLVE.map((e) => (
              <SpecCard key={e.title} {...e} />
            ))}
          </div>
          <SpecRow {...METRIC} />
        </SpecSection>

        <SpecSection label="05 · Échange entre globes">
          <SpecCard {...EXCHANGE} />
          <Mockup caption="la demande d’emprunt visée · aucune route ne la produit">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span
                style={{
                  font: '600 10px var(--font-mono)',
                  letterSpacing: '0.12em',
                  color: 'var(--sem-approval)',
                }}
              >
                VALIDATION · EMPRUNT{' '}
                <span style={{ color: 'var(--text-low)' }}>· Perso → Desura</span>
              </span>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-mid)' }}>
                Le garant de « Blog photo » demande : « conventions Docker » (3 entrées)
              </span>
              <MockupActions
                actions={['Accorder · lecture seule', 'Copier dans Perso (fork)', 'Refuser']}
              />
            </div>
          </Mockup>
        </SpecSection>
      </SpecBody>
    </>
  )
}
