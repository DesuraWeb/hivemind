import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { GHOST_BUTTON, Note, Panel, StatusLine } from './Panel'

interface Probe {
  ok: boolean
  error?: string
  /** Aller-retour mesuré ICI : `GET /api/health/auth` ne rend pas de latence. */
  ms: number
  at: Date
}

/**
 * Le diagnostic d'authentification (`Reglages.dc.html`, bloc « Auth Claude »).
 *
 * Le pack affiche quatre lignes en permanence : session « opérationnelle ·
 * OAuth Max », dernier healthcheck avec sa latence, expiration « dans 47 j »,
 * et la fenêtre de 5 h. Deux d'entre elles n'existent pas :
 *
 * - **le mode d'authentification et l'expiration** ne sont exposés par rien.
 *   Ils sont absents, et l'écran dit pourquoi plutôt que de laisser deviner ;
 * - **l'état permanent** n'existe pas non plus : `GET /api/health/auth`
 *   n'est pas un état, c'est un geste — il ouvre une vraie session agent. Rien
 *   n'est affiché tant qu'on ne l'a pas lancé, parce qu'un « opérationnel »
 *   affiché à l'ouverture de la page serait une affirmation sans mesure.
 *
 * La fenêtre de 5 h vit dans le panneau Budget, qui a sa propre route.
 */
export function AuthDiagnostic() {
  const probe = useMutation<Probe, Error>({
    mutationFn: async () => {
      const startedAt = Date.now()
      const res = await api.health.auth()
      return { ...res, ms: Date.now() - startedAt, at: new Date() }
    },
  })

  const result = probe.data ?? null

  return (
    <Panel
      label="Authentification agent · diagnostic"
      right={
        <button
          type="button"
          className="reglages-ghost"
          onClick={() => probe.mutate()}
          disabled={probe.isPending}
          style={{ ...GHOST_BUTTON, opacity: probe.isPending ? 0.5 : 1 }}
        >
          {probe.isPending ? 'healthcheck en cours…' : 'Lancer un healthcheck'}
        </button>
      }
    >
      {!result && !probe.isError && !probe.isPending && (
        <Note>
          aucun healthcheck lancé depuis l&rsquo;ouverture de cet écran · le serveur n&rsquo;en
          garde aucun historique, il faut le lancer pour savoir
        </Note>
      )}

      {probe.isPending && (
        <StatusLine color="var(--pause)">
          session agent en cours d&rsquo;ouverture · jusqu&rsquo;à 30 s avant que le silence compte
          comme une panne
        </StatusLine>
      )}

      {probe.isError && (
        <StatusLine color="var(--sem-alert)">
          la requête de diagnostic n&rsquo;a pas abouti · {probe.error.message}
        </StatusLine>
      )}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {result.ok ? (
            <StatusLine color="var(--ok)">
              runtime joignable · une session agent s&rsquo;est ouverte et a répondu
            </StatusLine>
          ) : (
            <StatusLine color="var(--sem-alert)">
              runtime injoignable · {result.error ?? 'cause non rendue par le serveur'}
            </StatusLine>
          )}
          <StatusLine color="var(--text-low)">
            aller-retour {result.ms} ms · mesuré depuis le navigateur, la route ne rend pas de
            latence
          </StatusLine>
          <StatusLine color="var(--text-low)">
            lancé à {result.at.toLocaleTimeString('fr-FR')}
          </StatusLine>
          {!result.ok && (
            <Note>
              un item d&rsquo;inbox « alerte » et un email viennent de partir · pas de doublon tant
              qu&rsquo;une alerte de même cause reste ouverte
            </Note>
          )}
        </div>
      )}

      <Note>
        expiration de la session · non exposée : ni le SDK ni la route ne rendent de date, ce
        diagnostic ne peut pas l&rsquo;annoncer
      </Note>
      <Note>
        chaque lancement ouvre une vraie session agent, donc coûte une invocation · c&rsquo;est
        pourquoi il reste un geste, jamais un rafraîchissement automatique
      </Note>
    </Panel>
  )
}
