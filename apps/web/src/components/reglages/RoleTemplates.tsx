import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Note, Panel } from './Panel'

/**
 * Libellé et couleur d'un rôle, comme partout ailleurs dans l'app
 * (creation/script.ts, Journal) : `majordome` s'affiche « Hive » et `judge`
 * s'affiche « Juge ». Un rôle inconnu garde sa clé brute et la couleur neutre.
 */
const ROLES: Record<string, { label: string; color: string }> = {
  majordome: { label: 'Hive', color: 'var(--accent)' },
  garant: { label: 'Garant', color: 'oklch(0.82 0.06 235)' },
  dev: { label: 'Dev', color: 'var(--accent)' },
  reviewer: { label: 'Reviewer', color: 'var(--sem-question)' },
  judge: { label: 'Juge', color: 'var(--sem-verdict)' },
  communicant: { label: 'Communicant', color: 'var(--ok)' },
}

/**
 * Les templates de rôles (`Reglages.dc.html`, bloc « Templates de rôles ·
 * versionnés »).
 *
 * Deux écarts avec le pack, tous deux du côté de ce qui n'existe pas :
 *
 * - le prototype affiche « modifié le 2 août » sur chaque ligne. La table
 *   `role_templates` n'a **aucune colonne d'horodatage** : le serveur rend
 *   `modifiedAt: null`, et l'écran ne remplace pas cette date par celle du
 *   jour. L'absence est dite une fois, en bas du bloc ;
 * - « + Nouveau template », « Historique » et « Éditer » n'ont aucune route
 *   d'écriture derrière eux : ils sont absents. Les prompts se posent par
 *   `pnpm db:seed`, depuis `apps/server/src/db/seeds/role_templates/`.
 */
export function RoleTemplates() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['role-templates'],
    queryFn: api.roleTemplates.list,
  })

  const rows = data ?? []

  return (
    <Panel label="Templates de rôles · versionnés">
      {isPending && <Note>lecture des templates…</Note>}
      {isError && <Note>templates injoignables · réessai automatique</Note>}
      {!isPending && !isError && rows.length === 0 && (
        <Note>
          aucun template en base · `pnpm db:seed` pose les six rôles depuis les prompts du dépôt
        </Note>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((t, i) => {
          const role = ROLES[t.key] ?? { label: t.key, color: 'var(--pause)' }
          return (
            <div
              key={`${t.key}-${t.projectType}-${t.version}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                padding: '9px 0',
                borderBottom: `1px solid ${i === rows.length - 1 ? 'transparent' : 'var(--line)'}`,
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  borderRadius: 999,
                  background: `color-mix(in oklab, ${role.color} 16%, var(--bg-2))`,
                  border: `1px solid color-mix(in oklab, ${role.color} 40%, transparent)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  font: '600 11px var(--font-sans)',
                  color: role.color,
                }}
              >
                {role.label.slice(0, 1)}
              </span>
              <span style={{ font: '500 13px var(--font-sans)', width: 110 }}>{role.label}</span>
              <span
                style={{
                  font: '10.5px var(--font-mono)',
                  color: 'var(--accent)',
                  border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
                  borderRadius: 'var(--r-full)',
                  padding: '1px 8px',
                }}
              >
                v{t.version}
              </span>
              <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
                type {t.projectType} · {t.usedByProjects} projet
                {t.usedByProjects > 1 ? 's' : ''} ·{' '}
                {t.model ? `modèle ${t.model}` : 'modèle du runtime'}
              </span>
            </div>
          )
        })}
      </div>

      <Note>
        la table n&rsquo;a aucune colonne d&rsquo;horodatage : la date de dernière modification
        n&rsquo;existe pas, elle n&rsquo;est donc pas affichée · aucune route ne modifie un
        template, ils se posent par `pnpm db:seed`
      </Note>
    </Panel>
  )
}
