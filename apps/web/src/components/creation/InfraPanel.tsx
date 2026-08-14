import type { CSSProperties } from 'react'
import type { ProjectDraft } from './draft'
import { FRAGMENT_LABEL, MONO_ROW } from './kit'

const KEY_CELL: CSSProperties = { width: 128, color: 'var(--text-low)', flexShrink: 0 }

const NOTE_CELL: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--text-low)',
  whiteSpace: 'nowrap',
}

const INLINE_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--line)',
  padding: '2px 0',
  font: '12px var(--font-mono)',
  color: 'var(--text-hi)',
  outline: 'none',
}

/**
 * Fragment « Infra & accès » (pack : bas-gauche en mode projet, stage 4).
 *
 * ## C'est ici que le prototype ment, et c'est ici qu'on arrête
 *
 * Il affiche « repo GitHub · desura/riviera-pool · **créé par Hive ✓** » et
 * « staging · stg.rivierapool.fr · **créé par Hive ✓** », puis un bouton
 * « Fournir » pour l'accès SSH qui bascule la ligne en « reçu · coffre ✓ ».
 *
 * Rien de tout cela n'existe : `POST /api/projects` écrit un projet et ses
 * steps dans une transaction, un point c'est tout (le serveur le dit lui-même
 * en tête de `projects/create.ts`). Aucune création de dépôt, aucun
 * provisioning de staging, et aucune route ne dépose quoi que ce soit dans le
 * coffre. Un « ✓ créé par Hive » sur un dépôt qui n'existe pas est la même
 * faute que le zéro rassurant qu'on vient de retirer du panneau budget : un
 * état affirmé que le système n'a pas.
 *
 * Les quatre lignes du pack restent, à leur place et dans leur géométrie, mais
 * elles changent de nature :
 *
 * - **dépôt** et **staging** deviennent des champs de saisie. Ce sont des
 *   valeurs que le serveur enregistre (`repoFullName`, `stagingUrl`) : le
 *   dépôt doit exister avant, c'est écrit dans la colonne de droite.
 * - **hébergeur (SSH)** perd son bouton « Fournir ». Le coffre n'est branché à
 *   aucune route ici ; un bouton qui invite à saisir un accès pour le ranger
 *   nulle part est pire qu'un mensonge d'affichage. La ligne reste, pour dire
 *   que l'accès sera nécessaire et où il ne se dépose pas encore.
 * - **DNS** ne prétendait rien et ne change pas.
 */
export function InfraPanel({
  style,
  draft,
  onPatch,
}: {
  style: CSSProperties
  draft: ProjectDraft
  onPatch: (patch: Partial<ProjectDraft>) => void
}) {
  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={FRAGMENT_LABEL}>Infra &amp; accès · à fournir</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={MONO_ROW}>
          <span style={KEY_CELL}>dépôt GitHub</span>
          <input
            className="creation-field"
            value={draft.repoFullName}
            onChange={(e) => onPatch({ repoFullName: e.target.value })}
            placeholder="desura/riviera-pool"
            aria-label="Dépôt GitHub du projet"
            style={INLINE_INPUT}
          />
          <span style={NOTE_CELL}>doit exister</span>
        </div>
        <div style={MONO_ROW}>
          <span style={KEY_CELL}>staging</span>
          <input
            className="creation-field"
            value={draft.stagingUrl}
            onChange={(e) => onPatch({ stagingUrl: e.target.value })}
            placeholder="stg.rivierapool.fr"
            aria-label="URL de staging"
            style={INLINE_INPUT}
          />
          <span style={NOTE_CELL}>non provisionné</span>
        </div>
        <div style={MONO_ROW}>
          <span style={KEY_CELL}>hébergeur (SSH)</span>
          <span style={{ whiteSpace: 'nowrap' }}>requis à la mise en prod</span>
        </div>
        <div style={MONO_ROW}>
          <span style={KEY_CELL}>DNS</span>
          <span style={{ whiteSpace: 'nowrap' }}>à la mise en prod</span>
          <span style={NOTE_CELL}>non bloquant</span>
        </div>
      </div>
      <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.6 }}>
        aucun accès ne se dépose ici · le coffre n'est pas branché à cet écran
      </span>
    </div>
  )
}

/** Fragment « Ce que Hive prépare » (pack : bas-gauche en mode globe). */
export function GlobePrepPanel({ style }: { style: CSSProperties }) {
  return (
    <div style={{ ...style, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={FRAGMENT_LABEL}>Ce que la création fait</span>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          font: '12px var(--font-mono)',
          color: 'var(--text-mid)',
        }}
      >
        <span>un globe de plus · sa teinte, son orbite, ses projets à venir</span>
        <span style={{ color: 'var(--text-low)' }}>
          la conscience commence vide · elle grossira au fil des runs
        </span>
      </div>
    </div>
  )
}
