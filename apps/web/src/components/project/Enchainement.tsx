import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { ProjectView } from '../../lib/project-types'

/**
 * Enchaîner les steps sans intervention entre chacun.
 *
 * ## Ce que ça retire, et ce que ça ne touche pas
 *
 * Un run s'arrêtait quand son step était validé, et rien ne lançait le
 * suivant : il fallait cliquer sur chaque step. Ça retire ce clic, et RIEN
 * d'autre.
 *
 * Les gates tiennent : un step en régime `gated` lève une approbation en fin
 * de step, donc le run n'atteint pas son terme et la chaîne attend. Un step
 * qui échoue l'arrête aussi — on ne relance jamais après une panne, il y a
 * quelque chose à regarder.
 *
 * ## Pourquoi l'avertissement est là et pas dans une note de bas de page
 *
 * Une chaîne dépense sans personne devant l'écran, et la mise en pause
 * automatique sur budget **ne fonctionne pas** aujourd'hui
 * (`docs/ecarts.md`). Le dire au moment où l'on coche est la seule place où
 * ça sert : dans une documentation, personne ne le lit avant de cocher.
 */
export function Enchainement({ projet }: { projet: ProjectView }) {
  const queryClient = useQueryClient()

  const basculer = useMutation({
    mutationFn: (enchainement: boolean) => api.projects.patch(projet.id, { enchainement }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projet.id] }),
  })

  const actif = projet.enchainement

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 14px',
        marginBottom: 12,
        borderRadius: 'var(--r-md)',
        border: `1px solid ${actif ? 'var(--accent)' : 'var(--line)'}`,
        background: actif ? 'color-mix(in oklab, var(--accent) 7%, transparent)' : 'transparent',
      }}
    >
      <input
        type="checkbox"
        id="enchainement"
        checked={actif}
        disabled={basculer.isPending}
        onChange={(e) => basculer.mutate(e.target.checked)}
        style={{ marginTop: 2, accentColor: 'var(--accent)' }}
      />
      <label htmlFor="enchainement" style={{ display: 'grid', gap: 4, cursor: 'pointer' }}>
        <span style={{ font: '600 13px var(--font-sans)', color: 'var(--text-hi)' }}>
          Enchaîner les steps
        </span>
        <span
          style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.65 }}
        >
          Quand un step est validé, le suivant démarre seul. Les gates tiennent · un step en
          validation humaine fait attendre la chaîne, et un step en échec l'arrête.
        </span>
        {actif && (
          <span
            style={{ font: '11.5px var(--font-mono)', color: 'var(--sem-alert)', lineHeight: 1.65 }}
          >
            La chaîne dépense sans personne devant l'écran, et la mise en pause automatique sur
            budget ne fonctionne pas aujourd'hui · surveillez la consommation.
          </span>
        )}
      </label>
    </div>
  )
}
