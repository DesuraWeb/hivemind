# Les plans de développement

Sept documents, un par phase, écrits **avant** d'écrire le code de la phase.

## Pourquoi ils sont encore là

Ce ne sont pas des notes de travail qu'on aurait oublié de ranger : **77
commentaires du code y renvoient**, sous la forme « plan Phase 4, Task 6 » ou
« décision C du plan Phase 2 ». Les retirer laisserait 77 renvois pointant
dans le vide, et c'est précisément le genre de « pourquoi » que ce dépôt
s'astreint à conserver partout ailleurs.

Ils portent les arbitrages : ce qui a été écarté et pour quelle raison, les
contrats figés d'une phase sur l'autre, et les points que la phase suivante
devait vérifier plutôt que supposer.

## Ce qu'ils ne sont pas

**Ils ne décrivent pas l'état actuel du produit.** Un plan dit ce qu'on avait
l'intention de faire à une date ; le code dit ce qui a été fait. Quand les deux
divergent, c'est le code qui a raison, et le commentaire qui l'accompagne
explique en général pourquoi la divergence existe.

Pour l'état réel, dans l'ordre : le [README](../../README.md), l'inventaire
des [écarts](../ecarts.md), puis les commentaires du code.
