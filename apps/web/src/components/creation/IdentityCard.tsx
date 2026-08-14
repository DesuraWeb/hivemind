import type { CSSProperties } from 'react'
import type { ClientSummary, GlobeView } from '../../lib/api'
import type { GlobeDraft, ProjectDraft } from './draft'
import { FRAGMENT_LABEL, Field, GLASS_CARD, UNDERLINE_INPUT } from './kit'
import { GLOBE_TINTS } from './script'

const NAME_INPUT: CSSProperties = { ...UNDERLINE_INPUT, font: '600 17px var(--font-sans)' }

const SELECT: CSSProperties = { ...UNDERLINE_INPUT, colorScheme: 'dark', cursor: 'pointer' }

/**
 * Fragment « Identité » (pack : colonne de gauche, apparaît au stage 1).
 *
 * Tous les champs sont vides au départ et modifiables à tout moment : la mise
 * en scène découvre la fiche, elle ne la remplit pas. Les valeurs du prototype
 * (« Riviera Pool », « PrestaShop 8 ») survivent en placeholders — un exemple
 * qu'on voit être un exemple, jamais une valeur qu'on croirait saisie.
 *
 * Écarts assumés avec le pack, tous dictés par ce que le serveur sait garder :
 * le « Client » est un menu des fiches existantes (`POST /api/projects` attend
 * un UUID de fiche, pas un nom libre) ; « Dans le globe Desura » est un menu
 * plutôt qu'une case (le globe d'accueil est obligatoire et il y en a
 * plusieurs) ; la « Portée » du globe est retirée (`POST /api/globes` ne
 * connaît que `name` et `color` — un champ qui semble enregistré sans l'être
 * serait exactement le genre de mensonge qu'on retire de cet écran).
 */
export function IdentityCard({
  style,
  mode,
  project,
  globe,
  globes,
  clients,
  onProject,
  onGlobe,
}: {
  style: CSSProperties
  mode: 'projet' | 'globe'
  project: ProjectDraft
  globe: GlobeDraft
  globes: GlobeView[]
  clients: ClientSummary[]
  onProject: (patch: Partial<ProjectDraft>) => void
  onGlobe: (patch: Partial<GlobeDraft>) => void
}) {
  return (
    <div
      style={{
        ...GLASS_CARD,
        ...style,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 13,
      }}
    >
      <span style={FRAGMENT_LABEL}>Identité</span>

      {mode === 'projet' ? (
        <>
          <Field id="creation-nom" label="Nom">
            <input
              id="creation-nom"
              className="creation-field"
              value={project.name}
              onChange={(e) => onProject({ name: e.target.value })}
              placeholder="Riviera Pool"
              style={NAME_INPUT}
            />
          </Field>
          <Field id="creation-client" label="Client · facultatif">
            <select
              id="creation-client"
              className="creation-field"
              value={project.clientId}
              onChange={(e) => onProject({ clientId: e.target.value })}
              style={SELECT}
            >
              <option value="">aucune fiche client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="creation-stack" label="Stack · facultatif">
            <input
              id="creation-stack"
              className="creation-field"
              value={project.stack}
              onChange={(e) => onProject({ stack: e.target.value })}
              placeholder="PrestaShop 8 · catalogue sans tunnel de paiement"
              style={{
                ...UNDERLINE_INPUT,
                borderBottom: 'none',
                font: '500 13px var(--font-mono)',
                color: 'var(--text-mid)',
              }}
            />
          </Field>
          <Field id="creation-globe" label="Globe d'accueil">
            <select
              id="creation-globe"
              className="creation-field"
              value={project.globe}
              onChange={(e) => onProject({ globe: e.target.value })}
              style={SELECT}
            >
              {globes.length === 0 && <option value="">aucun globe · créez-en un d'abord</option>}
              {globes.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field id="creation-globe-nom" label="Nom du globe">
            <input
              id="creation-globe-nom"
              className="creation-field"
              value={globe.name}
              onChange={(e) => onGlobe({ name: e.target.value })}
              placeholder="Assos"
              style={NAME_INPUT}
            />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span
              style={{
                font: '10.5px var(--font-mono)',
                color: 'var(--text-low)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              Teinte des particules
            </span>
            <div style={{ display: 'flex', gap: 10 }}>
              {GLOBE_TINTS.map((tint) => {
                const picked = globe.color === tint
                return (
                  <button
                    key={tint}
                    type="button"
                    aria-label={`Teinte ${tint}`}
                    aria-pressed={picked}
                    onClick={() => onGlobe({ color: tint })}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      background: tint,
                      border: `2px solid ${picked ? `color-mix(in oklab, ${tint} 70%, white)` : 'transparent'}`,
                      cursor: 'pointer',
                      boxShadow: picked
                        ? `0 0 12px color-mix(in oklab, ${tint} 45%, transparent)`
                        : 'none',
                    }}
                  />
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
