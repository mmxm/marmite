/**
 * ==========================================================================
 * MARMITE PROXY - SERVEUR DE CAPTURE DE RECETTES
 * Hébergé sur Google Apps Script (GAS)
 * ==========================================================================
 * 
 * DESCRIPTION :
 * Ce script sert de backend proxy ultra-léger pour l'application Marmite.
 * Il permet d'importer des recettes depuis n'importe quel site web en :
 * 1. Contournant les protections CORS et les blocages anti-bots grâce aux serveurs Google.
 * 2. Extraire les métadonnées de recette structurées (JSON-LD) directement en JS.
 * 3. Appeler l'IA Gemini (en fallback si aucune métadonnée n'est présente).
 * 4. Télécharger et encoder la photo de la recette en base64 pour contourner les échecs CORS d'images.
 * 
 * DIRECTIVES DE DÉPLOIEMENT :
 * 1. Ouvrez Google Drive (https://drive.google.com)
 * 2. Cliquez sur "Nouveau" > "Plus" > "Google Apps Script" (ou allez sur https://script.google.com).
 * 3. Videz l'éditeur de code par défaut et collez l'intégralité de ce fichier.
 * 4. (Optionnel pour l'IA) Dans l'éditeur Apps Script, allez dans les paramètres du projet (icône d'engrenage à gauche).
 *    Sous "Propriétés du script", ajoutez une propriété :
 *      - Nom : GEMINI_API_KEY
 *      - Valeur : Votre clé d'API Gemini (ex: AIzaSy...)
 * 5. Cliquez sur "Déployer" en haut à droite > "Nouveau déploiement".
 * 6. Sélectionnez le type "Application Web" :
 *    - Description : Marmite Recipe Proxy
 *    - Exécuter en tant que : "Moi (votre-adresse-email)"
 *    - Qui a accès : "Tout le monde" (c'est nécessaire pour que la PWA puisse l'interroger).
 * 7. Cliquez sur "Déployer". Autorisez les accès si nécessaire.
 * 8. Copiez l'URL de l'application web générée (elle se termine par "/exec").
 * 9. Collez cette URL dans les "Paramètres" de votre application PWA Marmite.
 */

function doGet(e) {
  var url = e.parameter.url;
  if (!url) {
    return createJsonResponse({ success: false, error: "Paramètre 'url' manquant" });
  }

  // Clé Gemini transmise en paramètre ou récupérée dans les propriétés du script
  var geminiApiKey = e.parameter.geminiApiKey || PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || "";

  try {
    // 1. Fetch de la page HTML
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    var responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      return createJsonResponse({ success: false, error: "Impossible d'accéder au site. Code HTTP: " + responseCode });
    }

    var html = response.getContentText("UTF-8");
    
    // 2. Extraction locale via JSON-LD
    var recipe = parseRecipeSchema(html);
    var source = "schema";

    // 3. Fallback sur l'IA Gemini si aucun JSON-LD valide n'a été trouvé
    if (!recipe) {
      if (!geminiApiKey) {
        return createJsonResponse({
          success: false,
          error: "Aucune métadonnée structurée trouvée sur ce site. Veuillez configurer une clé d'API Gemini (dans l'Apps Script ou dans la PWA) pour activer l'analyse par IA."
        });
      }
      
      var cleanedText = cleanHtmlForAi(html);
      recipe = callGeminiApi(cleanedText, geminiApiKey);
      source = "gemini";
    }

    if (!recipe) {
      return createJsonResponse({ success: false, error: "Échec de l'extraction de la recette." });
    }

    // 4. Téléchargement et encodage en base64 de l'image de couverture si présente
    var imageBase64 = null;
    if (recipe.imageUrl) {
      imageBase64 = fetchImageAsBase64(recipe.imageUrl);
    }

    return createJsonResponse({
      success: true,
      source: source,
      recipe: recipe,
      imageBase64: imageBase64
    });

  } catch (err) {
    return createJsonResponse({ success: false, error: err.toString() });
  }
}

/**
 * Retourne une réponse JSON compatible avec CORS
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Recherche et extrait le schéma Recipe à partir du JSON-LD de l'HTML (via regex)
 */
function parseRecipeSchema(html) {
  var scripts = [];
  var regex = /<script[^>]*type\s*=\s*["']?application(?:&#x2F;|\/)ld(?:&#x2B;|\+)json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    scripts.push(match[1]);
  }

  var recipeSchema = null;

  for (var i = 0; i < scripts.length; i++) {
    try {
      var data = JSON.parse(scripts[i]);
      
      var searchForRecipe = function(obj) {
        if (!obj) return null;
        if (obj['@type'] === 'Recipe' || (Array.isArray(obj['@type']) && obj['@type'].indexOf('Recipe') !== -1)) {
          return obj;
        }
        if (Array.isArray(obj)) {
          for (var j = 0; j < obj.length; j++) {
            var r = searchForRecipe(obj[j]);
            if (r) return r;
          }
        }
        if (obj['@graph'] && Array.isArray(obj['@graph'])) {
          for (var k = 0; k < obj['@graph'].length; k++) {
            var r2 = searchForRecipe(obj['@graph'][k]);
            if (r2) return r2;
          }
        }
        return null;
      };

      recipeSchema = searchForRecipe(data);
      if (recipeSchema) break;
    } catch (e) {
      // Ignorer les erreurs de JSON individuelles
    }
  }

  if (!recipeSchema) return null;

  // Extraction et nettoyage des champs standardisés
  var title = recipeSchema.name || "";
  var description = recipeSchema.description || "";

  var parseISO8601Duration = function(durationStr) {
    if (!durationStr) return 0;
    var match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!match) return 0;
    var hours = parseInt(match[1] || 0, 10);
    var minutes = parseInt(match[2] || 0, 10);
    return hours * 60 + minutes;
  };

  var prepTime = parseISO8601Duration(recipeSchema.prepTime);
  var cookTime = parseISO8601Duration(recipeSchema.cookTime);

  var servings = 4;
  if (recipeSchema.recipeYield) {
    var yieldStr = String(recipeSchema.recipeYield);
    var numMatch = yieldStr.match(/\d+/);
    if (numMatch) servings = parseInt(numMatch[0], 10);
  }

  var category = "Plat";
  if (recipeSchema.recipeCategory) {
    var catStr = Array.isArray(recipeSchema.recipeCategory) 
      ? recipeSchema.recipeCategory[0] 
      : recipeSchema.recipeCategory;
    catStr = String(catStr).toLowerCase();
    if (catStr.indexOf('entr') !== -1) category = "Entrée";
    else if (catStr.indexOf('dessert') !== -1) category = "Dessert";
    else if (catStr.indexOf('boiss') !== -1) category = "Boisson";
    else if (catStr.indexOf('apér') !== -1) category = "Apéritif";
    else category = "Plat";
  }

  var tags = [];
  if (recipeSchema.keywords) {
    var kw = recipeSchema.keywords;
    if (typeof kw === 'string') {
      tags = kw.split(',').map(function(s) { return s.trim(); });
    } else if (Array.isArray(kw)) {
      tags = kw.map(function(s) { return String(s).trim(); });
    }
  }

  // Parse les textes d'ingrédients bruts en structure { quantity, unit, name }
  var rawIngredients = recipeSchema.recipeIngredient || [];
  var ingredients = rawIngredients.map(function(ingText) {
    return parseIngredientText(ingText);
  });

  var steps = [];
  if (recipeSchema.recipeInstructions) {
    var inst = recipeSchema.recipeInstructions;
    if (Array.isArray(inst)) {
      var flatSteps = [];
      for (var s = 0; s < inst.length; s++) {
        var stepObj = inst[s];
        if (typeof stepObj === 'string') {
          flatSteps.push(stepObj);
        } else if (stepObj.text) {
          flatSteps.push(stepObj.text);
        } else if (stepObj.itemListElement && Array.isArray(stepObj.itemListElement)) {
          for (var el = 0; el < stepObj.itemListElement.length; el++) {
            if (stepObj.itemListElement[el].text) {
              flatSteps.push(stepObj.itemListElement[el].text);
            }
          }
        }
      }
      steps = flatSteps;
    } else if (typeof inst === 'string') {
      steps = inst.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    }
  }

  var imageUrl = "";
  if (recipeSchema.image) {
    if (typeof recipeSchema.image === 'string') {
      imageUrl = recipeSchema.image;
    } else if (Array.isArray(recipeSchema.image)) {
      imageUrl = recipeSchema.image[0];
    } else if (recipeSchema.image.url) {
      imageUrl = recipeSchema.image.url;
    }
  }

  return {
    title: title,
    description: description,
    prepTime: prepTime,
    cookTime: cookTime,
    servings: servings,
    category: category,
    tags: tags,
    ingredients: ingredients,
    steps: steps,
    imageUrl: imageUrl
  };
}

/**
 * Nettoie le code HTML en extrayant uniquement le texte utile (sans scripts, styles, etc.) pour l'IA Gemini
 */
function cleanHtmlForAi(html) {
  var text = html;
  
  // Suppression des balises superflues
  var tagsToRemove = ['script', 'style', 'noscript', 'iframe', 'header', 'footer', 'nav', 'form', 'aside', 'svg'];
  for (var i = 0; i < tagsToRemove.length; i++) {
    var tag = tagsToRemove[i];
    var regex = new RegExp('<' + tag + '[\\s\\S]*?<\\/' + tag + '>', 'gi');
    text = text.replace(regex, ' ');
  }
  
  // Suppression de toutes les balises HTML restantes
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Décodage des entités HTML courantes
  text = decodeHtmlEntities(text);
  
  // Condensation des espaces
  text = text.replace(/\s+/g, ' ').trim();
  
  if (text.length > 20000) {
    text = text.substring(0, 20000);
  }
  return text;
}

function decodeHtmlEntities(text) {
  var translate_re = /&(nbsp|amp|quot|lt|gt);/g;
  var translate = {
    "nbsp": " ",
    "amp" : "&",
    "quot": "\"",
    "lt"  : "<",
    "gt"  : ">"
  };
  return text.replace(translate_re, function(match, entity) {
    return translate[entity];
  }).replace(/&#(\d+);/gi, function(match, numStr) {
    var num = parseInt(numStr, 10);
    return String.fromCharCode(num);
  });
}

/**
 * Interroge l'API Gemini Flash 2.5 pour structurer la recette
 */
function callGeminiApi(cleanedText, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  
  var prompt = "Tu es un assistant de cuisine expert. Analyse le texte brut suivant extrait d'un site internet de cuisine, et structure la recette sous forme de JSON correspondant à ce schéma précis :\n" +
               "{\n" +
               "  \"title\": \"Titre court\",\n" +
               "  \"description\": \"Explication courte\",\n" +
               "  \"prepTime\": 15,\n" +
               "  \"cookTime\": 30,\n" +
               "  \"servings\": 4,\n" +
               "  \"category\": \"Entrée|Plat|Dessert|Apéritif|Boisson|Autre\",\n" +
               "  \"tags\": [\"tag1\", \"tag2\"],\n" +
               "  \"ingredients\": [{\"name\": \"Nom ingrédient\", \"quantity\": 1.5, \"unit\": \"g|kg|l|cl|ml|cuillère à soupe|sachet|unité|pincée\"}],\n" +
               "  \"steps\": [\"Étape 1...\", \"Étape 2...\"]\n" +
               "}\n" +
               "Réponds uniquement avec le JSON. Voici le texte brut : \n\n" + cleanedText;

  var payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();
  
  if (responseCode !== 200) {
    throw new Error('Erreur API Gemini: ' + responseCode + ' - ' + responseText);
  }

  var data = JSON.parse(responseText);
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('Gemini n\'a renvoyé aucun candidat de réponse.');
  }

  var rawText = data.candidates[0].content.parts[0].text;
  return cleanGeminiJson(rawText);
}

function cleanGeminiJson(text) {
  var clean = text.trim();
  if (clean.indexOf('```') !== -1) {
    var match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match && match[1]) {
      clean = match[1];
    }
  }
  return JSON.parse(clean.trim());
}

/**
 * Télécharge une image distante et la convertit en base64 pour bypasser CORS côté client
 */
function fetchImageAsBase64(imageUrl) {
  try {
    var response = UrlFetchApp.fetch(imageUrl, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (response.getResponseCode() === 200) {
      var contentType = response.getHeaders()["Content-Type"] || "image/jpeg";
      var bytes = response.getContent();
      return "data:" + contentType + ";base64," + Utilities.base64Encode(bytes);
    }
  } catch (e) {
    // Ignorer les erreurs d'image pour ne pas bloquer l'importation de la recette
  }
  return null;
}

/**
 * Analyseur syntaxique d'ingrédients (identique à celui de app.js)
 */
function parseIngredientText(text) {
  text = text.trim();
  var quantity = null;
  var unit = '';
  var name = '';
  
  // 1. Détection d'un nombre (décimal ou fraction) au début
  var numRegex = /^(\d+[\/\.]\d+|\d+)\s*/;
  var match = text.match(numRegex);
  if (match) {
    var qtyStr = match[1];
    if (qtyStr.indexOf('/') !== -1) {
      var parts = qtyStr.split('/');
      quantity = parseFloat(parts[0]) / parseFloat(parts[1]);
    } else {
      quantity = parseFloat(qtyStr);
    }
    text = text.substring(match[0].length).trim();
  }
  
  // 2. Détection des unités courantes de mesure
  var units = [
    'g', 'kg', 'ml', 'cl', 'l', 'dl', 'g.', 'kg.', 'ml.', 'cl.', 'l.',
    'cuillère à soupe', 'cuillères à soupe', 'c. à soupe', 'c. à s.', 'c.a.s.', 'cas',
    'cuillère à café', 'cuillères à café', 'c. à café', 'c. à c.', 'c.a.c.', 'cac',
    'sachet', 'sachets', 'pincée', 'pincées', 'gousse', 'gousses', 'tranche', 'tranches',
    'tasse', 'tasses', 'verre', 'verres', 'pot', 'pots', 'boite', 'boites', 'boîte', 'boîtes',
    'feuille', 'feuilles', 'brin', 'brins', 'filet', 'filets', 'morceau', 'morceaux',
    'brique', 'briques', 'goutte', 'gouttes'
  ];
  
  units.sort(function(a, b) { return b.length - a.length; });
  
  var foundUnit = false;
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    var unitRegex = new RegExp('^(' + u + ')\\b\\s*(?:de\\s+|d\'\\s*)?', 'i');
    var unitMatch = text.match(unitRegex);
    if (unitMatch) {
      unit = unitMatch[1];
      text = text.substring(unitMatch[0].length).trim();
      foundUnit = true;
      break;
    }
  }
  
  if (!foundUnit) {
    var deMatch = text.match(/^(?:de\s+|d'\s*)/i);
    if (deMatch) {
      text = text.substring(deMatch[0].length).trim();
    }
  }
  
  name = text;
  
  return {
    quantity: quantity,
    unit: unit,
    name: name
  };
}
