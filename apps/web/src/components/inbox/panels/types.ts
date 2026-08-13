import type { InboxItemView, InboxResponsePayload } from '../../../lib/inbox-types'

/** Props communes aux 5 panneaux typés + au panneau générique et à l'affordance savoir. */
export interface PanelProps {
  item: InboxItemView
  projectName: string
  resolving: boolean
  onResolve: (response: InboxResponsePayload) => void
  /** Referme le panneau sans résoudre l'item (ex. « Reporter », « Corriger à la main »). */
  onClose: () => void
}
