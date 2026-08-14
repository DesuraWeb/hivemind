import { Link } from '@tanstack/react-router'
import { SectionHeader } from '../components/SectionHeader'
import {
  Code,
  Evidence,
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
 * `/protocole` · reprise de `docs/design/Protocole agents.dc.html`.
 *
 * Contrairement à `/conscience`, cette page décrit surtout des choses qui
 * tournent : le pipeline des rôles, les passations écrites dans `messages`, le
 * gate humain de fin de step. C'est justement ce qui la rend dangereuse à
 * recopier telle quelle — au milieu de dix affirmations vraies, quatre
 * fausses passent inaperçues.
 *
 * Trois écarts entre le pack et le code méritent d'être nommés ici, parce
 * qu'ils changent le dessin de la page et pas seulement son texte :
 *
 * 1. **Le juge ne tranche pas.** Le pack termine la boucle par « juge →
 *    verdict ». Son prompt dit l'inverse (« Tu décris. Tu ne décides pas »),
 *    et le code aussi : `judging.ts` écrit juge → garant, `verdict.ts` fait
 *    écrire le verdict au garant. Le schéma est donc dessiné tel qu'il tourne,
 *    pas tel que le pack le dessine — une flèche fausse est un mensonge plus
 *    difficile à repérer qu'une phrase fausse.
 * 2. **La boucle est une étoile, pas une chaîne.** « Un agent ne parle qu'à
 *    son successeur » est démenti par le bus : dev, reviewer et juge rendent
 *    tous au garant.
 * 3. **Il y a une sixième étape, `deploying`**, absente du pack : c'est elle
 *    qui capture les pages que le juge regarde.
 *
 * Le reste suit la même règle que `/conscience` : un état et une preuve par
 * bloc, deux états seulement, compteur dérivé (`components/spec/kit.tsx`).
 */

interface PipelineNode {
  role: string
  state: string
  what: string
  color: string
  /** Événement qui fait passer à l'étape suivante (`domain/run-state.ts`). */
  event?: string
}

const PIPELINE: PipelineNode[] = [
  {
    role: 'Garant',
    state: 'framing',
    what: 'cadre le step, écrit le prompt du dev',
    color: 'oklch(0.82 0.06 235)',
    event: 'frame_ready',
  },
  {
    role: 'Dev',
    state: 'coding',
    what: 'produit le diff, ouvre la PR',
    color: 'var(--accent)',
    event: 'pr_opened',
  },
  {
    role: 'Reviewer',
    state: 'reviewing',
    what: 'relit la PR, exécute les tests',
    color: 'var(--sem-question)',
    event: 'review_ok',
  },
  {
    role: 'Système',
    state: 'deploying',
    what: 'déploie et capture les pages',
    color: 'var(--text-low)',
    event: 'ci_green',
  },
  {
    role: 'Juge',
    state: 'judging',
    what: 'compare les captures aux critères',
    color: 'var(--sem-verdict)',
    event: 'judge_report',
  },
  {
    role: 'Garant',
    state: 'verdict',
    what: 'tranche : conforme ou écarts',
    color: 'oklch(0.82 0.06 235)',
  },
]

const LOOP: SpecRowProps[] = [
  {
    status: 'built',
    k: 'la boucle',
    v: 'Six états enchaînés par des événements typés, une transition à la fois, verrouillée en base.',
    evidence: (
      <>
        <Code>domain/run-state.ts</Code> décide, <Code>loop/orchestrator.ts</Code> applique état,
        effets et ligne d’audit dans une seule transaction · un job rejoué sur un run déjà avancé
        n’écrit rien
      </>
    ),
  },
  {
    status: 'built',
    k: 'majordome (Hive)',
    v: 'Hors boucle : la vue d’ensemble, le fil de conversation, l’optimisation d’une réponse d’inbox.',
    evidence: (
      <>
        <Code>hive/conversation.ts</Code> (<Code>POST /api/hive/messages</Code>) et{' '}
        <Code>inbox/optimize.ts</Code> · il n’ouvre jamais de session dans un run
      </>
    ),
  },
  {
    status: 'spec',
    k: 'communicant',
    v: 'Hors boucle : rédige aux clients, à partir de la fiche client et du ton attendu.',
    evidence: (
      <>
        son template, sa politique d’outils et sa surface MCP existent et sont testés (
        <Code>communication/client-email.ts</Code>), mais aucune étape n’ouvre de session
        communicant · rien n’écrit à un client aujourd’hui
      </>
    ),
  },
]

const HANDOFFS: SpecRowProps[] = [
  {
    status: 'built',
    k: 'garant → dev',
    v: 'Le cadrage du step : prompt, critères d’acceptation, pages à juger, et le correctif du verdict précédent s’il y a itération.',
    evidence: (
      <>
        <Code>framing.ts</Code> · <Code>kind: &apos;prompt&apos;</Code>, <Code>body</Code> = le
        prompt du dev, <Code>meta</Code> = critères et pages · le correctif est relu dans le bus (
        <Code>findLatestCorrection</Code>), jamais compté
      </>
    ),
  },
  {
    status: 'spec',
    k: 'garant → dev · savoirs',
    v: 'Les savoirs rappelés voyagent avec le cadrage, explicitement listés.',
    evidence: (
      <>
        aucun savoir n’est injecté · seul un résumé de la fiche client est collé dans le préambule
        du garant, et le dev n’en reçoit rien · voir <Link to="/conscience">conscience</Link>
      </>
    ),
  },
  {
    status: 'built',
    k: 'dev → garant',
    v: 'Le rapport d’implémentation, avec la pull request ouverte.',
    evidence: (
      <>
        <Code>coding.ts</Code> · <Code>kind: &apos;report&apos;</Code>, <Code>meta.pr_number</Code>{' '}
        et <Code>meta.pr_url</Code>
      </>
    ),
  },
  {
    status: 'spec',
    k: 'dev → reviewer',
    v: 'Diff complet, notes d’implémentation, résultat de la suite de tests.',
    evidence: (
      <>
        cette flèche n’existe pas : le reviewer relit le rapport <Code>dev → garant</Code> dans le
        bus (<Code>findLatestDevReport</Code>) et travaille sur un worktree de la branche de la PR (
        <Code>reviewing.ts</Code>) · le contenu y est, l’adressage non
      </>
    ),
  },
  {
    status: 'built',
    k: 'reviewer → dev',
    v: 'Les points actionnables, fichier par fichier · un KO renvoie le step au dev.',
    evidence: (
      <>
        <Code>reviewing.ts</Code> · points <Code>{'{ file, line, action }'}</Code> · trois
        allers-retours au maximum, puis alerte et main humaine (<Code>domain/run-state.ts</Code>)
      </>
    ),
  },
  {
    status: 'spec',
    k: 'reviewer → dev · sévérités',
    v: 'Remarques typées mineur / bloquant · bloquant = itération, mineur = à la discrétion du dev.',
    evidence: (
      <>
        aucune sévérité dans le schéma du reviewer : c’est <Code>verdict: OK | KO</Code> qui décide,
        et un KO renvoie toujours au dev · les sévérités existent, mais chez le juge (bloquant /
        majeur / mineur)
      </>
    ),
  },
  {
    status: 'spec',
    k: 'reviewer → juge',
    v: 'Diff approuvé + réserves résiduelles · le juge sait ce qui a été toléré.',
    evidence: (
      <>
        le reviewer rend son OK au garant (<Code>reviewing.ts</Code>) et le juge ne le lit pas : son
        préambule contient le cadrage et les captures, rien du reviewer (<Code>judging.ts</Code>)
      </>
    ),
  },
  {
    status: 'built',
    k: 'juge → garant',
    v: 'Le constat visuel : conformités citées, écarts avec sévérité, page, viewport et capture.',
    evidence: (
      <>
        <Code>judging.ts</Code> · sortie structurée validée contre les captures réellement
        enregistrées, un écart qui cite une capture inexistante est refusé
      </>
    ),
  },
  {
    status: 'built',
    k: 'garant → boucle',
    v: 'Le verdict structuré : conforme, ou écarts qui pilotent l’itération suivante.',
    evidence: (
      <>
        <Code>verdict.ts</Code> écrit le verdict et le correctif <Code>garant → dev</Code> ·{' '}
        <Code>domain/run-state.ts</Code> en tire l’itération suivante, ou l’échec quand les
        itérations sont épuisées
      </>
    ),
  },
  {
    status: 'built',
    k: 'verdict → inbox',
    v: 'En mode gated, un verdict conforme s’arrête chez vous avant toute suite.',
    evidence: (
      <>
        <Code>domain/run-state.ts</Code> · <Code>approval · step_end</Code> et passage en{' '}
        <Code>awaiting_human</Code> · le step de la boucle prime sur le défaut du projet
      </>
    ),
  },
  {
    status: 'built',
    k: 'agent → inbox',
    v: 'Une question d’agent ouvre un item, toujours · c’est l’unique porte vers vous.',
    evidence: (
      <>
        <Code>open_inbox_item</Code> est le seul effet qui vous interpelle (question, alerte,
        validation de fin de step) · le rôle émetteur est conservé sur l’item
      </>
    ),
  },
  {
    status: 'spec',
    k: 'agent → Hive',
    v: 'Les trouvailles remontent à Hive comme propositions de savoir, jamais directement à l’humain.',
    evidence: 'aucun rôle ne produit de trouvaille · il n’y a ni canal ni destination pour elle',
  },
]

const RULES: SpecCardProps[] = [
  {
    status: 'spec',
    title: 'Un agent ne parle qu’à son successeur',
    body: 'Jamais en diagonale : chaque rôle passe la main au suivant dans la boucle.',
    evidence: (
      <>
        dans le bus, tout remonte au garant — <Code>dev → garant</Code>,{' '}
        <Code>reviewer → garant</Code>, <Code>juge → garant</Code> · la boucle est une étoile autour
        du garant, et <Code>reviewer → dev</Code> est justement la passation latérale que la règle
        interdirait
      </>
    ),
  },
  {
    status: 'built',
    title: 'Seul le communicant écrit aux clients',
    body: 'Et jamais sans votre validation.',
    evidence: (
      <>
        <Code>gmail_draft</Code> n’est dans la politique d’outils que du communicant, et cette
        surface ne sait que créer un brouillon · l’envoi exige un <Code>HumanSendApproval</Code>{' '}
        construit depuis un item d’inbox résolu (<Code>communication/client-email.ts</Code>)
      </>
    ),
  },
  {
    status: 'spec',
    title: 'Seul Hive écrit en mémoire',
    body: 'Les agents proposent, ils n’écrivent pas : toute entrée passe par une validation « savoir ».',
    evidence: (
      <>
        il n’y a pas de mémoire à écrire, donc pas de droit à répartir ·{' '}
        <Link to="/conscience">conscience</Link> détaille ce qui manque
      </>
    ),
  },
  {
    status: 'built',
    title: 'Le juge ne voit jamais le code',
    body: 'Il juge le résultat, pas le diff qui l’a produit.',
    evidence: (
      <>
        sa session s’ouvre dans le dossier des artefacts du run, avec{' '}
        <Code>fs: &apos;read&apos;</Code> borné à ce dossier (<Code>judging.ts</Code>) · il reçoit
        les captures et le cadrage, jamais le worktree
      </>
    ),
  },
  {
    status: 'built',
    title: 'Toute passation est journalisée',
    body: 'La timeline d’audit est la source de vérité.',
    evidence: (
      <>
        <Code>appendMessage</Code> est l’unique écriture du bus (<Code>loop/bus.ts</Code>), et
        l’orchestrateur y ajoute chaque transition d’état dans la même transaction que l’état
        lui-même
      </>
    ),
  },
  {
    status: 'built',
    title: 'Jamais de blocage silencieux',
    body: 'Toute question d’agent ouvre un item d’inbox, bloquante ou non.',
    evidence: (
      <>
        <Code>domain/run-state.ts</Code> · l’item est ouvert dans les deux cas, avec le rôle qui l’a
        posée
      </>
    ),
  },
  {
    status: 'spec',
    title: 'Une question suspend la boucle',
    body: 'Le run s’arrête tant qu’un humain n’a pas répondu.',
    evidence: (
      <>
        seule une question déclarée <em>bloquante</em> passe le run en <Code>awaiting_human</Code>{' '}
        et mémorise l’état de reprise · une question non bloquante laisse la boucle avancer sur une
        hypothèse, ce que le pack ne dit pas
      </>
    ),
  },
]

const PAYLOAD_SPEC = `{
  "run": "run_8f3a2c",         "step": 4,
  "iteration": 2,              "max_iterations": 4,
  "specs_ref": "step-04.md",   "constraints": ["PHP 8.1 max", "mise en ligne < 30 sept"],
  "recalled_knowledge": ["kn_php81", "kn_tri_pertinence"],
  "previous_verdict": { "status": "corriger", "gaps": ["tri par note"] }
}`

const PAYLOAD_REAL = `messages
  run_id      uuid        -- le run, donc le step et le projet
  from_role   'garant'
  to_role     'dev'
  kind        'prompt'
  body        md          -- le prompt du dev, en markdown
  meta        jsonb       -- { acceptance_criteria: [...], pages_to_judge: [...] }
  created_at  timestamptz -- l'ordre de la timeline, id en départage`

const PAYLOAD: { spec: SpecStatus; real: SpecStatus } = { spec: 'spec', real: 'built' }

const ALL: readonly SpecStatus[] = [
  ...LOOP.map((l) => l.status),
  ...HANDOFFS.map((h) => h.status),
  ...RULES.map((r) => r.status),
  PAYLOAD.spec,
  PAYLOAD.real,
]

function Pre({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '14px 16px',
        borderRadius: 'var(--r-md)',
        background: 'rgba(9, 14, 22, 0.6)',
        font: '11.5px var(--font-mono)',
        color: 'var(--text-mid)',
        lineHeight: 1.7,
        overflowX: 'auto',
      }}
    >
      {children}
    </pre>
  )
}

export function Protocole() {
  return (
    <>
      <SectionHeader label="Protocole inter-agents" meta="spécification · passations d’un run" />

      <SpecBody>
        <SpecHeader
          title="Qui parle à qui, et avec quoi"
          intro={
            <>
              La boucle est un pipeline de passations typées, pas une conversation libre. Chaque
              flèche transporte un{' '}
              <span style={{ color: 'var(--text-hi)' }}>payload contractuel</span>, journalisé dans
              la timeline d’audit. Le schéma ci-dessous est celui du code, pas celui du pack : deux
              flèches du prototype n’existent pas, et le juge n’y tranche rien.
            </>
          }
        />

        <SpecScore statuses={ALL} />

        <SpecSection label="01 · La boucle, telle qu’elle tourne">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              gap: '18px 0',
              // Marge haute : l'étiquette d'événement remonte au-dessus du
              // trait pour se caler sur le centre des pastilles (marginTop
              // négatif plus bas), il lui faut la place.
              padding: '16px 0 4px',
            }}
          >
            {PIPELINE.map((node) => (
              <div key={node.state} style={{ display: 'flex', alignItems: 'flex-start' }}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    width: 96,
                  }}
                >
                  <span
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: 999,
                      background: node.color,
                      boxShadow: `0 0 12px color-mix(in oklab, ${node.color} 35%, transparent)`,
                    }}
                  />
                  <span style={{ font: '600 12.5px var(--font-sans)' }}>{node.role}</span>
                  <span style={{ font: '10px var(--font-mono)', color: node.color }}>
                    {node.state}
                  </span>
                  <span
                    style={{
                      font: '10px var(--font-mono)',
                      color: 'var(--text-low)',
                      textAlign: 'center',
                      lineHeight: 1.5,
                    }}
                  >
                    {node.what}
                  </span>
                </div>
                {node.event && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 3,
                      // Le trait doit passer par le centre de la pastille
                      // (11 px de haut) : l'étiquette au-dessus mesure ~12 px,
                      // plus 3 px de gouttière.
                      marginTop: -9,
                    }}
                  >
                    <span
                      style={{
                        font: '9.5px var(--font-mono)',
                        color: 'var(--text-low)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {node.event}
                    </span>
                    <span
                      style={{ width: 44, height: 1, background: 'var(--line-strong)' }}
                      aria-hidden="true"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 26,
              flexWrap: 'wrap',
              font: '11px var(--font-mono)',
              color: 'var(--text-low)',
            }}
          >
            <span>↩ review_ko → coding · 3 tours au plus, puis alerte</span>
            <span>↩ verdict_ecarts → framing · itération suivante</span>
            <span>question bloquante → awaiting_human</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {LOOP.map((l) => (
              <SpecRow key={String(l.k)} {...l} />
            ))}
          </div>

          <Evidence status="built">
            le pack fait trancher le juge ; son propre prompt dit l’inverse (« Tu décris. Tu ne
            décides pas ») et le code aussi · le schéma ci-dessus suit le code, et ajoute l’étape{' '}
            <Code>deploying</Code> que le pack ne montre pas
          </Evidence>
        </SpecSection>

        <SpecSection label="02 · Passations · le contrat de chaque flèche">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {HANDOFFS.map((h) => (
              <SpecRow key={String(h.k)} {...h} />
            ))}
          </div>
        </SpecSection>

        <SpecSection label="03 · Règles dures">
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}
          >
            {RULES.map((r) => (
              <SpecCard key={r.title} {...r} />
            ))}
          </div>
        </SpecSection>

        <SpecSection label="04 · Le payload d’une passation">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SpecRow
              status={PAYLOAD.spec}
              k="la forme spécifiée"
              v="Un objet contractuel par passation, avec les savoirs rappelés listés explicitement."
              evidence={
                <>
                  <Code>recalled_knowledge</Code> n’a aucune source, et le reste du bloc décrit un
                  objet que rien ne sérialise · les identifiants de run et de step existent, mais
                  sous forme de colonnes
                </>
              }
            />
            <Pre>{PAYLOAD_SPEC}</Pre>
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              extrait du pack, reproduit tel quel · aucune ligne de code ne produit cet objet
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SpecRow
              status={PAYLOAD.real}
              k="la forme réelle"
              v="Une ligne du bus par passation : le corps en markdown, le contrat structuré dans meta."
              evidence={
                <>
                  <Code>messages</Code> (migration 0001), écrite par <Code>appendMessage</Code> ·
                  l’itération et le nombre maximum vivent sur <Code>runs</Code> et{' '}
                  <Code>steps</Code>, pas dans le message
                </>
              }
            />
            <Pre>{PAYLOAD_REAL}</Pre>
          </div>
        </SpecSection>
      </SpecBody>
    </>
  )
}
