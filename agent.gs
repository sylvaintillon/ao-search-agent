/**
 * =====================================================================
 *   AGENT DE RECHERCHE D'APPELS D'OFFRES
 *   Execution automatique : configurable via setupTrigger()
 *   Resultats enregistres dans Google Sheets
 *   Moteur : OpenAI gpt-4o-search-preview
 * =====================================================================
 *
 * INSTALLATION (a faire une seule fois)
 * --------------------------------------
 * 1. Ouvrez votre Google Sheet cible
 * 2. Extensions > Apps Script > collez ce fichier > Enregistrez
 * 3. Cliquez sur l'icone engrenage (Parametres du projet)
 *    Ajoutez ces proprietes de script :
 *      OPENAI_API_KEY      --> votre cle OpenAI (sk-...)
 *      SPREADSHEET_ID      --> l'ID de ce Google Sheet
 *      DISCORD_WEBHOOK_URL --> l'URL du webhook Discord (optionnel)
 * 4. Executez setupTrigger() une seule fois
 * 5. Autorisez les permissions demandees par Google
 *
 * FONCTIONS UTILES
 * ----------------
 *  runWeeklySearch()   --> lancer une recherche manuellement
 *  setupTrigger()      --> activer le declencheur (1 seule fois)
 *  deleteTrigger()     --> desactiver le declencheur
 *  testConfig()        --> verifier que les proprietes sont configurees
 *  clearSeenUrls()     --> vider la memoire des AOs deja detectes
 *
 * OBTENIR UN WEBHOOK DISCORD
 * ---------------------------
 * Dans Discord : Parametres du salon > Integrations > Webhooks
 * > Nouveau webhook > Copier l'URL du webhook
 */


// =====================================================================
// CONFIGURATION
// =====================================================================

var CONFIG = {
  MODEL:        'gpt-4o-search-preview',
  MAX_TOKENS:   8000,
  SHEET_NAME:   "Appels d'offres",
  EMAIL_NOTIF:  true,
  DISCORD_NOTIF: true,
  MAX_RETRIES:  3,
  // Domaines consideres comme agregateurs (URL de plateforme, pas d'AO direct)
  AGGREGATOR_DOMAINS: [
    'francemarches.com',
    'instao.fr',
    'marches-publics.gouv.fr',
    'boamp.fr',
    'ted.europa.eu',
    'appelaprojets.org',
    'e-marchespublics.com',
    'achatpublic.com',
    'place.gouv.fr',
    'marchesonline.com',
    'centraledesmarches.com'
  ]
};


function getOpenAiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) {
    throw new Error("Propriete OPENAI_API_KEY manquante.");
  }
  return key;
}

function getSpreadsheetId() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error("Propriete SPREADSHEET_ID manquante.");
  }
  return id;
}

function getDiscordWebhook() {
  return PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL') || '';
}


// =====================================================================
// MEMOIRE DES AOs DEJA DETECTES (deduplication)
// =====================================================================

function getSeenUrls() {
  var raw = PropertiesService.getScriptProperties().getProperty('SEEN_URLS');
  if (!raw) { return {}; }
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

function saveSeenUrls(seen) {
  // Garder seulement les 500 dernieres URLs pour ne pas saturer le stockage
  var keys = Object.keys(seen);
  if (keys.length > 500) {
    var sorted = keys.sort(function(a, b) { return seen[a] - seen[b]; });
    var toDelete = sorted.slice(0, keys.length - 500);
    for (var i = 0; i < toDelete.length; i++) {
      delete seen[toDelete[i]];
    }
  }
  PropertiesService.getScriptProperties().setProperty('SEEN_URLS', JSON.stringify(seen));
}

function filterNewRows(rows, urlColIndex) {
  if (urlColIndex < 0) { return rows; }
  var seen = getSeenUrls();
  var newRows = [];
  var now = Date.now();

  for (var i = 0; i < rows.length; i++) {
    var url = (rows[i][urlColIndex] || '').trim();
    if (url && !seen[url]) {
      newRows.push(rows[i]);
      seen[url] = now;
    } else if (url && seen[url]) {
      Logger.log('Doublon ignore : ' + url);
    }
  }

  saveSeenUrls(seen);
  Logger.log(newRows.length + ' nouveaux AOs (sur ' + rows.length + ' trouves).');
  return newRows;
}

// Vider la memoire si besoin (a appeler manuellement)
function clearSeenUrls() {
  PropertiesService.getScriptProperties().deleteProperty('SEEN_URLS');
  Logger.log('Memoire des AOs vide.');
}


// =====================================================================
// PROMPT PRINCIPAL
// Adaptez cette fonction a votre organisation :
//   - description : metiers, expertises, types de prestations
//   - domaines pertinents : mots-cles qui definissent vos marches cibles
//   - clients cibles : types d'acheteurs vises
//   - sources : plateformes a explorer
// =====================================================================

function buildPrompt() {
  var today = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy');
  var p = '';

  p += 'ATTENTION - DATE DU JOUR : ' + today + '\n';
  p += 'REGLE ABSOLUE N1 : exclure tout appel dont la date limite est anterieure au ' + today + '.\n';
  p += 'Exclure aussi tout appel marque clos, termine, expire. En cas de doute : exclure.\n\n';

  p += 'REGLE ABSOLUE N2 : ne jamais ecrire l\'URL d\'une plateforme agregateur comme URL';
  p += ' d\'un appel specifique. Les plateformes agregateurs referencent PLUSIEURS appels ;';
  p += ' tu DOIS visiter leur page de resultats et creer une ligne distincte pour chaque';
  p += ' appel individuel trouve.\n';
  p += 'Pour chaque source agregateur, visite la page de resultats et liste chaque AO';
  p += ' separe avec son URL unique de fiche detail.\n\n';

  p += 'Nous sommes le ' + today + '. Tu es charge d\'identifier des appels d\'offres publics,';
  p += ' marches, consultations et appels a projets pertinents pour notre organisation.\n\n';

  // ------------------------------------------------------------------
  // TODO : remplacez ce bloc par la description de votre organisation
  // ------------------------------------------------------------------
  p += '## Presentation de l\'organisation\n\n';
  p += 'Decrivez ici votre organisation : secteur d\'activite, expertises principales,';
  p += ' types de prestations, formats produits, types de clients habituels.\n\n';
  // ------------------------------------------------------------------

  p += '## Objectif\n\n';
  p += 'Identifier uniquement des opportunites reellement publiees, encore ouvertes,';
  p += ' accessibles a votre structure, coherentes avec vos expertises.\n\n';
  p += 'Exclure : marches hors sujet, appels clotures ou sans lien officiel verifiable.\n\n';

  // ------------------------------------------------------------------
  // TODO : adaptez les domaines pertinents a votre secteur
  // ------------------------------------------------------------------
  p += '## Domaines pertinents\n\n';
  p += 'Listez ici les mots-cles et domaines qui caracterisent vos marches cibles.\n\n';
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // TODO : adaptez les clients cibles
  // ------------------------------------------------------------------
  p += '## Clients cibles prioritaires\n\n';
  p += 'Listez ici les types d\'acheteurs publics ou prives vises.\n\n';
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // TODO : listez les sources a explorer
  // Exemples de plateformes marches publics :
  //   https://www.francemarches.com/
  //   https://www.instao.fr/appels-offres/
  //   https://www.boamp.fr/
  //   https://www.e-marchespublics.com/
  //   https://ted.europa.eu/
  // Exemples appels a projets :
  //   https://www.appelaprojets.org/
  //   ADEME, Banque des Territoires, fondations...
  // ------------------------------------------------------------------
  p += '## Sources a explorer\n\n';
  p += 'Listez ici les URLs des plateformes et sources a explorer.\n\n';
  // ------------------------------------------------------------------

  p += '## Methode d\'analyse\n\n';
  p += 'ETAPE 1 - Pour chaque source listee ci-dessus :\n';
  p += '  a) Visiter la page de resultats de la source\n';
  p += '  b) Lister TOUS les appels pertinents trouves\n';
  p += '  c) Pour chaque appel : visiter sa page de detail individuelle\n\n';
  p += 'ETAPE 2 - Pour chaque appel individuel :\n';
  p += '1. Verifier que la date limite n\'est pas depassee (date du jour : ' + today + ')\n';
  p += '2. Recuperer l\'URL directe de la fiche de l\'appel (PAS la page de recherche ou categorie)\n';
  p += '3. Lire la description reelle du besoin sur la page\n';
  p += '4. Chercher le budget ou montant estime\n';
  p += '5. Si aucune URL directe verifiable : EXCLURE\n';
  p += '6. Evaluer la pertinence : Tres pertinent / Pertinent / Hors cible\n';
  p += '7. Ne conserver que "Tres pertinent" et "Pertinent"\n\n';

  p += '## Format de sortie OBLIGATOIRE\n\n';
  p += 'Tableau Markdown avec exactement ces colonnes :\n';
  p += '| Score | Donneur d\'ordre | Intitule | Description | Date limite | Budget | URL |\n\n';
  p += 'Contraintes :\n';
  p += '- Description : 2 a 4 phrases issues de la lecture reelle de la page\n';
  p += '- URL : URL brute directe vers la fiche de l\'appel (https://...) SANS markdown\n';
  p += '- Une ligne = un appel. Ne jamais mettre l\'URL d\'une categorie ou d\'une page de liste\n';
  p += '- Budget : si absent ecrire "Non communique"\n';
  p += '- Date limite : format JJ/MM/AAAA uniquement (ex: 15/09/2026)\n';
  p += '- Ne jamais inventer une information\n\n';

  return p;
}


// =====================================================================
// FONCTION PRINCIPALE
// =====================================================================

function runWeeklySearch() {
  Logger.log('=== Demarrage de la recherche - ' + new Date() + ' ===');

  try {
    Logger.log('Appel API OpenAI...');
    var rawResponse = callOpenAiWithSearch(buildPrompt());

    if (!rawResponse || rawResponse.trim() === '') {
      throw new Error("Reponse vide de l'API.");
    }

    Logger.log('Reponse recue. Parsing...');
    var tableData = parseMarkdownTable(rawResponse);
    var synthesis = extractSynthesis(rawResponse);

    // Deduplication : retirer les AOs deja vus lors des recherches precedentes
    if (tableData && tableData.rows.length > 0) {
      var urlColIndex = -1;
      for (var u = 0; u < tableData.headers.length; u++) {
        if (tableData.headers[u].toLowerCase() === 'url') {
          urlColIndex = u;
          break;
        }
      }
      tableData.rows = filterNewRows(tableData.rows, urlColIndex);
    }

    if (tableData && tableData.rows.length > 0) {
      writeToSheet(tableData, synthesis);
      Logger.log(tableData.rows.length + " nouveau(x) AO(s) enregistre(s).");
    } else {
      writeEmptyResult(synthesis);
      Logger.log('Aucun nouvel AO cette semaine.');
    }

    if (CONFIG.EMAIL_NOTIF) {
      sendEmailSummary(tableData, synthesis);
    }
    if (CONFIG.DISCORD_NOTIF) {
      sendDiscordSummary(tableData, synthesis);
    }

    Logger.log('=== Recherche terminee avec succes ===');

  } catch (e) {
    Logger.log('ERREUR : ' + e.toString());
    notifyError(e);
  }
}


// =====================================================================
// APPEL API OPENAI
// =====================================================================

function callOpenAiWithSearch(prompt) {
  var attempts = 0;

  while (attempts < CONFIG.MAX_RETRIES) {
    attempts++;

    var payload = {
      model:      CONFIG.MODEL,
      max_tokens: CONFIG.MAX_TOKENS,
      messages: [
        { role: 'user', content: prompt }
      ]
    };

    var options = {
      method:             'post',
      contentType:        'application/json',
      headers: {
        'Authorization': 'Bearer ' + getOpenAiKey()
      },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var httpResponse = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
    var data = JSON.parse(httpResponse.getContentText());

    if (data.error) {
      if (attempts < CONFIG.MAX_RETRIES) {
        Logger.log('Erreur API (tentative ' + attempts + ') : ' + data.error.message + '. Nouvelle tentative...');
        Utilities.sleep(3000 * attempts);
        continue;
      }
      throw new Error('Erreur API OpenAI : ' + data.error.message);
    }

    return data.choices[0].message.content;
  }

  throw new Error('Nombre maximum de tentatives atteint.');
}


// =====================================================================
// PARSING DU TABLEAU MARKDOWN
// =====================================================================

function excelSerialToDate(serial) {
  var s = parseFloat(serial);
  if (isNaN(s) || s < 1000) { return serial; }
  var d = new Date(Math.round((s - 25569) * 86400000));
  var day   = ('0' + d.getUTCDate()).slice(-2);
  var month = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  var year  = d.getUTCFullYear();
  return day + '/' + month + '/' + year;
}

function isAggregatorUrl(url) {
  for (var i = 0; i < CONFIG.AGGREGATOR_DOMAINS.length; i++) {
    var domain = CONFIG.AGGREGATOR_DOMAINS[i];
    if (url.indexOf(domain) !== -1) {
      // Accepter si l'URL a un chemin specifique assez long (>15 chars apres le domaine)
      var afterDomain = url.replace(/https?:\/\/[^\/]+/, '');
      if (afterDomain.length < 15) {
        return true; // URL trop courte = page de categorie
      }
    }
  }
  return false;
}

function parseMarkdownTable(text) {
  var lines = text.split('\n');
  var tableLines = [];

  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.charAt(0) === '|' && trimmed.charAt(trimmed.length - 1) === '|') {
      tableLines.push(trimmed);
    }
  }

  if (tableLines.length < 3) {
    Logger.log('Aucun tableau Markdown detecte.');
    return null;
  }

  var separatorIndex = -1;
  for (var s = 0; s < tableLines.length; s++) {
    if (/^\|[\s\-:|]+\|$/.test(tableLines[s])) {
      separatorIndex = s;
      break;
    }
  }
  if (separatorIndex < 1) { return null; }

  var headers = tableLines[separatorIndex - 1]
    .split('|')
    .map(function(h) { return h.trim(); })
    .filter(function(h) { return h.length > 0; });

  var dateColIndex = -1;
  var urlColIndex  = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h].toLowerCase().indexOf('date') !== -1) { dateColIndex = h; }
    if (headers[h].toLowerCase() === 'url') { urlColIndex = h; }
  }

  var rows = [];
  for (var r = separatorIndex + 1; r < tableLines.length; r++) {
    var cells = tableLines[r]
      .split('|')
      .map(function(c) { return c.trim(); })
      .filter(function(c) { return c.length > 0; })
      .map(function(c, idx) {
        // Depouiller les liens markdown [texte](url)
        var mdLink = c.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
        if (mdLink) { return mdLink[1]; }
        // Convertir les serials Excel en date lisible
        if (idx === dateColIndex && /^\d{4,6}\.?\d*$/.test(c)) {
          return excelSerialToDate(c);
        }
        return c;
      });

    if (cells.length > 1) {
      // Exclure si URL manquante ou URL d'agregateur
      if (urlColIndex >= 0 && urlColIndex < cells.length) {
        var url = cells[urlColIndex] || '';
        if (!url || url === 'Information non trouvee') {
          Logger.log('Ligne exclue (pas d\'URL) : ' + (cells[2] || ''));
          continue;
        }
        if (isAggregatorUrl(url)) {
          Logger.log('Ligne exclue (URL agregateur) : ' + url);
          continue;
        }
      }
      rows.push(cells);
    }
  }

  Logger.log('Tableau parse : ' + headers.length + ' colonnes, ' + rows.length + ' lignes.');
  return { headers: headers, rows: rows };
}

function extractSynthesis(text) {
  var match = text.match(/##\s*Synth[eè]se([\s\S]*?)(?=##|$)/i);
  return match ? match[1].trim() : '';
}


// =====================================================================
// ECRITURE DANS GOOGLE SHEETS
// =====================================================================

function writeToSheet(tableData, synthesis) {
  var ss    = SpreadsheetApp.openById(getSpreadsheetId());
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(CONFIG.SHEET_NAME); }

  var dateStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy HH:mm');

  // Forcer le format texte pour eviter la conversion automatique des dates
  sheet.getRange(1, 1, sheet.getMaxRows(), 8).setNumberFormat('@STRING@');

  sheet.appendRow(['']);
  sheet.appendRow(['RECHERCHE DU ' + dateStr + ' - ' + tableData.rows.length + ' NOUVEAU(X) AO(S)']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 8)
    .merge()
    .setBackground('#1a73e8')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center');

  sheet.appendRow(tableData.headers);
  sheet.getRange(sheet.getLastRow(), 1, 1, tableData.headers.length)
    .setBackground('#e8f0fe')
    .setFontWeight('bold')
    .setBorder(true, true, true, true, null, null);

  for (var i = 0; i < tableData.rows.length; i++) {
    var row = tableData.rows[i];
    sheet.appendRow(row);

    var lastRow = sheet.getLastRow();
    var score   = (row[0] || '').toLowerCase();

    if (score.indexOf('tr') !== -1 && score.indexOf('pertinent') !== -1) {
      sheet.getRange(lastRow, 1, 1, row.length).setBackground('#e6f4ea');
    } else if (score.indexOf('pertinent') !== -1) {
      sheet.getRange(lastRow, 1, 1, row.length).setBackground('#fef9e7');
    }
  }

  if (synthesis) {
    sheet.appendRow(['']);
    sheet.appendRow(['SYNTHESE']);
    sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold').setFontSize(10);
    var synthLines = synthesis.split('\n');
    for (var k = 0; k < synthLines.length; k++) {
      var line = synthLines[k].trim();
      if (line.length > 0) {
        sheet.appendRow([line.replace(/^[*#\-]+\s*/, '')]);
      }
    }
  }

  sheet.autoResizeColumns(1, 8);
  Logger.log('Donnees ecrites dans "' + CONFIG.SHEET_NAME + '".');
}

function writeEmptyResult(synthesis) {
  var ss    = SpreadsheetApp.openById(getSpreadsheetId());
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(CONFIG.SHEET_NAME); }

  var dateStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy HH:mm');
  sheet.appendRow(['']);
  sheet.appendRow(['RECHERCHE DU ' + dateStr + ' - Aucun nouvel AO cette semaine']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 8)
    .merge()
    .setBackground('#f5f5f5')
    .setFontColor('#666666')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  if (synthesis) { sheet.appendRow([synthesis]); }
}


// =====================================================================
// NOTIFICATIONS EMAIL
// =====================================================================

function sendEmailSummary(tableData, synthesis) {
  try {
    var email   = Session.getActiveUser().getEmail();
    var dateStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy');
    var count   = tableData ? tableData.rows.length : 0;
    var subject = '[AO] ' + count + ' nouvel(aux) appel(s) - ' + dateStr;

    var body = 'Bonjour,\n\nRecherche du ' + dateStr + ' : ' + count + ' nouvel(aux) appel(s) d\'offres.\n\n';
    if (synthesis) { body += '--- SYNTHESE ---\n' + synthesis + '\n\n'; }
    body += 'Resultats : https://docs.google.com/spreadsheets/d/' + getSpreadsheetId() + '\n\nAgent automatique';

    MailApp.sendEmail(email, subject, body);
    Logger.log('Email envoye a ' + email);
  } catch (e) {
    Logger.log("Email impossible : " + e.toString());
  }
}


// =====================================================================
// NOTIFICATION DISCORD
// =====================================================================

function sendDiscordSummary(tableData, synthesis) {
  var webhookUrl = getDiscordWebhook();
  if (!webhookUrl) {
    Logger.log('Discord : DISCORD_WEBHOOK_URL non configure, notification ignoree.');
    return;
  }

  try {
    var dateStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy');
    var count   = tableData ? tableData.rows.length : 0;
    var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId();

    var msg = '**Recherche AO du ' + dateStr + '**\n';
    msg += count + ' nouvel(aux) appel(s) d\'offres detecte(s)\n\n';

    if (tableData && tableData.rows.length > 0) {
      var urlColIndex = -1;
      var titleColIndex = -1;
      var scoreColIndex = 0;
      for (var h = 0; h < tableData.headers.length; h++) {
        if (tableData.headers[h].toLowerCase() === 'url') { urlColIndex = h; }
        if (tableData.headers[h].toLowerCase().indexOf('intitul') !== -1) { titleColIndex = h; }
      }

      var trespertinents = [];
      var pertinents = [];
      for (var i = 0; i < tableData.rows.length; i++) {
        var row   = tableData.rows[i];
        var score = (row[scoreColIndex] || '').toLowerCase();
        var title = titleColIndex >= 0 ? (row[titleColIndex] || 'Sans titre') : 'Sans titre';
        var url   = urlColIndex   >= 0 ? (row[urlColIndex]   || '')           : '';
        var line  = '- ' + title + (url ? ' : ' + url : '');
        if (score.indexOf('tr') !== -1 && score.indexOf('pertinent') !== -1) {
          trespertinents.push(line);
        } else {
          pertinents.push(line);
        }
      }

      if (trespertinents.length > 0) {
        msg += ':star2: **Tres pertinents**\n' + trespertinents.join('\n') + '\n\n';
      }
      if (pertinents.length > 0) {
        msg += ':star: **Pertinents**\n' + pertinents.join('\n') + '\n\n';
      }
    }

    msg += ':bar_chart: Details complets : ' + sheetUrl;

    // Limiter a 2000 caracteres (limite Discord)
    if (msg.length > 1990) {
      msg = msg.substring(0, 1990) + '...';
    }

    var payload = JSON.stringify({ content: msg });
    var options = {
      method:             'post',
      contentType:        'application/json',
      payload:            payload,
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(webhookUrl, options);
    if (response.getResponseCode() === 204 || response.getResponseCode() === 200) {
      Logger.log('Notification Discord envoyee.');
    } else {
      Logger.log('Discord erreur HTTP ' + response.getResponseCode() + ' : ' + response.getContentText());
    }
  } catch (e) {
    Logger.log('Discord impossible : ' + e.toString());
  }
}


// =====================================================================
// NOTIFICATION ERREUR
// =====================================================================

function notifyError(error) {
  try {
    var email   = Session.getActiveUser().getEmail();
    var dateStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy HH:mm');
    MailApp.sendEmail(
      email,
      '[AO] ERREUR recherche ' + dateStr,
      'Erreur :\n\n' + error.toString() + '\n\nVerifiez les proprietes du script.'
    );
  } catch (e) {
    Logger.log("Email erreur impossible : " + e.toString());
  }

  var webhookUrl = getDiscordWebhook();
  if (webhookUrl) {
    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ content: ':x: **ERREUR** lors de la recherche AO :\n```' + error.toString().substring(0, 500) + '```' }),
        muteHttpExceptions: true
      });
    } catch(e2) {}
  }
}


// =====================================================================
// GESTION DU DECLENCHEUR
// =====================================================================

function setupTrigger() {
  // Supprimer les declencheurs existants pour eviter les doublons
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runWeeklySearch') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Adapter le jour et l'heure selon vos besoins
  ScriptApp.newTrigger('runWeeklySearch')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.THURSDAY)
    .atHour(9)
    .nearMinute(0)
    .create();
  Logger.log('Declencheur active : chaque jeudi entre 9h et 10h.');
}

function deleteTrigger() {
  var count = 0;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runWeeklySearch') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  Logger.log(count + ' declencheur(s) supprime(s).');
}

function testConfig() {
  Logger.log('=== Test de configuration ===');

  try {
    var key = getOpenAiKey();
    Logger.log('OPENAI_API_KEY : OK (' + key.substring(0, 7) + '...)');
  } catch (e) {
    Logger.log('OPENAI_API_KEY : MANQUANTE - ' + e.message);
  }

  try {
    var id = getSpreadsheetId();
    var ss = SpreadsheetApp.openById(id);
    Logger.log('SPREADSHEET_ID : OK (nom : "' + ss.getName() + '")');
  } catch (e) {
    Logger.log('SPREADSHEET_ID : ERREUR - ' + e.message);
  }

  var webhook = getDiscordWebhook();
  Logger.log('DISCORD_WEBHOOK_URL : ' + (webhook ? 'OK (' + webhook.substring(0, 40) + '...)' : 'NON CONFIGURE (optionnel)'));

  var seen = getSeenUrls();
  Logger.log('URLs en memoire (deduplication) : ' + Object.keys(seen).length);

  Logger.log('Email actif : ' + Session.getActiveUser().getEmail());
  Logger.log('Declencheurs existants : ' + ScriptApp.getProjectTriggers().length);
  Logger.log('=== Fin du test ===');
}
