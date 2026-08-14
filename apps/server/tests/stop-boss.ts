import type { PgBoss } from 'pg-boss'

/**
 * Arrête pg-boss et ATTEND que ses workers soient drainés.
 *
 * `boss.stop()` rend la main immédiatement : en pg-boss 12, l'arrêt effectif
 * est signalé par l'évènement `stopped`, et `StopOptions` n'a pas d'option
 * d'attente. Sans ça, le worker d'un fichier de test survit à son `afterAll`,
 * consomme les jobs du fichier SUIVANT, et les fait échouer contre un schéma
 * `public` déjà détruit.
 *
 * Le symptôme est odieux : un run reste immobile en `framing`, sans erreur
 * visible côté test — quelqu'un d'autre a mangé son job. Diagnostiqué en
 * lisant `pgboss.job.output`, pas en relisant le code.
 */
export async function stopBoss(boss: PgBoss): Promise<void> {
  const stopped = new Promise<void>((resolve) => {
    boss.once('stopped', () => resolve())
  })
  await boss.stop({ graceful: true })
  await stopped
}
