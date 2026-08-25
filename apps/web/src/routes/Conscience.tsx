import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { SectionHeader } from '../components/SectionHeader'
import { Code, SpecRow, SpecSection } from '../components/spec/kit'
import { type ApercuMemoireView, api } from '../lib/api'

/**
 * `/conscience` · la mémoire, telle qu'elle est.
 *
 * ## Ce que cet écran disait, et pourquoi c'était grave
 *
 * Il déclarait, en toutes lettres : « **la conscience collective n'existe
 * pas** · aucune table de savoirs, aucun embedding, aucun rappel compté, aucun
 * emprunt inter-globes ». C'était exact au moment où il a été écrit, et la
 * Phase 7 a depuis livré les quatre cercles, le versionnement, le compteur de
 * rappels, l'emprunt entre globes et la revue de péremption.
 *
 * L'app NIAIT donc une fonctionnalité qu'elle avait. C'est la faute exactement
 * inverse de celle que ce dépôt s'astreint à éviter, et elle coûte autant :
 * un lecteur qui croit l'écran cherche ailleurs ce qui est sous ses yeux.
 *
 * ## Ce qu'il fait maintenant
 *
 * Il lit `GET /api/savoirs/apercu` et rend **des chiffres mesurés**. Pas de
 * bloc « spécifié » là où la chose tourne, et pas de bloc « construit » là où
 * elle ne tourne pas : ce qui reste absent le reste, nommément, avec sa
 * raison. Le rappel sémantique par embedding, en particulier, n'existe
 * toujours pas et n'est pas prévu.
 *
 * Une mémoire vide n'est pas un écran vide : c'est un état, et il est dit.
 */

const LABEL: Record<string, string> = {
  projet: 'Projet',
  client: 'Client',
  globe: 'Globe',
  hive: 'Hive',
}

const PORTEE: Record<string, string> = {
  projet: 'le cercle le plus proche · ce qui ne vaut que pour ce projet',
  client: 'sa fiche, son ton, ce qu’il a déjà répondu',
  globe: 'conventions de l’agence, stack, patterns · partagé par tous ses projets',
  hive: 'arbitrages transverses · jamais de secret client',
}

export function Conscience() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['savoirs', 'apercu'],
    queryFn: api.savoirs.apercu,
  })

  return (
    <>
      <SectionHeader
        label="Conscience collective"
        meta={
          data
            ? `${data.actifs} savoir${data.actifs > 1 ? 's' : ''} actif${data.actifs > 1 ? 's' : ''} · ${data.versions} version${data.versions > 1 ? 's' : ''} archivée${data.versions > 1 ? 's' : ''}`
            : 'lecture…'
        }
      />
      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px 116px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, maxWidth: 900 }}>
          {isPending && <Note>lecture de la mémoire…</Note>}
          {isError && <Note>mémoire injoignable · réessai automatique</Note>}
          {data && <Contenu apercu={data} />}
        </div>
      </main>
    </>
  )
}

function Contenu({ apercu }: { apercu: ApercuMemoireView }) {
  const vide = apercu.actifs === 0

  return (
    <>
      {/* Une mémoire vide n'est pas une panne, et ce n'est pas non plus rien à
          dire : c'est l'état normal d'une installation neuve. */}
      {vide && (
        <Note>
          la mémoire est vide · elle se remplit quand vous validez une proposition de savoir dans
          l&rsquo;inbox, jamais toute seule
        </Note>
      )}

      <SpecSection label="La cascade · du plus spécifique au plus général">
        {apercu.cercles.map((c) => (
          <Mesure
            key={c.cercle}
            k={LABEL[c.cercle] ?? c.cercle}
            v={PORTEE[c.cercle] ?? ''}
            chiffre={
              <>
                {compte(c.actifs, 'savoir', 'savoirs')}
                {c.instances !== null && (
                  <> · {compte(c.instances, 'instance concernée', 'instances concernées')}</>
                )}
                {' · '}
                {compte(c.rappels, 'rappel', 'rappels')}
              </>
            }
          />
        ))}
        <Note>
          une question traverse les quatre dans cet ordre · le premier qui sait répond, sujet par
          sujet
        </Note>
      </SpecSection>

      <SpecSection label="Ce que la mémoire mesure d’elle-même">
        <Mesure
          k="utilité"
          v="chaque rappel incrémente un compteur · c’est lui qui trie la revue"
          chiffre={
            apercu.plusUtile ? (
              <>
                le plus servi · {apercu.plusUtile.sujet} ({apercu.plusUtile.cercle}),{' '}
                {compte(apercu.plusUtile.rappels, 'rappel', 'rappels')}
              </>
            ) : (
              <>aucun savoir n’a encore servi à un agent</>
            )
          }
        />
        <Mesure
          k="jamais rappelé"
          v="un savoir qu’aucun agent n’a servi est soit faux, soit inutile · dans les deux cas il remonte en revue"
          chiffre={
            <>
              {compte(apercu.jamaisRappeles, 'savoir', 'savoirs')} ·{' '}
              <Link to="/revue-savoirs">ouvrir la revue</Link>
            </>
          }
        />
        <Mesure
          k="versions"
          v="corriger un savoir crée une version · l’ancienne reste lisible, rien n’est écrasé"
          chiffre={compte(apercu.versions, 'version archivée', 'versions archivées')}
        />
      </SpecSection>

      <SpecSection label="Les globes sont étanches">
        <Mesure
          k="emprunt"
          v="en lecture, il suit son prêteur et meurt avec l’emprunt · en copie, il vit sa vie"
          chiffre={
            <>
              {compte(apercu.emprunts.actifs, 'emprunt actif', 'emprunts actifs')} ·{' '}
              {apercu.emprunts.lecture} en lecture, {apercu.emprunts.fork} en copie
            </>
          }
        />
        <Mesure
          k="fiche client"
          v="ne s’emprunte jamais · la table d’emprunt ne peut pas la désigner"
          chiffre={<>impossibilité de schéma, pas une vérification qu’on pourrait oublier</>}
        />
      </SpecSection>

      <SpecSection label="Ce qu’on apprend par stack">
        <Mesure
          k="code"
          v="injecté dans le cadrage d’un step · ce que le dev et le garant doivent savoir"
          chiffre={compte(apercu.stack.code, 'savoir', 'savoirs')}
        />
        <Mesure
          k="exploitation"
          v="injecté dans un plan de déploiement · ce que l’agent ops doit savoir"
          chiffre={compte(apercu.stack.exploitation, 'savoir', 'savoirs')}
        />
        <Note>
          les deux mémoires ne se mélangent pas · « penser au robots.txt » n&rsquo;a rien à faire
          dans le cadrage d&rsquo;un dev, et « eager loading par défaut » rien à faire dans un plan
          de serveur
        </Note>
      </SpecSection>

      <SpecSection label="Ce qui n’existe pas, et n’est pas prévu">
        <SpecRow
          status="spec"
          k="rappel sémantique"
          v="le pack décrit un rappel par embedding · le rappel réel est lexical, par sujet et par cercle"
          evidence={
            <>
              aucune extension vectorielle, aucun index à maintenir · la détection de conflit se
              fait sur le <Code>sujet</Code> déclaré, ce qui est déterministe et gratuit, et
              imparfait
            </>
          }
        />
        <SpecRow
          status="spec"
          k="déduplication"
          v="deux savoirs de sujets différents qui disent la même chose passent tous les deux"
          evidence={
            <>
              c’est l’angle mort assumé de la détection par sujet · il se referme par la revue de
              péremption, pas automatiquement
            </>
          }
        />
        <SpecRow
          status="spec"
          k="export"
          v="aucune route ne sort la mémoire du produit"
          evidence={<>elle vit dans PostgreSQL · une sauvegarde de base la couvre, rien d’autre</>}
        />
      </SpecSection>
    </>
  )
}

/**
 * Une ligne de mesure.
 *
 * Volontairement PAS `SpecRow` : le kit de spécification préfixe sa preuve par
 * « où · », parce que pour un bloc construit la preuve est l'endroit du code
 * où il vit. Ici la preuve est un CHIFFRE mesuré, et « où · 1 actif » ne veut
 * rien dire. Le kit reste utilisé plus bas, pour la seule section qui est
 * encore un document.
 */
function Mesure({
  k,
  v,
  chiffre,
}: {
  k: string
  v: string
  chiffre: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '150px 1fr',
        gap: '4px 16px',
        padding: '10px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-hi)' }}>{k}</span>
      <span style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.55 }}>{v}</span>
      <span />
      <span style={{ font: '11px var(--font-mono)', color: 'var(--accent)' }}>{chiffre}</span>
    </div>
  )
}

/**
 * « 0 version archivée », « 1 version archivée », « 3 versions archivées ».
 *
 * On prend la phrase ENTIÈRE, adjectif compris : accorder le nom et laisser
 * l'adjectif figé donne « 1 instance concernée(s) », qu'on lit comme une
 * étourderie.
 *
 * Et on affiche toujours le chiffre, jamais « aucun ». La première version
 * disait « aucun » ou « aucune » selon que le mot finissait par un « e » —
 * ce qui donne « aucun version ». Le genre ne se déduit pas de la
 * terminaison en français, et cet écran est un tableau de bord : un zéro y
 * est plus lisible qu'une négation.
 */
function compte(n: number, singulier: string, pluriel: string): string {
  return `${n} ${n > 1 ? pluriel : singulier}`
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.7 }}>
      {children}
    </span>
  )
}
