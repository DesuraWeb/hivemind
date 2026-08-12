import { createTransport } from 'nodemailer'
import type { Env } from '../env'

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
  /** Emails capturés en mode dry-run — pour les tests et l'inspection en dev. */
  readonly sent: readonly Mail[]
}

/**
 * En MAIL_DRY_RUN=1 (défaut en dev), rien ne part : l'email est loggé et gardé
 * en mémoire. C'est la garantie qu'aucun mail réel ne fuit pendant le sprint.
 */
export function createMailer(env: Env): Mailer {
  const sent: Mail[] = []

  if (env.MAIL_DRY_RUN === 1) {
    return {
      sent,
      async send(mail) {
        sent.push(mail)
        console.log(`[MAIL_DRY_RUN] à=${mail.to} objet="${mail.subject}"\n${mail.text}`)
      },
    }
  }

  if (!env.SMTP_HOST) throw new Error('SMTP_HOST requis quand MAIL_DRY_RUN=0')

  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  })

  return {
    sent,
    async send(mail) {
      await transport.sendMail({ from: env.ALERT_EMAIL_FROM, ...mail })
    },
  }
}
