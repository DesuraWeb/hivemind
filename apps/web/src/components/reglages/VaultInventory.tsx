import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Note, Panel } from './Panel'

/**
 * Le coffre (`Reglages.dc.html`, bloc « Coffre · secrets & accès »).
 *
 * Le pack affiche pour chaque entrée sa portée (client / projet / globe), les
 * rôles qui peuvent la lire, la date du dernier accès et une rotation
 * automatique à 90 jours, plus un bouton « Roter ». **Rien de tout cela
 * n'existe** : `settings` est une table de clés plates à valeur scellée, sans
 * portée, sans journal d'accès, sans rotation — et aucune route ne fait
 * tourner une clé.
 *
 * Ces colonnes ne sont donc pas rendues vides : elles sont absentes, et leur
 * absence est écrite. « lisible par : personne » se lirait comme une
 * permission, là où la vérité est « on ne sait pas ».
 */
export function VaultInventory() {
  const { data, isPending, isError } = useQuery({ queryKey: ['vault'], queryFn: api.vault.list })
  const entries = data ?? []

  return (
    <Panel label="Coffre · inventaire">
      {isPending && <Note>lecture de l&rsquo;inventaire…</Note>}
      {isError && <Note>coffre injoignable · réessai automatique</Note>}

      {!isPending && !isError && entries.length === 0 && (
        <Note>
          aucun secret scellé pour l&rsquo;instant · les intégrations qui en attendent (Gmail, clé
          SSH de staging) tournent en mode dégradé tant que rien n&rsquo;est déposé
        </Note>
      )}

      {entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {entries.map((entry, i) => (
            <div
              key={entry.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 2px',
                borderBottom: `1px solid ${
                  i === entries.length - 1 ? 'transparent' : 'var(--line)'
                }`,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                  borderRadius: 999,
                  background: 'var(--ok)',
                }}
              />
              <span style={{ font: '12px var(--font-mono)', color: 'var(--text-hi)' }}>
                {entry.key}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  font: '11px var(--font-mono)',
                  color: 'var(--text-low)',
                  whiteSpace: 'nowrap',
                }}
              >
                scellé
              </span>
            </div>
          ))}
        </div>
      )}

      <Note>
        inventaire seul : l&rsquo;API ne rend que des noms de clés, aucune valeur ne transite ni ne
        s&rsquo;affiche · les agents reçoivent la valeur au moment de l&rsquo;usage, jamais
        l&rsquo;écran
      </Note>
      <Note>
        portée, rôles autorisés, dernier accès et rotation ne sont pas modélisés · rien ne les
        affiche à zéro en attendant, et aucun bouton ne fait tourner une clé
      </Note>
    </Panel>
  )
}
