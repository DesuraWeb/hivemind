import type { RoleTemplateView } from '../../lib/api'
import { TEAM_ROLES } from './script'

/** Rayon de l'orbite des chips autour de l'orbe (pack : `const R = 192`). */
const R = 192

/**
 * L'équipe en orbite autour de l'orbe (pack : stage 3 du script projet).
 *
 * Le prototype code en dur « Garant v3 · Dev v5 · Reviewer v2 · Juge v4 ·
 * Communicant v1 ». Ces versions existent pour de bon, dans
 * `role_templates` : elles viennent donc de `/api/role-templates`, version la
 * plus haute par rôle et `project_type` « generic » — exactement la ligne que
 * `resolveProjectRole` ira chercher (apps/server/src/loop/roles.ts). Un rôle
 * sans template installé n'est pas affiché avec un « v? » : il est absent.
 *
 * Ce que les chips ne disent pas : « voici l'équipe de votre projet ». La
 * création n'attache aucun rôle — `roles` se matérialise paresseusement au
 * premier run qui en a besoin. C'est la réplique du stage 3 qui le dit.
 */
export function TeamOrbit({
  revealed,
  templates,
}: {
  revealed: boolean
  templates: RoleTemplateView[]
}) {
  const members = TEAM_ROLES.flatMap((role) => {
    const version = templates
      .filter((t) => t.key === role.key && t.projectType === 'generic')
      .reduce<number | null>((max, t) => (max === null || t.version > max ? t.version : max), null)
    return version === null ? [] : [{ ...role, version }]
  })

  return (
    <>
      {members.map((m, i) => {
        const a = (m.angle * Math.PI) / 180
        const x = Math.cos(a) * R
        const y = Math.sin(a) * R
        return (
          <span
            key={m.key}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: `translate(-50%, -50%) translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) scale(${revealed ? 1 : 0.6})`,
              opacity: revealed ? 1 : 0,
              transition: 'transform 500ms var(--ease-out), opacity 500ms var(--ease)',
              transitionDelay: `${i * 100}ms`,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '5px 11px 5px 6px',
              borderRadius: 'var(--r-full)',
              background: 'var(--glass-bg)',
              backdropFilter: 'blur(12px) saturate(var(--glass-sat))',
              WebkitBackdropFilter: 'blur(12px) saturate(var(--glass-sat))',
              border: '1px solid var(--glass-border)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                background: `color-mix(in oklab, ${m.color} 16%, var(--bg-2))`,
                border: `1px solid color-mix(in oklab, ${m.color} 40%, transparent)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: '600 11.5px var(--font-sans)',
                color: m.color,
              }}
            >
              {m.label[0]}
            </span>
            <span style={{ font: '500 13px var(--font-sans)', color: 'var(--text-hi)' }}>
              {m.label}
            </span>
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              v{m.version}
            </span>
          </span>
        )
      })}
    </>
  )
}
