import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * La voix : parler à un agent, et l'entendre répondre.
 *
 * Pas une liseuse d'écran — une capacité de CONVERSATION. On appuie, on parle,
 * ça s'écrit ; l'agent répond, ça se dit à voix haute. C'est ce qui permet de
 * travailler sans avoir les yeux rivés sur l'écran.
 *
 * ## Zéro dépendance, et la reconnaissance ne sort pas de la machine
 *
 * Les deux moitiés sont natives au navigateur. `speechSynthesis` utilise les
 * voix du système, hors ligne. `SpeechRecognition` a gagné le mode local :
 * `processLocally`, plus `available()` et `install()` pour le pack de langue.
 *
 * **Par défaut, Chrome envoie l'audio à un serveur.** `processLocally` n'est
 * donc pas un confort, c'est la condition : si le local n'est pas disponible,
 * `disponible` reste `false` et l'appelant n'affiche pas de micro — plutôt
 * qu'une bascule silencieuse vers la reconnaissance serveur pendant qu'on
 * décrit le projet d'un client.
 *
 * L'API n'est pas Baseline (Firefox ne l'a pas) : tout est détecté à
 * l'exécution, rien n'est supposé.
 */

const LANGUE = 'fr-FR'
const CLE_MUET = 'silithid.voix.muet'

/** Ce que le SDK navigateur expose et que la lib DOM ne décrit pas encore. */
interface ReconnaissanceVocale extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  processLocally?: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

interface ConstructeurReconnaissance {
  new (): ReconnaissanceVocale
  available?: (o: { langs: string[]; processLocally?: boolean }) => Promise<string>
  install?: (o: { langs: string[]; processLocally?: boolean }) => Promise<boolean>
}

function constructeur(): ConstructeurReconnaissance | null {
  const w = window as unknown as {
    SpeechRecognition?: ConstructeurReconnaissance
    webkitSpeechRecognition?: ConstructeurReconnaissance
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface EtatVoix {
  /**
   * La reconnaissance LOCALE est-elle utilisable ?
   *
   * `null` tant qu'on interroge le navigateur. `false` couvre trois cas qui
   * mènent au même geste — ne pas afficher le micro : pas d'API du tout, pas
   * de mode local, ou pack de langue absent et non installable.
   */
  disponible: boolean | null
  /** Le pack de langue se télécharge. À dire, sinon le micro paraît muet. */
  installation: boolean
  ecoute: boolean
  muet: boolean
  /** La dernière panne de la voix elle-même, à afficher. */
  panne: string | null
  demarrerEcoute: () => void
  arreterEcoute: () => void
  basculerMuet: () => void
  /** Lit un texte. Sans effet si la voix est coupée. */
  dire: (texte: string) => void
  /** Coupe la lecture en cours. */
  taire: () => void
}

export function useVoix(onTexte: (texte: string) => void): EtatVoix {
  const [disponible, setDisponible] = useState<boolean | null>(null)
  const [installation, setInstallation] = useState(false)
  const [ecoute, setEcoute] = useState(false)
  const [panne, setPanne] = useState<string | null>(null)
  const [muet, setMuet] = useState(() => localStorage.getItem(CLE_MUET) === '1')

  const reco = useRef<ReconnaissanceVocale | null>(null)
  // Dans une ref : le gestionnaire `onresult` est installé une fois, et sans
  // ça il capturerait la première version de la fonction pour toujours.
  const onTexteRef = useRef(onTexte)
  onTexteRef.current = onTexte

  useEffect(() => {
    let vivant = true
    const C = constructeur()
    if (!C) {
      setDisponible(false)
      return
    }

    void (async () => {
      try {
        // `available` absent = navigateur qui a la reconnaissance mais pas le
        // mode local. On refuse : ce serait l'audio expédié à un serveur.
        if (!C.available) {
          if (vivant) setDisponible(false)
          return
        }
        const etat = await C.available({ langs: [LANGUE], processLocally: true })
        if (!vivant) return

        if (etat === 'available') {
          setDisponible(true)
          return
        }
        if (etat === 'downloadable' || etat === 'downloading') {
          // Le pack est un téléchargement géré par le système. On le dit au
          // lieu de laisser l'utilisateur devant un bouton qui ne répond pas.
          setInstallation(true)
          const pose = await C.install?.({ langs: [LANGUE], processLocally: true })
          if (!vivant) return
          setInstallation(false)
          setDisponible(Boolean(pose))
          return
        }
        setDisponible(false)
      } catch {
        if (vivant) setDisponible(false)
      }
    })()

    return () => {
      vivant = false
      reco.current?.abort()
      reco.current = null
    }
  }, [])

  const arreterEcoute = useCallback(() => {
    reco.current?.stop()
    setEcoute(false)
  }, [])

  const demarrerEcoute = useCallback(() => {
    const C = constructeur()
    if (!C) return
    setPanne(null)

    const r = new C()
    r.lang = LANGUE
    r.continuous = false
    r.interimResults = false
    // Réaffirmé sur l'instance : `available()` dit ce qui est possible, pas ce
    // que cette reconnaissance-ci fera.
    r.processLocally = true

    r.onresult = (e) => {
      const dit = Array.from({ length: e.results.length }, (_, i) => e.results[i]?.[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim()
      if (dit) onTexteRef.current(dit)
    }
    r.onerror = (e) => {
      // Dire la panne plutôt que retomber en silence : quand on travaille les
      // yeux ailleurs, un micro muet est indiscernable d'un micro qui écoute.
      setPanne(
        e.error === 'not-allowed'
          ? 'micro refusé · autorisez-le dans le navigateur'
          : `micro en échec · ${e.error}`,
      )
      setEcoute(false)
    }
    r.onend = () => setEcoute(false)

    reco.current = r
    try {
      r.start()
      setEcoute(true)
    } catch {
      setPanne('micro indisponible')
      setEcoute(false)
    }
  }, [])

  const taire = useCallback(() => window.speechSynthesis?.cancel(), [])

  const dire = useCallback(
    (texte: string) => {
      if (muet || !texte.trim() || !window.speechSynthesis) return
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(texte)
      u.lang = LANGUE
      const voix = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith('fr'))
      if (voix) u.voice = voix
      window.speechSynthesis.speak(u)
    },
    [muet],
  )

  const basculerMuet = useCallback(() => {
    setMuet((v) => {
      const suite = !v
      localStorage.setItem(CLE_MUET, suite ? '1' : '0')
      // Couper la voix doit couper la phrase en cours, pas la prochaine.
      if (suite) window.speechSynthesis?.cancel()
      return suite
    })
  }, [])

  return {
    disponible,
    installation,
    ecoute,
    muet,
    panne,
    demarrerEcoute,
    arreterEcoute,
    basculerMuet,
    dire,
    taire,
  }
}
