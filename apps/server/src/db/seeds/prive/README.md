# Recouvrement privé

Ce dossier est **ignoré par git**, sauf ce fichier. Il porte le savoir propre à
votre agence : ce qu'un agent doit savoir sans qu'on le lui répète.

Rien n'est obligatoire. Sans ces fichiers, le défaut générique de
`../baseline.ts` s'applique et l'installation fonctionne.

## `answer-baseline.md`

Vos règles non dites, en markdown. Ce que « fini » veut dire chez vous, ce
qu'on ne fait jamais sans demander, ce que « proprement » signifie, votre
contexte réglementaire. Injecté par Hive dans la « réponse optimisée » d'un
item d'inbox — jamais dans votre réponse brute.

## `stack-rules.json`

Un objet `{ "stack": "règles" }`. Les clés sont comparées en minuscules, par
inclusion : `"laravel"` s'applique à un projet dont la stack vaut
« Laravel 12 ». Injectées **uniquement** quand la stack correspond — sinon les
règles PrestaShop traîneraient sur un projet WordPress, du bruit et des tokens
dépensés pour rien.

```json
{
  "wordpress": "- Thème enfant obligatoire.\n- Aucun plugin sans accord."
}
```

## Écrire une règle qu'on sait incomplète

Commencez la ligne par `RÈGLE MANQUANTE : `. Hive dira qu'il ne sait pas au
lieu d'inventer une contrainte — c'est le comportement voulu, pas une panne.

## Ces fichiers ne sont pas des secrets

Pas de chiffrement, pas de rotation : c'est du savoir métier, qui se lit et
s'édite comme un fichier texte. Les vrais secrets vivent dans le coffre
(`settings`, scellés par libsodium) et ne transitent jamais par ici.
