import { Link } from '@tanstack/react-router'
import type { ProjectView } from '../../lib/project-types'

/**
 * Panneau de verre du focus, version courte de l'intérieur de globe
 * (Projets.dc.html, `sc-if value="{{ focusedName }}"`) : teinte + nom + ×,
 * synthèse de Hive, une ligne de méta, deux boutons.
 *
 * Volontairement PAS partagé avec le panneau de focus du Dashboard (qui est
 * en cours d'écriture dans une autre session) : les deux n'affichent ni les
 * mêmes champs ni les mêmes actions, et un fichier commun se paierait
 * aujourd'hui en conflit pour une factorisation qui peut attendre.
 */
export function GlobeFocusPanel({
  project,
  globeId,
  onRelease,
}: {
  project: ProjectView
  globeId: string
  onRelease: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 14,
        top: 10,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 250,
        padding: '14px 16px',
        borderRadius: 'var(--r-lg)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-sat))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--shadow-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: project.tint ?? 'var(--pause)',
          }}
        />
        <span style={{ font: '600 14px var(--font-sans)' }}>{project.name}</span>
        <button
          type="button"
          onClick={onRelease}
          aria-label="Quitter le focus"
          style={{
            marginLeft: 'auto',
            width: 22,
            height: 22,
            borderRadius: 'var(--r-sm)',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-mid)',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* `synth` est la prose de Hive : absente tant que personne ne l'a écrite,
          on ne la remplace pas par une phrase inventée — la ligne disparaît. */}
      {project.synth && (
        <div style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.55 }}>
          {project.synth}
        </div>
      )}

      <div style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
        {project.line} · {project.conso}
      </div>

      <div style={{ display: 'flex', gap: 7, marginTop: 2 }}>
        <Link
          to="/globes/$globeId/$projectId"
          params={{ globeId, projectId: project.id }}
          style={{
            padding: '5px 13px',
            borderRadius: 'var(--r-full)',
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            font: '500 11.5px var(--font-sans)',
          }}
        >
          Ouvrir
        </Link>
        {project.staging && (
          <a
            href={project.staging}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '5px 13px',
              borderRadius: 'var(--r-full)',
              border: '1px solid var(--line-strong)',
              color: 'var(--text-mid)',
              font: '500 11.5px var(--font-sans)',
            }}
          >
            {project.staging.replace(/^https?:\/\//, '')} ↗
          </a>
        )}
      </div>
    </div>
  )
}
