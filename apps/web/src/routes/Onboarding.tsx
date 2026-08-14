import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { SeedOrb } from '../components/onboarding/SeedOrb'
import { StepNote, StepRow } from '../components/onboarding/StepRow'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth-context'

interface Probe {
  ok: boolean
  /** Présent seulement en échec : la cause telle que le serveur l'a rendue. */
  error?: string
  at: Date
}

const INTROS = [
  "Bonjour, je suis Hive. Avant la première boucle, deux choses doivent tenir : un runtime d'agent qui répond, et un projet à faire tourner.",
  "Un point sur deux. L'orbe grandira du reste quand il sera là.",
  'Le runtime répond et un projet existe · de quoi lancer une première boucle.',
]

const CAPTIONS = [
  "l'orbe attend un premier signe de vie",
  'un point vérifié sur deux',
  'runtime joignable · au moins un projet',
]

/**
 * Onboarding (`docs/design/Onboarding.dc.html`) · l'orbe naît à mesure que
 * l'instance a de quoi la faire naître.
 *
 * **Où s'arrête la connexion, où commence l'onboarding.** `Login.tsx` fait
 * l'identité : il pose la session, et `App.tsx` ne monte l'application (donc
 * cette route) que lorsqu'elle existe. Cet écran ne crée donc aucun compte,
 * n'a aucun champ d'identifiant, et ne peut pas être le premier écran d'une
 * instance vierge : quand on l'atteint, on est déjà connecté. Ce qu'il traite
 * est l'étage d'après — *cette instance peut-elle faire tourner une boucle ?*
 * — qui n'a rien à voir avec l'identité de la personne devant l'écran. Il n'y
 * a pas non plus de redirection automatique « premier lancement » : elle
 * vivrait dans `App.tsx`/`router.tsx`, hors du périmètre de cette session, et
 * surtout rien côté serveur ne dit aujourd'hui qu'une instance est neuve.
 * L'écran s'atteint par son URL, et reste juste quand on y revient plus tard.
 *
 * **Les trois étapes du prototype ne sont pas reprises telles quelles.**
 *
 * 1. « Connecter Claude · OAuth Max » : aucune route ne connecte quoi que ce
 *    soit — l'authentification de l'agent est celle de la machine hôte. Un
 *    bouton « Connecter » n'aurait pas de destinataire, il est donc absent.
 *    Reste ce qui existe et qui répond vraiment : `GET /api/health/auth`, qui
 *    ouvre une session agent. C'est un geste, jamais un état affiché à
 *    l'ouverture (même règle que le diagnostic de Réglages) — et il coûte une
 *    invocation, ce que la ligne dit.
 * 2. « Connecter Gmail & GitHub » : rien ne les connecte, et **rien ne dit
 *    s'ils sont connectés**. L'écran Réglages a retiré son bloc « Connexions »
 *    pour cette raison exacte ; en déduire une coche verte de la présence d'un
 *    secret dans le coffre affirmerait un état que personne n'a vérifié.
 *    L'étape reste — elle décrit un prérequis réel — mais sans bouton, sans
 *    pastille, et en disant où ça se règle : hors de cette interface.
 * 3. « Créer un premier projet » : la seule des trois qui existe vraiment. Son
 *    état vient de `GET /api/projects`, pas d'un clic mémorisé.
 *
 * **L'orbe suit ces faits.** Elle grandit sur deux points constatés (le
 * runtime a répondu · au moins un projet existe), jamais sur le nombre
 * d'étapes parcourues.
 */
export function Onboarding() {
  const { me } = useAuth()

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const projects = projectsQuery.data ?? []
  const hasProject = projects.length > 0

  const probe = useMutation<Probe, Error>({
    mutationFn: async () => ({ ...(await api.health.auth()), at: new Date() }),
  })
  const runtimeOk = probe.data?.ok === true

  const verified = (runtimeOk ? 1 : 0) + (hasProject ? 1 : 0)

  return (
    <main
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // 116px en bas : le bandeau Hive flotte au-dessus du contenu sur
        // toutes les pages, rien ne doit finir dessous.
        padding: '24px 16px 116px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          width: 'min(520px, 100%)',
          margin: 'auto 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background:
                'radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--accent) 85%, white), var(--accent) 45%, transparent)',
              boxShadow: '0 0 12px var(--accent-glow)',
            }}
          />
          <span style={{ font: '600 12px var(--font-sans)', letterSpacing: '0.3em' }}>
            SILITHID
          </span>
        </div>

        <SeedOrb verified={verified} caption={CAPTIONS[verified] ?? CAPTIONS[0] ?? ''} />

        <p
          style={{
            margin: '8px 0 0',
            textAlign: 'center',
            fontSize: 15.5,
            fontWeight: 500,
            lineHeight: 1.65,
            color: 'var(--text-mid)',
            textWrap: 'pretty',
          }}
        >
          {INTROS[verified] ?? INTROS[0]}
        </p>

        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 14 }}
        >
          <StepRow
            badge={runtimeOk ? '✓' : '1'}
            tone={runtimeOk ? 'verifie' : probe.data || probe.isError ? 'echec' : 'attendu'}
            title="Vérifier le runtime agent"
            meta="ouvre une vraie session d'agent · coûte une invocation"
            right={
              <button
                type="button"
                onClick={() => probe.mutate()}
                disabled={probe.isPending}
                style={{
                  border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)',
                  background: 'transparent',
                  color: 'var(--accent)',
                  borderRadius: 'var(--r-full)',
                  padding: '8px 15px',
                  font: '500 12px var(--font-sans)',
                  cursor: probe.isPending ? 'default' : 'pointer',
                  opacity: probe.isPending ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {probe.isPending
                  ? 'diagnostic…'
                  : probe.data || probe.isError
                    ? 'Relancer'
                    : 'Lancer'}
              </button>
            }
          >
            {!probe.data && !probe.isError && !probe.isPending && (
              <StepNote>
                rien n&rsquo;est affiché tant que le diagnostic n&rsquo;a pas tourné · le serveur
                n&rsquo;en garde aucun historique
              </StepNote>
            )}
            {probe.isPending && (
              <StepNote color="var(--pause)">
                session en cours d&rsquo;ouverture · jusqu&rsquo;à 30 s
              </StepNote>
            )}
            {probe.isError && (
              <StepNote color="var(--sem-alert)">
                la requête n&rsquo;a pas abouti · {probe.error.message}
              </StepNote>
            )}
            {probe.data && (
              <StepNote color={probe.data.ok ? 'var(--ok)' : 'var(--sem-alert)'}>
                {probe.data.ok
                  ? 'une session agent s’est ouverte et a répondu'
                  : `runtime injoignable · ${probe.data.error ?? 'cause non rendue par le serveur'}`}{' '}
                · {probe.data.at.toLocaleTimeString('fr-FR')}
              </StepNote>
            )}
            <StepNote>
              l&rsquo;authentification vit sur la machine qui héberge l&rsquo;instance · cet écran
              ne peut que constater qu&rsquo;elle répond, jamais l&rsquo;établir
            </StepNote>
          </StepRow>

          <StepRow
            badge="2"
            tone="hors-portee"
            title="Gmail et GitHub"
            meta="envoi des emails validés · lecture des PR et des diffs"
            right={
              <span
                style={{
                  font: '500 12px var(--font-sans)',
                  color: 'var(--text-low)',
                  whiteSpace: 'nowrap',
                }}
              >
                hors de cette interface
              </span>
            }
          >
            <StepNote>
              aucune route ne les connecte, aucune ne dit s&rsquo;ils le sont · ni bouton ni
              pastille verte ici, ce serait affirmer sans avoir vérifié
            </StepNote>
            <StepNote>
              GitHub · le serveur délègue au <code>gh</code> de la machine hôte, déjà authentifié (
              <code>gh auth login</code>)
            </StepNote>
            <StepNote>
              Gmail · les identifiants se déposent dans le coffre côté serveur ; l&rsquo;inventaire
              du coffre (Réglages) dit ce qui y est déposé, pas qu&rsquo;une connexion fonctionne
            </StepNote>
          </StepRow>

          <StepRow
            badge={hasProject ? '✓' : '3'}
            tone={hasProject ? 'verifie' : 'attendu'}
            title="Créer un premier projet"
            meta="Hive le construit avec vous · un projet et ses steps, rien de plus"
            right={
              <Link
                to="/creation"
                style={{
                  font: '500 12px var(--font-sans)',
                  color: 'var(--accent)',
                  whiteSpace: 'nowrap',
                }}
              >
                {hasProject ? 'En créer un autre' : 'Y aller'}
              </Link>
            }
          >
            {projectsQuery.isPending && <StepNote>lecture des projets…</StepNote>}
            {projectsQuery.isError && (
              <StepNote color="var(--sem-alert)">
                la liste des projets n&rsquo;a pas répondu · impossible de dire si un projet existe
              </StepNote>
            )}
            {hasProject && (
              <StepNote color="var(--ok)">
                {projects.length} projet{projects.length > 1 ? 's' : ''} dans cette instance ·{' '}
                {projects
                  .slice(0, 3)
                  .map((p) => p.name)
                  .join(' · ')}
                {projects.length > 3 ? ' · …' : ''}
              </StepNote>
            )}
            <StepNote>
              la scène de création n&rsquo;ouvre aucun dépôt et ne provisionne aucun staging · le
              dépôt <code>owner/nom</code> qu&rsquo;elle demande doit déjà exister
            </StepNote>
          </StepRow>
        </div>

        <div
          style={{
            minHeight: 54,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            marginTop: 6,
          }}
        >
          <Link
            to={hasProject ? '/' : '/creation'}
            style={{
              padding: '13px 30px',
              borderRadius: 'var(--r-full)',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              font: '600 14.5px var(--font-sans)',
              boxShadow: '0 0 26px var(--accent-glow)',
            }}
          >
            {hasProject ? 'Aller au dashboard' : 'Créer votre premier projet'}
          </Link>
        </div>

        <div
          style={{
            paddingTop: 10,
            font: '10.5px var(--font-mono)',
            color: 'var(--text-low)',
            textAlign: 'center',
            textWrap: 'pretty',
          }}
        >
          instance self-hostée · vos données restent chez vous · connecté en tant que {me.login}
        </div>
      </div>
    </main>
  )
}
