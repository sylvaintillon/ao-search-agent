# Agent de recherche d'appels d'offres

Agent Google Apps Script qui recherche automatiquement des appels d'offres publics chaque semaine via OpenAI `gpt-4o-search-preview`, et enregistre les résultats dans Google Sheets avec notifications email et Discord.

## Comment ça marche

1. **Le prompt** décrit votre organisation, ses expertises et les types d'appels recherchés
2. **OpenAI** navigue le web en temps réel et retourne un tableau Markdown structuré
3. **Le script** parse la réponse, déduplique les résultats (mémoire persistante), et les écrit dans Google Sheets
4. **Les notifications** email et Discord résument les nouveaux appels trouvés

## Installation

1. Ouvrez votre Google Sheet cible
2. **Extensions > Apps Script** → collez le contenu de `agent.gs` → Enregistrez
3. Cliquez sur l'icône engrenage (**Paramètres du projet**) et ajoutez ces propriétés de script :

| Propriété | Description |
|-----------|-------------|
| `OPENAI_API_KEY` | Votre clé OpenAI (`sk-...`) |
| `SPREADSHEET_ID` | L'ID de votre Google Sheet |
| `DISCORD_WEBHOOK_URL` | URL webhook Discord *(optionnel)* |

4. Exécutez `setupTrigger()` **une seule fois** pour activer le déclencheur automatique
5. Autorisez les permissions demandées par Google

### Obtenir un webhook Discord

Dans Discord : **Paramètres du salon > Intégrations > Webhooks > Nouveau webhook > Copier l'URL**

## Configuration du prompt

Adaptez la fonction `buildPrompt()` dans `agent.gs` :

- **Description de votre organisation** : métiers, expertises, types de prestations
- **Domaines pertinents** : mots-clés qui définissent vos marchés cibles
- **Clients cibles** : types d'acheteurs publics ou privés visés
- **Sources** : plateformes de marchés publics et appels à projets à explorer

Le prompt inclut automatiquement la date du jour pour exclure les appels expirés.

## Fonctions disponibles

| Fonction | Description |
|----------|-------------|
| `runWeeklySearch()` | Lancer une recherche manuellement |
| `setupTrigger()` | Activer le déclencheur automatique (1 seule fois) |
| `deleteTrigger()` | Désactiver le déclencheur |
| `testConfig()` | Vérifier que les propriétés sont configurées |
| `clearSeenUrls()` | Vider la mémoire de déduplication |

## Format de sortie

Le script attend un tableau Markdown avec ces colonnes :

```
| Score | Donneur d'ordre | Intitulé | Description | Date limite | Budget | URL |
```

Les lignes sont colorées selon le score (`Très pertinent` → vert, `Pertinent` → jaune).

## Déduplication

Les URLs déjà enregistrées lors des recherches précédentes sont mémorisées dans les propriétés du script (max 500 URLs). Un appel déjà enregistré ne sera jamais ajouté deux fois.

## Prérequis

- Compte Google (Google Sheets + Apps Script)
- Clé API OpenAI avec accès au modèle `gpt-4o-search-preview`
- *(Optionnel)* Webhook Discord
