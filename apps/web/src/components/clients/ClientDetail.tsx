import { Link } from '@tanstack/react-router'
import { type ReactNode, useMemo, useState } from 'react'
import type { ClientView } from '../../lib/api'
import { count, initials, knowledgeMeta } from './format'

/** Label mono petites caps, comme `SectionHeader` mais à l'intérieur du contenu. */
function Label({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        font: '600 10.5px var(--font-mono)',
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--text-mid)',
      }}
    >
      {children}
    </span>
  )
}

/** Carte d'info sans bordure (axe 2 de CLAUDE.md : « cartes info sans bordures »). */
function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 'var(--r-lg)',
        background: 'rgba(13, 20, 32, 0.55)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <Label>{label}</Label>
      {children}
    </div>
  )
}

const MONO_LINES = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  font: '12px var(--font-mono)',
  color: 'var(--text-mid)',
} as const

/** Ce qui n'est pas renseigné le dit, à sa place, plutôt que de laisser un blanc. */
function Missing({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>{children}</span>
  )
}

/** Un projet rattaché : pastille neutre (la teinte vit sur la fiche projet) et nom. */
function ProjectLine({ name }: { name: string }) {
  return (
    <>
      <span
        style={{
          width: 7,
          height: 7,
          flexShrink: 0,
          borderRadius: 999,
          background: 'var(--text-low)',
        }}
      />
      <span style={{ font: '500 13px var(--font-sans)' }}>{name}</span>
    </>
  )
}

/**
 * La fiche d'un client (`Clients.dc.html`, colonne de droite).
 *
 * Trois gestes du prototype sont absents ici, et c'est délibéré : « Éditer la
 * fiche », « Réviser » et « Révoquer » n'ont aucune route d'écriture derrière
 * eux. Un bouton grisé sans explication laisserait croire à une permission
 * manquante ; ils sont donc retirés, et ce qui les remplacerait est écrit en
 * toutes lettres sous la base de connaissances.
 */
export function ClientDetail({
  client,
  projectGlobes,
}: {
  client: ClientView
  /** slug de projet → slug de globe, pour lier vers la fiche projet quand elle est atteignable. */
  projectGlobes: Map<string, string>
}) {
  const [search, setSearch] = useState('')

  const knowledge = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return client.knowledge
    return client.knowledge.filter(
      (k) => k.question.toLowerCase().includes(q) || k.answer.toLowerCase().includes(q),
    )
  }, [client.knowledge, search])

  const firstContact = client.contacts.find((c) => c.name || c.role || c.email || c.phone) ?? null
  const subtitle = firstContact
    ? [firstContact.name, firstContact.role].filter(Boolean).join(' · ')
    : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: 'var(--bg-2)',
            border: '1px solid var(--line-strong)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: '600 14px var(--font-sans)',
            color: 'var(--text-mid)',
          }}
        >
          {initials(client.name)}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>{client.name}</span>
          {subtitle ? (
            <span style={{ font: '11.5px var(--font-mono)', color: 'var(--text-low)' }}>
              {subtitle}
            </span>
          ) : (
            <Missing>aucun contact nommé sur cette fiche</Missing>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0 4px' }}>
        <Label>Base de connaissances</Label>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span
            style={{
              font: '600 46px var(--font-sans)',
              letterSpacing: '-0.02em',
              lineHeight: 1,
              color: 'var(--text-hi)',
            }}
          >
            {client.knowledge.length}
          </span>
          {/* Le pack ajoute ici « 2 questions évitées ce mois-ci ». Rien ne
              compte les questions qu'un savoir a évitées : la mention est
              absente plutôt que rendue à zéro. */}
          <span style={{ fontSize: 13.5, color: 'var(--text-mid)' }}>
            {client.knowledge.length > 1 ? 'réponses archivées' : 'réponse archivée'}
          </span>
          {client.knowledge.length > 0 && (
            <input
              type="search"
              className="clients-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une réponse…"
              style={{
                marginLeft: 'auto',
                width: 220,
                background: 'rgba(9, 14, 22, 0.6)',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-full)',
                padding: '8px 14px',
                font: '400 12.5px var(--font-sans)',
                color: 'var(--text-hi)',
                outline: 'none',
              }}
            />
          )}
        </div>
        <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
          chaque question résolue dans l&rsquo;inbox et archivée sur le client enrichit cette fiche
          · ni version, ni score de rappel : ce que les agents en font n&rsquo;est pas mesuré
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
          {knowledge.map((k) => (
            <div
              key={`${k.sourceItemId ?? 'sans-source'}-${k.at ?? ''}-${k.question}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                padding: '13px 2px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    flexShrink: 0,
                    borderRadius: 999,
                    background: 'var(--sem-question)',
                  }}
                />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-hi)' }}>
                  {k.question}
                </span>
                <span
                  title={k.sourceItemId ?? undefined}
                  style={{
                    marginLeft: 'auto',
                    font: '10.5px var(--font-mono)',
                    color: 'var(--text-low)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {knowledgeMeta(k)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--text-mid)',
                  lineHeight: 1.6,
                  paddingLeft: 15,
                  textWrap: 'pretty',
                }}
              >
                {k.answer}
              </div>
            </div>
          ))}

          {knowledge.length === 0 && (
            <div
              style={{
                padding: '12px 2px',
                font: '11.5px var(--font-mono)',
                color: 'var(--text-low)',
                lineHeight: 1.8,
              }}
            >
              {client.knowledge.length === 0 ? (
                <>
                  aucune réponse archivée
                  <br />
                  une question résolue dans l&rsquo;inbox, marquée « à archiver », viendra se poser
                  ici
                </>
              ) : (
                <>aucune réponse ne correspond à cette recherche</>
              )}
            </div>
          )}
        </div>

        {client.knowledge.length > 0 && (
          <span
            style={{
              font: '11px var(--font-mono)',
              color: 'var(--text-low)',
              lineHeight: 1.8,
              marginTop: 4,
            }}
          >
            aucune route d&rsquo;écriture : un savoir ne se révise ni ne se révoque depuis cet écran
            · il se corrige en répondant à nouveau dans l&rsquo;inbox, ce qui ajoute une entrée
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card label="Coordonnées">
          <div style={MONO_LINES}>
            {client.contacts.length === 0 && <Missing>aucun contact enregistré</Missing>}
            {client.contacts.map((c, i) => {
              const identity = [c.name, c.role].filter(Boolean).join(' · ')
              return (
                <span
                  // Les contacts sont du jsonb libre : rien ne garantit un
                  // identifiant, ni même un nom. L'index est le seul repère
                  // stable d'une ligne à l'autre.
                  // biome-ignore lint/suspicious/noArrayIndexKey: aucune clé naturelle côté données
                  key={`contact-${i}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  {identity && <span>{identity}</span>}
                  {c.email && <span>{c.email}</span>}
                  {c.phone && <span>{c.phone}</span>}
                </span>
              )
            })}
            {client.siret ? (
              <span>SIRET {client.siret}</span>
            ) : (
              <Missing>SIRET non renseigné</Missing>
            )}
          </div>
        </Card>

        <Card label="Accès">
          <div style={MONO_LINES}>
            {client.accessKeys.length === 0 ? (
              <Missing>aucun accès enregistré sur cette fiche</Missing>
            ) : (
              client.accessKeys.map((key) => (
                <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 5,
                      height: 5,
                      flexShrink: 0,
                      borderRadius: 999,
                      background: 'var(--text-low)',
                    }}
                  />
                  {key}
                </span>
              ))
            )}
          </div>
          {/* La section liste ce qui existe, elle ne le révèle pas : aucune
              valeur de secret ne sort de l'API, donc aucun geste ici ne peut
              en afficher une. Le dire évite de le chercher. */}
          <span
            style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.7 }}
          >
            noms des accès détenus dans le coffre · aucune valeur ne sort de l&rsquo;API, rien ne se
            lit depuis cet écran
          </span>
        </Card>

        <Card label="Ton de communication">
          {client.tone ? (
            <span style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
              {client.tone}
            </span>
          ) : (
            <Missing>ton non renseigné · les agents n&rsquo;en reçoivent aucun</Missing>
          )}
          <span
            style={{ font: '11px var(--font-mono)', color: 'var(--text-low)', lineHeight: 1.7 }}
          >
            {client.tone
              ? 'transmis aux agents dans le cadrage de chaque step, avec les cinq derniers savoirs'
              : 'le cadrage des steps n’en dira rien tant que la fiche est vide'}
          </span>
        </Card>

        <Card label="Projets liés">
          {client.projects.length === 0 ? (
            <Missing>aucun projet rattaché à ce client</Missing>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {client.projects.map((p) => {
                const globe = projectGlobes.get(p.id)
                return globe ? (
                  <Link
                    key={p.id}
                    to="/globes/$globeId/$projectId"
                    params={{ globeId: globe, projectId: p.id }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      color: 'var(--text-hi)',
                    }}
                  >
                    <ProjectLine name={p.name} />
                  </Link>
                ) : (
                  // Le globe d'accueil n'est pas dans la fiche client : sans
                  // lui, la route projet n'est pas constructible. On rend le
                  // nom sans lien plutôt qu'un lien qui tomberait à côté.
                  <span
                    key={p.id}
                    title="globe inconnu depuis cette fiche : la fiche projet n’est pas atteignable d’ici"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      color: 'var(--text-mid)',
                    }}
                  >
                    <ProjectLine name={p.name} />
                  </span>
                )
              })}
            </div>
          )}
          {client.projects.length > 0 && (
            <span style={{ font: '11px var(--font-mono)', color: 'var(--text-low)' }}>
              {count(client.projects.length, 'projet rattaché', 'projets rattachés')} · l&rsquo;état
              de chacun se lit sur sa fiche
            </span>
          )}
        </Card>
      </div>
    </div>
  )
}
