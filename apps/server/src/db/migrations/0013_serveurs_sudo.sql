-- Le compte de l'agent d'exploitation a-t-il besoin de `sudo` ?
--
-- Le catalogue rendait ses commandes sans élévation. Sur une machine réelle le
-- compte de l'agent n'est pas root — et ne doit pas l'être : tout le travail de
-- bornage du catalogue perdrait son sens si l'exécutant avait tous les droits.
-- `apt-get install` et `systemctl reload` échouaient donc systématiquement,
-- alors qu'un sudoers borné existait pour eux sur le serveur.
--
-- `true` par défaut, et c'est le bon défaut : un compte non privilégié est la
-- norme, et `sudo` sur un compte qui est déjà root ne coûte rien. L'inverse
-- aurait fait échouer chaque première intervention sur chaque serveur.
alter table serveurs
  add column sudo boolean not null default true;
