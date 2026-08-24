import { CtxLine, PanelActions, PanelButton, SectionLabel } from '../PanelKit'
import type { PanelProps } from './types'

interface Etape {
  resume: string
  commande: string
  sauvegarde: string | null
  inverse: string | null
  raison: string | null
}

function lireEtapes(payload: Record<string, unknown>): Etape[] {
  const brut = payload.etapes
  if (!Array.isArray(brut)) return []
  return brut.flatMap((e): Etape[] => {
    if (typeof e !== 'object' || e === null) return []
    const o = e as Record<string, unknown>
    if (typeof o.resume !== 'string' || typeof o.commande !== 'string') return []
    return [
      {
        resume: o.resume,
        commande: o.commande,
        sauvegarde: typeof o.sauvegarde === 'string' ? o.sauvegarde : null,
        inverse: typeof o.inverse === 'string' ? o.inverse : null,
        raison: typeof o.raison === 'string' ? o.raison : null,
      },
    ]
  })
}

function lireListe(valeur: unknown): string[] {
  return Array.isArray(valeur) ? valeur.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Panneau « approval · ops » : un changement sur un serveur.
 *
 * Tout l'intérêt pour Florian est de pouvoir décider **sans ouvrir un
 * terminal**. Le panneau porte donc la commande EXACTE de chaque opération —
 * celle qui s'exécutera, octet pour octet, vérifiée par empreinte au moment de
 * l'exécution — sa sauvegarde et son retour arrière.
 *
 * Ce qui NE SE DÉFAIT PAS est affiché en premier et en rouge. C'est la seule
 * information dont l'absence rendrait la décision impossible à prendre
 * honnêtement : approuver un `apt-get install` et approuver une écriture de
 * fichier sauvegardée ne sont pas le même geste.
 *
 * Le refus est possible, contrairement au panneau de mise en prod : un
 * changement serveur n'a rien de l'évidence d'un déploiement validé par un
 * verdict conforme. Refuser ne défait rien — il n'y avait rien de fait.
 */
export function OpsApprovalPanel({ item, resolving, onResolve }: PanelProps) {
  const etapes = lireEtapes(item.payload)
  const irreversibles = lireListe(item.payload.irreversibles)
  const constate = lireListe(item.payload.constate)
  const suppose = lireListe(item.payload.suppose)
  const cause = typeof item.payload.cause === 'string' ? item.payload.cause : null
  const serveur = item.payload.serveur as { nom?: string; hote?: string; etat?: string } | undefined

  return (
    <>
      {cause && <CtxLine>{cause}</CtxLine>}

      {serveur?.nom && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            font: '11.5px var(--font-mono)',
            color: 'var(--text-mid)',
          }}
        >
          <span style={{ color: 'var(--text-hi)', fontWeight: 600 }}>{serveur.nom}</span>
          {serveur.hote && <span>{serveur.hote}</span>}
          {serveur.etat && <span>· {serveur.etat.replace('_', ' ')}</span>}
        </div>
      )}

      {irreversibles.length > 0 && (
        <div
          style={{
            border: '1px solid color-mix(in oklab, var(--sem-alert) 30%, transparent)',
            borderLeft: '3px solid var(--sem-alert)',
            borderRadius: 'var(--r-md)',
            background: 'color-mix(in oklab, var(--sem-alert) 6%, transparent)',
            padding: '11px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <span
            style={{
              font: '600 10px var(--font-sans)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--sem-alert)',
            }}
          >
            Ne se défait pas
          </span>
          {irreversibles.map((r) => (
            <span key={r} style={{ fontSize: 13, color: 'var(--text-hi)' }}>
              {r}
            </span>
          ))}
        </div>
      )}

      {(constate.length > 0 || suppose.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Constaté et supposé restent SÉPARÉS : un plan qui présente une
              supposition comme un constat fait décider sur du vent. */}
          {constate.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <SectionLabel>Constaté</SectionLabel>
              {constate.map((c) => (
                <span key={c} style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.55 }}>
                  {c}
                </span>
              ))}
            </div>
          )}
          {suppose.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <SectionLabel>Supposé</SectionLabel>
              {suppose.map((s) => (
                <span key={s} style={{ fontSize: 13, color: 'var(--text-low)', lineHeight: 1.55 }}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionLabel>
          {etapes.length} opération{etapes.length > 1 ? 's' : ''} · dans cet ordre
        </SectionLabel>
        {etapes.map((e, i) => (
          <div
            key={e.commande}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
                {i + 1}
              </span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{e.resume}</span>
            </div>
            {e.raison && (
              <span style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.55 }}>
                {e.raison}
              </span>
            )}
            {/* La commande exacte. C'est elle qui partira, vérifiée par
                empreinte : ce qui est montré ici est ce qui s'exécute. */}
            <pre
              style={{
                margin: 0,
                padding: '8px 10px',
                borderRadius: 'var(--r-sm, 6px)',
                background: 'var(--bg-0)',
                font: '11px var(--font-mono)',
                color: 'var(--text-mid)',
                overflowX: 'auto',
                whiteSpace: 'pre',
                lineHeight: 1.6,
              }}
            >
              {e.commande}
            </pre>
            <span style={{ font: '10.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {e.sauvegarde ? `sauvegarde · ${e.sauvegarde}` : 'aucune sauvegarde nécessaire'}
              {' · '}
              {e.inverse ? `retour arrière · ${e.inverse}` : 'AUCUN retour arrière'}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Décision</SectionLabel>
        <PanelActions>
          <PanelButton
            variant="primary"
            disabled={resolving}
            onClick={() => onResolve({ approved: true })}
          >
            Approuver · Silithid applique
          </PanelButton>
          <PanelButton
            variant="secondary"
            disabled={resolving}
            onClick={() => onResolve({ approved: false })}
          >
            Refuser
          </PanelButton>
        </PanelActions>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          l&rsquo;exécution s&rsquo;arrête à la première opération qui échoue · rien de ce qui suit
          n&rsquo;est tenté
        </span>
      </div>
    </>
  )
}
