import type { ReactNode } from 'react'

/**
 * Le vocabulaire commun des deux pages de spécification (`/conscience`,
 * `/protocole`).
 *
 * ## Le problème que ce fichier résout
 *
 * Les deux prototypes (`docs/design/Conscience collective.dc.html`,
 * `Protocole agents.dc.html`) décrivent le système au présent : « les agents
 * cherchent par sens », « seul Hive écrit en mémoire », « recalled_knowledge :
 * les savoirs injectés sont explicites ». Une bonne moitié de ces phrases est
 * fausse aujourd'hui — aucune table de savoirs n'existe, aucun rappel n'est
 * mesuré, aucun emprunt inter-globes n'est possible. Publier ces pages telles
 * quelles, c'est afficher un état qu'on n'a pas : la même faute qu'un bouton
 * qui ne fait rien.
 *
 * ## La forme retenue : deux états, une preuve obligatoire
 *
 * Chaque affirmation de ces pages porte une marque, et **jamais une marque
 * seule** :
 *
 * - `built` → « EN PLACE », suivi de **où** : le fichier, la table ou la
 *   colonne qui rend la phrase vraie. Une marque sans adresse serait une
 *   affirmation de plus.
 * - `spec` → « NON CONSTRUIT », suivi de **ce qui se passe à la place**
 *   aujourd'hui. C'est la partie qui compte : dire « pas encore » laisse
 *   croire que la case est vide, alors qu'il y a presque toujours un mécanisme
 *   dégradé qui tourne et qu'il faut nommer pour ne pas le chercher en vain.
 *
 * Deux états, pas trois. Un « partiel » aurait été confortable — plusieurs
 * blocs sont à moitié vrais — mais c'est exactement l'étiquette qu'un lecteur
 * pressé lit comme « ça marche à peu près ». La règle d'attribution est donc
 * stricte : **`built` si la phrase écrite sur la page est vraie du code tel
 * qu'il est aujourd'hui, `spec` sinon**, et c'est la ligne de preuve qui porte
 * la nuance. Là où une phrase du pack mélangeait du vrai et du faux, elle a
 * été coupée en deux blocs plutôt que teintée d'un état tiède.
 *
 * ## Ce que la marque change à l'œil
 *
 * Le pack colorait le liseré des cartes par sémantique décorative (accent /
 * verdict / question). Ce liseré est repris pour porter l'état : plein sur
 * `--ok` quand c'est construit, **tireté et gris** quand ça ne l'est pas. Le
 * signal le plus fort de la page devient donc « ça tourne / ça ne tourne pas »,
 * avant même la première ligne lue — c'est le seul choix cohérent avec ce que
 * ces pages risquent de faire croire.
 */

export type SpecStatus = 'built' | 'spec'

const MARK: Record<SpecStatus, { label: string; color: string }> = {
  built: { label: 'EN PLACE', color: 'var(--ok)' },
  spec: { label: 'NON CONSTRUIT', color: 'var(--text-low)' },
}

/** Préfixe de la ligne de preuve : une adresse pour l'un, un état réel pour l'autre. */
const EVIDENCE_PREFIX: Record<SpecStatus, string> = {
  built: 'où · ',
  spec: "aujourd'hui · ",
}

const CARD_BG = 'rgba(13, 20, 32, 0.62)'

function border(status: SpecStatus): string {
  return status === 'built' ? '2px solid var(--ok)' : '2px dashed var(--line-strong)'
}

const LABEL_STYLE = {
  font: '600 10.5px var(--font-mono)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--text-mid)',
} as const

/**
 * Une adresse dans le code (fichier, table, colonne, route) citée dans une
 * ligne de preuve. C'est un composant plutôt qu'une règle CSS sur `code` :
 * ces deux pages sont les seules du produit à en poser, et une feuille de
 * style partagée serait un fichier de plus à se disputer entre sessions.
 */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.94em', color: 'var(--text-mid)' }}>
      {children}
    </code>
  )
}

/** Label de section mono petites caps (CLAUDE.md) — « 01 · Trois cercles de mémoire ». */
export function SpecSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={LABEL_STYLE}>{label}</span>
      {children}
    </section>
  )
}

/** La marque d'état, jamais rendue sans sa ligne de preuve (cf. `Evidence`). */
export function StatusMark({ status }: { status: SpecStatus }) {
  const mark = MARK[status]
  return (
    <span
      style={{
        flexShrink: 0,
        font: '600 9.5px var(--font-mono)',
        letterSpacing: '0.12em',
        color: mark.color,
        whiteSpace: 'nowrap',
      }}
    >
      {mark.label}
    </span>
  )
}

/**
 * La preuve. Obligatoire partout : `built` donne l'adresse dans le code,
 * `spec` donne le mécanisme réellement en place à la place de celui décrit.
 */
export function Evidence({ status, children }: { status: SpecStatus; children: ReactNode }) {
  return (
    <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.65 }}>
      {EVIDENCE_PREFIX[status]}
      {children}
    </span>
  )
}

export interface SpecCardProps {
  status: SpecStatus
  title: string
  /** Sous-titre mono du pack (« partagé par tous les projets du globe »). */
  meta?: string
  /** Le texte de la spécification, tel que le pack le formule. */
  body: ReactNode
  /** Ce qui rend le bloc vrai, ou ce qui tient sa place aujourd'hui. */
  evidence: ReactNode
}

/** Une affirmation de la spec, avec son état et sa preuve. */
export function SpecCard({ status, title, meta, body, evidence }: SpecCardProps) {
  return (
    <div
      style={{
        borderRadius: 'var(--r-lg)',
        borderLeft: border(status),
        background: CARD_BG,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--text-hi)' }}>
          {title}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <StatusMark status={status} />
        </span>
      </div>
      {meta && (
        <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>{meta}</span>
      )}
      <span
        style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.65, textWrap: 'pretty' }}
      >
        {body}
      </span>
      <Evidence status={status}>{evidence}</Evidence>
    </div>
  )
}

export interface SpecRowProps {
  status: SpecStatus
  /** Colonne de gauche, mono : « rappel sémantique », « garant → dev ». */
  k: ReactNode
  v: ReactNode
  evidence: ReactNode
}

/** Ligne de tableau (Conscience 03, Protocole 02) : même contrat que la carte. */
export function SpecRow({ status, k, v, evidence }: SpecRowProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '210px 1fr auto',
        gap: 16,
        padding: '13px 2px 13px 12px',
        borderLeft: border(status),
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span
        style={{ font: '600 11.5px var(--font-mono)', color: 'var(--text-hi)', lineHeight: 1.5 }}
      >
        {k}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <span
          style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6, textWrap: 'pretty' }}
        >
          {v}
        </span>
        <Evidence status={status}>{evidence}</Evidence>
      </span>
      <StatusMark status={status} />
    </div>
  )
}

/**
 * Le compteur de tête. Il est **dérivé** des blocs réellement rendus par la
 * page, jamais écrit à la main : un bloc qu'on retire ou qu'on requalifie
 * déplace le chiffre tout seul. Un compteur recopié aurait vieilli comme le
 * « prévu en J12 » du dashboard.
 */
export function SpecScore({ statuses }: { statuses: readonly SpecStatus[] }) {
  const built = statuses.filter((s) => s === 'built').length
  const total = statuses.length

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 16px 14px 14px',
        borderLeft: '2px solid var(--sem-question)',
        borderRadius: 'var(--r-md)',
        background: CARD_BG,
      }}
    >
      <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--text-hi)' }}>
        {built} bloc{built > 1 ? 's' : ''} sur {total} tourne{built > 1 ? 'nt' : ''}{' '}
        aujourd&rsquo;hui.
      </span>
      <span
        style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.65, textWrap: 'pretty' }}
      >
        Cette page décrit une cible, pas un état. Chaque bloc porte sa marque et sa preuve :{' '}
        <span style={{ color: 'var(--ok)', font: '600 10.5px var(--font-mono)' }}>EN PLACE</span>{' '}
        est suivi du fichier ou de la table qui le rend vrai ;{' '}
        <span style={{ color: 'var(--text-low)', font: '600 10.5px var(--font-mono)' }}>
          NON CONSTRUIT
        </span>{' '}
        est suivi de ce qui se passe réellement à la place.
      </span>
      <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.65 }}>
        compté sur les blocs de cette page, jamais saisi à la main · liseré plein = construit,
        tireté = à construire
      </span>
    </div>
  )
}

/**
 * Un extrait d'interface reproduit depuis le pack pour illustrer une cible.
 *
 * Les prototypes rendent ces exemples avec de vraies pastilles d'action
 * (« Archiver tel quel », « Accorder · lecture seule »). Recopiées en React,
 * elles seraient des boutons qui ne font rien, sur une donnée qui n'existe
 * pas. La maquette est donc rendue **inerte et déclarée comme telle** : fond
 * rayé, mention « maquette », et les actions listées en texte mono plutôt
 * qu'en pastilles cliquables.
 */
export function Mockup({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 'var(--r-md)',
        border: '1px dashed var(--line-strong)',
        background:
          'repeating-linear-gradient(135deg, rgba(160, 180, 210, 0.045) 0 4px, transparent 4px 12px)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <span
        style={{
          font: '600 9.5px var(--font-mono)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-low)',
        }}
      >
        Maquette · {caption}
      </span>
      {children}
    </div>
  )
}

/** Les actions d'une maquette, en texte : jamais des pastilles cliquables. */
export function MockupActions({ actions }: { actions: readonly string[] }) {
  return (
    <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.65 }}>
      actions prévues · {actions.join(' / ')}
    </span>
  )
}

/**
 * L'en-tête d'une page de spec : titre et chapô.
 *
 * Le sur-titre mono du pack (« Spec design · conscience collective ») n'est
 * pas repris : `SectionHeader` le porte déjà en haut de l'écran, et le lire
 * deux fois à 30 px d'intervalle n'apprend rien.
 */
export function SpecHeader({ title, intro }: { title: string; intro: ReactNode }) {
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ margin: 0, fontSize: 27, fontWeight: 600, letterSpacing: '-0.01em' }}>
        {title}
      </h1>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          color: 'var(--text-mid)',
          lineHeight: 1.7,
          maxWidth: 620,
          textWrap: 'pretty',
        }}
      >
        {intro}
      </p>
    </header>
  )
}

/** Le corps scrollable commun aux deux pages (gabarit 880 px du pack). */
export function SpecBody({ children }: { children: ReactNode }) {
  return (
    <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px 116px' }}>
      <div
        style={{
          maxWidth: 880,
          display: 'flex',
          flexDirection: 'column',
          gap: 40,
        }}
      >
        {children}
      </div>
    </main>
  )
}
