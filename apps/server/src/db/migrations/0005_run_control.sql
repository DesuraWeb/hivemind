-- Contrôle de run : pause manuelle et arrêt humain.
--
-- Deux états s'ajoutent à `runs.state`, et la contrainte `check` posée en
-- 0001 doit suivre — sans ça, `applyEvent` écrirait un état que Postgres
-- refuse, et la transition échouerait en base après avoir été jugée valide
-- par la machine à états.
--
-- `paused_human` plutôt qu'une réutilisation de `paused_budget` : le
-- scheduler de budget (`budget/scheduler.ts`) reprend TOUS les runs en
-- `paused_budget` dès que la jauge repasse sous le seuil de reprise, ce qui
-- est le cas nominal. Une pause manuelle rangée là serait levée toute seule
-- au tick suivant, cinq minutes plus tard au plus.
--
-- `stopped` plutôt que `failed` : un arrêt décidé par un humain n'est pas un
-- échec. Les confondre afficherait « échec » dans la liste des projets pour
-- une décision volontaire.
alter table runs drop constraint runs_state_check;

alter table runs add constraint runs_state_check check (state in
  ('framing','coding','design_wait','reviewing','deploying','judging','verdict',
   'awaiting_human','done','failed','paused_budget','paused_human','stopped'));
