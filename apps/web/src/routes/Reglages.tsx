import { SectionHeader } from '../components/SectionHeader'
import { AuthDiagnostic } from '../components/reglages/AuthDiagnostic'
import { BudgetSection } from '../components/reglages/BudgetSection'
import { Note, Panel, StatusLine } from '../components/reglages/Panel'
import { RoleTemplates } from '../components/reglages/RoleTemplates'
import { ThresholdsForm } from '../components/reglages/ThresholdsForm'
import { VaultInventory } from '../components/reglages/VaultInventory'

/**
 * Écran Réglages (`docs/design/Reglages.dc.html`) : diagnostic mono sans
 * cadres (CLAUDE.md), et le coffre en inventaire.
 *
 * L'écran n'affiche que ce que le serveur sait, et n'offre que ce qu'il sait
 * faire. Ce qui a disparu du pack, et pourquoi :
 *
 * - **« tous systèmes opérationnels »** en haut à droite : personne ne mesure
 *   ça en continu. Le diagnostic d'authentification est un geste, pas un état,
 *   et il porte lui-même son résultat ;
 * - **« Connexions » (Gmail, GitHub)** : aucune route ne dit si une
 *   intégration est connectée. Une pastille verte tirée de la présence d'un
 *   secret dans le coffre affirmerait un état qu'on ne vérifie pas ; le bloc
 *   est absent, et l'inventaire du coffre dit ce qui est réellement déposé ;
 * - **les plafonds en tokens et les cases à cocher d'alertes** : voir
 *   `BudgetSection` et le bloc « Alertes » ci-dessous.
 *
 * Ce qui reste modifiable l'est vraiment : `ThresholdsForm` écrit par
 * `PUT /api/settings`, la seule route d'écriture de cet écran.
 */
export function Reglages() {
  // L'hôte réel de l'instance, pas une adresse recopiée du pack : cette
  // application est self-hostée, l'écran doit dire OÙ il tourne.
  const host = typeof window === 'undefined' ? null : window.location.host

  return (
    <>
      <SectionHeader
        label="Réglages"
        meta={host ? `instance self-hostée · ${host}` : 'instance self-hostée'}
      />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '18px 20px 116px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 860 }}>
          <AuthDiagnostic />
          <BudgetSection />
          <ThresholdsForm />

          <Panel label="Alertes">
            {/* Les deux seules alertes que le serveur lève réellement
                aujourd'hui. Le pack propose quatre cases à cocher (budget
                > 85 %, boucle en échec, auth expirée, item inbox > 24 h) et un
                champ « email d'alertes » : aucun de ces réglages n'existe, les
                déclencheurs sont écrits en dur. Des cases décoratives se
                cocheraient sans rien changer. */}
            <StatusLine color="var(--sem-alert)">
              authentification agent injoignable · item d&rsquo;inbox « alerte » + email immédiat,
              sans doublon tant que l&rsquo;alerte reste ouverte
            </StatusLine>
            <StatusLine color="var(--sem-question)">
              jauge de budget muette alors qu&rsquo;une boucle tourne · item d&rsquo;inbox seul, pas
              d&rsquo;email : rien n&rsquo;est cassé, mais plus rien ne protège la réserve
            </StatusLine>
            <Note>
              ces deux déclencheurs sont écrits dans le serveur · il n&rsquo;y a ni seuil ni case à
              cocher à régler ici, et une case sans effet ne vaut pas mieux qu&rsquo;une absence
            </Note>
            <Note>
              le destinataire des emails vient de la configuration du serveur (`ALERT_EMAIL_TO`) ·
              l&rsquo;API ne le rend pas : cet écran ne peut ni l&rsquo;afficher ni le changer
            </Note>
          </Panel>

          <RoleTemplates />
          <VaultInventory />
        </div>
      </main>
    </>
  )
}
