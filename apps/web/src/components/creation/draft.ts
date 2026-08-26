import type { CreateProjectInput, CreateProjectStepInput } from '../../lib/api'

/**
 * Ce que la scène tient en main pendant la conversation, avant l'appel réseau.
 *
 * Un brouillon local, jamais dérivé de la mise en scène : les délais du script
 * découvrent des fragments, ils ne remplissent aucun champ. C'est aussi ce qui
 * fait qu'un échec de création ne perd rien — le brouillon survit à l'erreur,
 * seule la navigation en cas de succès le fait disparaître.
 */

export interface StepDraft {
  /** Clé de rendu stable : la position d'un step change quand on en retire un. */
  id: string
  title: string
  specs: string
  /** `true` = full-auto sur l'itération dev ↔ reviewer. La prod reste un gate. */
  auto: boolean
  iterations: number
}

export interface ProjectDraft {
  name: string
  /** Slug du globe d'accueil. */
  globe: string
  /** UUID d'une fiche client, ou vide. */
  clientId: string
  stack: string
  repoFullName: string
  stagingUrl: string
  /**
   * Le juge visuel capture-t-il ce projet ? Vrai par défaut · on le décoche
   * pour un projet sans interface (une API, une bibliothèque, un script), où
   * la boucle paierait un navigateur et un échange de modèle pour regarder une
   * page qui n'existe pas.
   */
  jugeVisuel: boolean
  /**
   * Où le projet démarre. Vide tant que personne ne l'a dit · le staging n'est
   * pas un passage obligé, et le supposer referait le chemin unique qu'on
   * corrige. Un site repris est DÉJÀ en ligne.
   */
  demarrage: '' | 'staging' | 'prod' | 'existant'
  /** Le domaine du projet. Requis quand on reprend un site : sinon on ne sait pas où il est. */
  domaine: string
  steps: StepDraft[]
}

export interface GlobeDraft {
  name: string
  color: string
}

/** Défaut serveur de `steps.max_iterations` (projects/create.ts). */
export const DEFAULT_ITERATIONS = 4

let seq = 0

export function emptyStep(): StepDraft {
  seq += 1
  return { id: `step-${seq}`, title: '', specs: '', auto: false, iterations: DEFAULT_ITERATIONS }
}

export function initialProjectDraft(globe: string): ProjectDraft {
  return {
    name: '',
    globe,
    clientId: '',
    stack: '',
    repoFullName: '',
    // Vrai par défaut : le juge est le seul contrôle qui regarde le RÉSULTAT
    // et non le code. Il ne doit pas disparaître par distraction.
    jugeVisuel: true,
    demarrage: '',
    domaine: '',
    stagingUrl: '',
    steps: [emptyStep(), emptyStep(), emptyStep()],
  }
}

/** Une ligne jamais touchée : ni titre, ni specs. Ignorée à l'envoi. */
export function isBlankStep(step: StepDraft): boolean {
  return step.title.trim() === '' && step.specs.trim() === ''
}

/**
 * Ce qui manque pour envoyer, dit en clair. On ne complète rien à la place de
 * l'utilisateur : un step à moitié rempli bloque l'envoi au lieu d'être jeté
 * en silence, sinon la scène annoncerait cinq steps et en enregistrerait trois.
 */
export function projectProblems(draft: ProjectDraft): string[] {
  const problems: string[] = []
  if (draft.name.trim() === '') problems.push('le nom du projet')
  if (draft.globe === '') problems.push("le globe d'accueil")
  if (!/^[\w.-]+\/[\w.-]+$/.test(draft.repoFullName.trim()))
    problems.push('un dépôt au format owner/nom')
  // Même exigence que côté serveur (`creation/fiche.ts::manquesFiche`) : on ne
  // défaute pas sur le staging, on demande.
  if (draft.demarrage === '') problems.push('où démarre le projet')
  else if (draft.demarrage === 'existant' && draft.domaine.trim() === '')
    problems.push('le domaine du site repris')
  draft.steps.forEach((step, i) => {
    if (isBlankStep(step)) return
    const num = String(i + 1).padStart(2, '0')
    if (step.title.trim() === '') problems.push(`l'intitulé du step ${num}`)
    if (step.specs.trim() === '') problems.push(`les specs du step ${num}`)
  })
  return problems
}

export function toCreateProjectInput(draft: ProjectDraft): CreateProjectInput {
  const steps: CreateProjectStepInput[] = draft.steps
    .filter((s) => !isBlankStep(s))
    .map((s) => ({
      title: s.title.trim(),
      specs: s.specs.trim(),
      autonomy: s.auto ? 'auto' : 'gated',
      maxIterations: s.iterations,
    }))
  const stack = draft.stack.trim()
  const staging = draft.stagingUrl.trim()
  // `exactOptionalPropertyTypes` : une clé optionnelle non renseignée doit être
  // ABSENTE du corps, jamais présente et valant `undefined` (le serveur
  // distingue les deux : `z.string().max(120).optional()` refuse `undefined`
  // explicite en JSON… et surtout `JSON.stringify` le supprimerait sans le dire).
  return {
    globe: draft.globe,
    name: draft.name.trim(),
    repoFullName: draft.repoFullName.trim(),
    ...(draft.clientId !== '' ? { clientId: draft.clientId } : {}),
    ...(stack !== '' ? { stack } : {}),
    // Envoyé seulement quand il diffère du défaut serveur : un corps qui
    // répète le défaut le fige, et le défaut est le seul endroit où on veut
    // pouvoir changer d'avis pour tous les projets à venir.
    ...(draft.jugeVisuel ? {} : { jugeVisuel: false }),
    ...(draft.demarrage !== '' ? { demarrage: draft.demarrage } : {}),
    ...(draft.domaine.trim() !== '' ? { domaine: draft.domaine.trim() } : {}),
    ...(staging !== '' ? { stagingUrl: staging } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  }
}
